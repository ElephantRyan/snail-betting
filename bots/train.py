"""A population of PPO bots that play competitive snail racing against each other.

    go build -o bots/arena.exe .
    python bots/train.py --players 8  --name eight
    python bots/train.py --players 16 --name sixteen      # also learns to bet on the heats it sits out

Every bot is its own small network. Each game seats a random draw from the population (learners plus
a few scripted "anchor" bots that never learn, so progress can be measured against fixed opponents).
The reward is the final placement scaled from 1.0 (champion) down to 0.0 (first one out).
The game itself runs in Go (arena.go) with the real server rules; this file only decides.
"""

import argparse
import json
import os
import random
import subprocess
import sys
import time

import numpy as np
import torch
import torch.nn as nn
from torch.distributions import Categorical

OBS, ACT = 120, 39
DONE, BET_BASE = 6, 7
ITEMS = ["speed", "determ", "boost", "shell", "salt", "food"]
FRACS = [0.1, 0.25, 0.5, 1.0]


# ---- learners --------------------------------------------------------------------------------


class Net(nn.Module):
    def __init__(self, hidden=256):
        super().__init__()
        self.body = nn.Sequential(nn.Linear(OBS, hidden), nn.Tanh(), nn.Linear(hidden, hidden), nn.Tanh())
        self.pi = nn.Linear(hidden, ACT)
        self.v = nn.Linear(hidden, 1)

    def forward(self, x, mask):
        z = self.body(x)
        return self.pi(z).masked_fill(~mask, -1e9), self.v(z).squeeze(-1)


class Learner:
    learns = True

    def __init__(self, name, lr, args):
        self.name, self.args = name, args
        self.net = Net()
        self.opt = torch.optim.Adam(self.net.parameters(), lr=lr)
        self.buf = {k: [] for k in ("obs", "mask", "act", "logp", "val", "ret")}
        self.steps = 0

    @torch.no_grad()
    def act(self, obs, mask):
        logits, val = self.net(torch.from_numpy(obs), torch.from_numpy(mask))
        dist = Categorical(logits=logits)
        a = dist.sample()
        return a.numpy(), dist.log_prob(a).numpy(), val.numpy()

    def add(self, steps, reward):
        obs, mask, act, logp, val = (np.array(x) for x in steps)
        for k, v in (("obs", obs), ("mask", mask), ("act", act), ("logp", logp), ("val", val), ("ret", np.full(len(act), reward, np.float32))):
            self.buf[k].append(v)
        self.steps += len(act)

    def ready(self):
        return self.steps >= self.args.batch

    def update(self):
        b = {k: torch.from_numpy(np.concatenate(v)) for k, v in self.buf.items()}
        for v in self.buf.values():
            v.clear()
        self.steps = 0
        adv = b["ret"] - b["val"]  # the reward arrives once, at the end, and gamma is 1
        adv = (adv - adv.mean()) / (adv.std() + 1e-8)
        n = len(adv)
        for _ in range(self.args.epochs):
            perm = torch.randperm(n)
            for i in range(0, n, self.args.minibatch):
                ix = perm[i : i + self.args.minibatch]
                logits, val = self.net(b["obs"][ix], b["mask"][ix])
                dist = Categorical(logits=logits)
                ratio = torch.exp(dist.log_prob(b["act"][ix]) - b["logp"][ix])
                pg = -torch.min(ratio * adv[ix], torch.clamp(ratio, 0.8, 1.2) * adv[ix]).mean()
                loss = pg + 0.5 * ((val - b["ret"][ix]) ** 2).mean() - self.args.entropy * dist.entropy().mean()
                self.opt.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(self.net.parameters(), 0.5)
                self.opt.step()


# ---- scripted anchors --------------------------------------------------------------------------

LANE_WEIGHT = np.array([1.0, 1.0, 0.6, 0.3, 0.3, 0.3])


def lane_strengths(obs):
    out = []
    for lane in range(8):
        base = 35 + lane * 9
        out.append(float(obs[base + 3 : base + 9] @ LANE_WEIGHT) if obs[base] else None)
    return out


class Scripted:
    learns = False

    def __init__(self, name, shop, bet):
        self.name, self.shop, self.bet = name, shop, bet

    def pick(self, obs, mask):
        legal = np.flatnonzero(mask)
        if obs[2]:  # betting
            lanes = lane_strengths(obs)
            live = [i for i, s in enumerate(lanes) if s is not None]
            if self.bet == "skip" or not live:
                return DONE
            if self.bet == "random":
                return int(random.choice(legal))
            lane = max(live, key=lambda i: lanes[i]) if self.bet == "favorite" else min(live, key=lambda i: lanes[i])
            return BET_BASE + lane * 4 + 1  # a quarter of the limit
        buys = [a for a in legal if a < 6]
        if self.shop == "random":
            return int(random.choice(legal))
        if not buys:
            return DONE
        if self.shop == "spread":
            return int(min(buys, key=lambda a: (obs[9 + a], a)))
        order = {"speed": [0, 1, 2, 3, 4, 5], "boostatk": [2, 4, 5, 0, 1, 3]}[self.shop]
        return next(a for a in order if a in buys)

    def act(self, obs, mask):
        acts = np.array([self.pick(o, m) for o, m in zip(obs, mask)])
        return acts, np.zeros(len(acts), np.float32), np.zeros(len(acts), np.float32)


ANCHORS = [
    ("speed+skip", "speed", "skip"),
    ("boostatk+favorite", "boostatk", "favorite"),
    ("spread+longshot", "spread", "longshot"),
    ("random+random", "random", "random"),
]


# ---- arena bridge --------------------------------------------------------------------------------


class Arena:
    def __init__(self, exe, players, games, rounds, blind=False):
        self.proc = subprocess.Popen(
            [exe, "-arena", "-players", str(players), "-games", str(games), "-rounds", str(rounds)] + (["-blind"] if blind else []),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=1 << 22,
        )

    def read(self):
        line = self.proc.stdout.readline()
        if not line:
            raise SystemExit("arena exited")
        m = json.loads(line)
        n = len(m["who"])
        m["obs"] = np.array(m["obs"], np.float32).reshape(n, OBS)
        m["mask"] = np.array([[c == "1" for c in row] for row in m["mask"]], dtype=bool).reshape(n, ACT)
        return m

    def send(self, actions):
        self.proc.stdin.write((json.dumps({"actions": actions}) + "\n").encode())
        self.proc.stdin.flush()

    def close(self):
        self.proc.kill()  # it may be blocked writing a batch nobody will read
        self.proc.wait()


# ---- stats -----------------------------------------------------------------------------------------


class Stats:
    def __init__(self, names):
        n = len(names)
        self.names = names
        self.games = np.zeros(n)
        self.reward = np.zeros(n)
        self.champs = np.zeros(n)
        self.levels = np.zeros((n, 6))
        self.champ_levels = np.zeros(6)
        self.all_levels = np.zeros(6)
        self.n_champs = 0
        self.n_seats = 0
        self.bet_total = np.zeros(n)
        self.bet_net = np.zeros(n)
        self.actions = np.zeros((n, ACT))

    def game(self, agents, res):
        for seat, a in enumerate(agents):
            self.games[a] += 1
            self.reward[a] += res["reward"][seat]
            lv = np.array(res["levels"][seat], float)
            self.levels[a] += lv
            self.all_levels += lv
            self.n_seats += 1
            self.bet_total[a] += res["betTotal"][seat]
            self.bet_net[a] += res["betNet"][seat]
            if res["rank"][seat] == 1:
                self.champs[a] += 1
                self.champ_levels += lv
                self.n_champs += 1

    def report(self, players, elapsed, games_done):
        print(f"\n== {games_done} games, {games_done / elapsed:.0f}/s, {players} players ==")
        print(f"{'agent':<20}{'games':>7}{'mean reward':>13}{'wins':>8}   avg build (speed determ boost shell salt food)")
        for i, name in enumerate(self.names):
            g = max(self.games[i], 1)
            build = " ".join(f"{x:4.1f}" for x in self.levels[i] / g)
            print(f"{name:<20}{int(self.games[i]):>7}{self.reward[i] / g:>13.3f}{self.champs[i] / g * 100:>7.1f}%   {build}")
        if self.n_champs:
            win = " ".join(f"{x:4.1f}" for x in self.champ_levels / self.n_champs)
            avg = " ".join(f"{x:4.1f}" for x in self.all_levels / self.n_seats)
            print(f"{'champions build':<20}{'':>28}   {win}\n{'everyone':<20}{'':>28}   {avg}")
        if self.bet_total.sum() > 0:
            print("betting (net coins per coin staked):")
            for i, name in enumerate(self.names):
                if self.bet_total[i]:
                    print(f"  {name:<20}{self.bet_net[i] / self.bet_total[i]:+7.3f}  staked {int(self.bet_total[i])}")
            use = self.actions[:, BET_BASE:].sum(0)
            if use.sum():
                frac = use.reshape(8, 4).sum(0) / use.sum()
                lane = use.reshape(8, 4).sum(1) / use.sum()
                print("  bet size mix (10/25/50/100% of limit): " + " ".join(f"{x * 100:4.1f}%" for x in frac))
                print("  lane mix: " + " ".join(f"{x * 100:4.1f}%" for x in lane))
        buys = self.actions[:, :6].sum(0)
        if buys.sum():
            print("purchases: " + "  ".join(f"{n} {x / buys.sum() * 100:.0f}%" for n, x in zip(ITEMS, buys)))
        sys.stdout.flush()


# ---- main ----------------------------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--players", type=int, default=8, choices=range(2, 17))
    ap.add_argument("--agents", type=int, default=12, help="learning bots in the population")
    ap.add_argument("--anchors", type=int, default=4, help="scripted bots (0-4) that never learn")
    ap.add_argument("--games", type=int, default=256, help="games played side by side")
    ap.add_argument("--rounds", type=int, default=4, help="seeding rounds")
    ap.add_argument("--total", type=int, default=300000, help="games to play before stopping")
    ap.add_argument("--name", default="run")
    ap.add_argument("--exe", default=os.path.join(os.path.dirname(__file__), "arena.exe"))
    ap.add_argument("--batch", type=int, default=6000, help="steps an agent collects before it updates")
    ap.add_argument("--minibatch", type=int, default=1024)
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--entropy", type=float, default=0.01)
    ap.add_argument("--report-every", type=int, default=20000)
    ap.add_argument("--eval", action="store_true", help="no learning: load saved bots and play")
    ap.add_argument("--blind", action="store_true", help="bots cannot see opponents' upgrades")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.set_num_threads(4)

    out = os.path.join(os.path.dirname(__file__), "runs", args.name)
    os.makedirs(out, exist_ok=True)
    pop = [Learner(f"bot{i + 1}", args.lr, args) for i in range(args.agents)]
    pop += [Scripted(*a) for a in ANCHORS[: args.anchors]]
    for i, ag in enumerate(pop):
        path = os.path.join(out, f"agent{i}.pt")
        if ag.learns and os.path.exists(path):
            ag.net.load_state_dict(torch.load(path))
    seats = args.players
    stats = Stats([a.name for a in pop])

    def seat_agents():
        return random.sample(range(len(pop)), seats) if len(pop) >= seats else random.choices(range(len(pop)), k=seats)

    arena = Arena(args.exe, args.players, args.games, args.rounds, args.blind)
    assign = [seat_agents() for _ in range(args.games)]
    traj = {}  # (game, seat) -> [obs, mask, act, logp, val]
    played, next_report, t0 = 0, args.report_every, time.time()

    def save():
        for i, ag in enumerate(pop):
            if ag.learns:
                torch.save(ag.net.state_dict(), os.path.join(out, f"agent{i}.pt"))

    try:
        while played < args.total:
            msg = arena.read()
            for res in msg["done"]:
                g = res["game"]
                stats.game(assign[g], res)
                for seat, a in enumerate(assign[g]):
                    steps = traj.pop((g, seat), None)
                    if steps and pop[a].learns and not args.eval:
                        pop[a].add(steps, res["reward"][seat])
                assign[g] = seat_agents()
                played += 1
            if not args.eval:
                for ag in pop:
                    if ag.learns and ag.ready():
                        ag.update()

            who, obs, mask = msg["who"], msg["obs"], msg["mask"]
            actions = np.zeros(len(who), np.int64)
            groups = {}
            for row, (g, s) in enumerate(who):
                groups.setdefault(assign[g][s], []).append(row)
            for a, rows in groups.items():
                act, logp, val = pop[a].act(obs[rows], mask[rows])
                actions[rows] = act
                for k, row in enumerate(rows):
                    stats.actions[a, act[k]] += 1
                    if pop[a].learns:
                        t = traj.setdefault(tuple(who[row]), [[], [], [], [], []])
                        for lst, x in zip(t, (obs[row], mask[row], act[k], logp[k], val[k])):
                            lst.append(x)
            arena.send([[g, s, int(actions[i])] for i, (g, s) in enumerate(who)])

            if played >= next_report:
                next_report += args.report_every
                stats.report(args.players, time.time() - t0, played)
                if not args.eval:
                    save()
    except KeyboardInterrupt:
        pass
    finally:
        stats.report(args.players, time.time() - t0, max(played, 1))
        if not args.eval:
            save()
        arena.close()


if __name__ == "__main__":
    main()
