package main

import (
	"encoding/json"
	"fmt"
	mrand "math/rand/v2"
	"testing"
)

func rnd01() func() float64 { return mrand.Float64 }

func TestSeededHeats(t *testing.T) {
	seeds := make([]int, 16)
	for i := range seeds {
		seeds[i] = i + 1
	}
	heats := seededHeats(seeds)
	if len(heats) != 2 {
		t.Fatalf("want 2 heats, got %d", len(heats))
	}
	in := map[int]bool{}
	for _, id := range heats[0] {
		in[id] = true
	}
	for _, want := range []int{1, 2, 3, 4, 13, 14, 15, 16} {
		if !in[want] {
			t.Errorf("heat 1 is missing seed %d: %v", want, heats[0])
		}
	}
	if len(heats[1]) != 8 {
		t.Errorf("heat 2 has %d snails", len(heats[1]))
	}
	if h := seededHeats(seeds[:6]); len(h) != 1 || len(h[0]) != 6 {
		t.Errorf("6 players should be a single heat: %v", h)
	}
}

func TestUpgradesMakeSnailsFaster(t *testing.T) {
	maxed := Upgrades{Speed: 5, Determ: 5, Boost: 5, Shell: 5}
	wins, runs := 0, 300
	for i := 0; i < runs; i++ {
		mods := make([]Upgrades, 6)
		mods[0] = maxed
		_, order, _ := simulateRaceWith(6, rnd01(), mods)
		if order[0] == 0 {
			wins++
		}
	}
	// an even field would win about 1 in 6 (50 of 300)
	if wins < 100 {
		t.Errorf("a fully upgraded snail won only %d of %d races", wins, runs)
	}
}

func TestAttacksFire(t *testing.T) {
	mods := make([]Upgrades, 4)
	mods[1] = Upgrades{Salt: 3, Food: 3}
	_, _, ev := simulateRaceWith(4, rnd01(), mods)
	if len(ev) != 6 {
		t.Fatalf("want 6 attacks, got %d", len(ev))
	}
	for _, e := range ev {
		if e.From != 1 || e.To == 1 {
			t.Errorf("bad attack %+v", e)
		}
		if !e.Blocked && e.Dur <= 0 {
			t.Errorf("a landed attack needs a duration: %+v", e)
		}
	}
}

func TestPrizes(t *testing.T) {
	for n, want := range map[int]int{2: 1, 3: 1, 4: 2, 5: 3, 6: 3, 7: 4, 8: 4} {
		if got := prizePlaces(n); got != want {
			t.Errorf("prizePlaces(%d) = %d, want %d", n, got, want)
		}
	}
	s := cleanSettings(Settings{Mode: modeCompetitive, StartCoins: 99999})
	if s.StartCoins != compStartCoins {
		t.Errorf("competitive start coins should be fixed, got %d", s.StartCoins)
	}
	split := prizeSplit(s, 8)
	sum := 0
	for _, p := range split {
		sum += p
	}
	if len(split) != 4 || sum != 8*2*upgradeUnit(s) || split[0] <= split[1] || split[1] <= split[2] {
		t.Errorf("bad prize split %v", split)
	}
}

func TestCompetitiveGame(t *testing.T) {
	r := newRoom(Settings{Mode: modeCompetitive, Rounds: 2}, "TEST")
	var ps []*Player
	for i := 0; i < 10; i++ {
		ps = append(ps, r.addPlayer(fmt.Sprintf("P%d", i)))
		ps[i].connected = true
	}
	host := ps[0]
	if r.start(host) != "" || r.phase != "shop" {
		t.Fatalf("start failed, phase %s", r.phase)
	}
	start := ps[1].coins
	unit := upgradeUnit(r.settings)
	if r.buy(ps[1], "speed") != "" || ps[1].upg.Speed != 1 || ps[1].coins != start-unit {
		t.Errorf("buy: %+v coins %d", ps[1].upg, ps[1].coins)
	}
	if r.buy(ps[1], "speed") == "" {
		t.Error("the same upgrade twice in one round was allowed")
	}
	if r.buy(ps[1], "shell") != "" || r.buy(ps[1], "boost") == "" {
		t.Error("round 1 should allow exactly 2 upgrades")
	}
	if r.placeBet(ps[1], 0, 10) == "" {
		t.Error("the shop has no betting")
	}
	spent := 2 * unit
	sawSeedBet := false
	for guard := 0; r.comp.stage == "seed" && guard < 100; guard++ {
		switch r.phase {
		case "shop":
			for _, p := range ps {
				r.ready(p)
			}
		case "betting":
			if !sawSeedBet { // 10 players = 2 seeding heats, so the other heat's racers can bet
				sawSeedBet = true
				var racer, watcher *Player
				for _, p := range ps {
					if r.isRacing(p) && racer == nil {
						racer = p
					}
					if !r.isRacing(p) && watcher == nil {
						watcher = p
					}
				}
				if r.placeBet(racer, 0, 10) == "" {
					t.Error("a seeding racer was allowed to bet on their own heat")
				}
				if err := r.placeBet(watcher, 0, 10); err != "" {
					t.Fatal(err)
				}
			}
			for _, p := range ps {
				r.ready(p)
			}
		case "racing":
			r.compFinishHeat()
		case "results":
			r.compNext()
		}
	}
	if r.comp.stage != "elim" || r.bracket == nil {
		t.Fatalf("never reached elimination (stage %s)", r.comp.stage)
	}
	if !sawSeedBet {
		t.Error("nobody got to bet on a seeding heat")
	}
	if r.buy(host, "speed") == "" {
		t.Error("upgrades should be locked during elimination")
	}
	if len(r.bracket.heats) != 2 {
		t.Fatalf("10 players should open with 2 heats, got %d", len(r.bracket.heats))
	}
	if r.phase != "betting" {
		t.Fatalf("the sitting-out players should get to bet first, phase %s", r.phase)
	}

	// the racers can't bet; a spectator can
	racing := map[int]bool{}
	for _, id := range r.bracket.heats[0] {
		racing[id] = true
	}
	var racer, watcher *Player
	for _, p := range ps {
		if racing[p.optID] && racer == nil {
			racer = p
		}
		if !racing[p.optID] && watcher == nil {
			watcher = p
		}
	}
	if r.placeBet(racer, 0, 10) == "" {
		t.Error("a racing player was allowed to bet on their own heat")
	}
	if err := r.placeBet(watcher, 0, 10); err != "" {
		t.Fatal(err)
	}
	for _, p := range ps {
		if !racing[p.optID] && p != watcher { // the bettor is already ready
			r.ready(p)
		}
	}
	if r.phase != "racing" {
		t.Fatalf("betting should close once every spectator is ready, phase %s", r.phase)
	}
	r.race.order = []int{0, 1, 2, 3, 4}
	r.finishHeat()
	if len(r.comp.bets) != 1 || r.comp.result[0].Prize == 0 {
		t.Errorf("expected one bet and a prize for the winner: %+v %+v", r.comp.bets, r.comp.result)
	}

	// prizes are paid by the house; everything else just moves between players
	total, prizes := 0, 0
	for _, p := range ps {
		total += p.coins
	}
	for _, row := range r.comp.result {
		prizes += row.Prize
	}
	if total < len(ps)*compStartCoins-spent {
		t.Errorf("coins vanished: %d", total)
	}
	for _, p := range ps {
		if _, err := json.Marshal(r.view(p)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPickTarget(t *testing.T) {
	// 4 snails: the top 2 are in the prize places, so ranks 2 and 3 (lanes 3 and 1) fight back
	pos := []float64{0.5, 0.2, 0.9, 0.4}
	never := func() float64 { panic("a snail that is behind should not roll for a target") }
	for _, c := range []struct {
		kind       string
		from, want int
	}{
		{"food", 1, 2}, // last place: food hits the leader
		{"salt", 1, 3}, // salt hits the snail just ahead
		{"food", 3, 2},
		{"salt", 3, 0},
	} {
		if got := pickTarget(c.kind, c.from, pos, never); got != c.want {
			t.Errorf("%s from %d: got %d, want %d", c.kind, c.from, got, c.want)
		}
	}
	// the leader (and anyone else in the prize places) shoots a random rival
	for _, c := range []struct {
		roll float64
		want int
	}{{0, 0}, {0.5, 1}, {0.99, 3}} {
		if got := pickTarget("food", 2, pos, func() float64 { return c.roll }); got != c.want {
			t.Errorf("leader rolling %.2f: got %d, want %d", c.roll, got, c.want)
		}
	}
	pos[0] = 1.05 // finished snails can't be hit
	for _, roll := range []float64{0, 0.5, 0.99} {
		if got := pickTarget("salt", 2, pos, func() float64 { return roll }); got == 0 || got == 2 {
			t.Errorf("random pick landed on %d", got)
		}
	}
	if got := pickTarget("food", 1, pos, never); got != 2 {
		t.Errorf("food should skip a finished snail, got %d", got)
	}
	if got := pickTarget("salt", 0, []float64{0.5, 1.2}, never); got != -1 {
		t.Errorf("nobody left to hit, got %d", got)
	}
}

func TestSpreadShots(t *testing.T) {
	for n := 1; n <= 6; n++ {
		for _, roll := range []float64{0, 0.5, 0.999} {
			times := spreadShots(n, func() float64 { return roll })
			stretch := 300 / n
			for j, at := range times {
				if at < 45 || at > 345 {
					t.Errorf("n=%d: shot %d at frame %d is outside the window", n, j, at)
				}
				if j > 0 && at-times[j-1] < stretch/2-1 {
					t.Errorf("n=%d roll %.1f: shots %d and %d are only %d frames apart", n, roll, j-1, j, at-times[j-1])
				}
			}
		}
	}
	// and in a real race, one snail's attacks never fire on the same frame
	mods := make([]Upgrades, 6)
	mods[2] = Upgrades{Salt: 3, Food: 3}
	for run := 0; run < 200; run++ {
		_, _, events := simulateRaceWith(6, rnd01(), mods)
		seen := map[int]bool{}
		for _, e := range events {
			if seen[e.T] {
				t.Fatalf("two attacks left the same snail on frame %d", e.T)
			}
			seen[e.T] = true
		}
	}
}

func TestConsolationAndStipend(t *testing.T) {
	r := newRoom(Settings{Mode: modeCompetitive, Rounds: 3}, "TEST")
	var ps []*Player
	for i := 0; i < 3; i++ {
		p := r.addPlayer(fmt.Sprintf("P%d", i))
		p.connected = true
		ps = append(ps, p)
	}
	r.start(ps[0])
	for _, p := range ps {
		r.ready(p)
	}
	if r.phase != "racing" {
		t.Fatalf("phase %s", r.phase)
	}
	before := map[string]int{}
	for _, p := range ps {
		before[p.id] = p.coins
	}
	r.compFinishHeat()
	unit := upgradeUnit(r.settings)
	rows := r.comp.result
	for _, row := range rows {
		if got := r.find(row.ID).coins; row.Base != unit || got != before[row.ID]+row.Base+row.Prize {
			t.Errorf("%s: base %d prize %d coins %d (was %d)", row.Name, row.Base, row.Prize, got, before[row.ID])
		}
	}
	last, winner := r.find(rows[2].ID), r.find(rows[0].ID)
	if last.free != 1 || !rows[2].Consolation || winner.free != 0 {
		t.Errorf("only last place gets the free upgrade: last %d winner %d", last.free, winner.free)
	}
	r.compNext()
	if r.phase != "shop" {
		t.Fatalf("phase %s", r.phase)
	}
	coins := last.coins
	if r.buy(last, "speed") != "" || last.coins != coins {
		t.Errorf("the consolation pick should cost nothing: %d -> %d", coins, last.coins)
	}
	if last.free != 0 || r.shopLeft(last) != shopAllowance(2) {
		t.Errorf("the free pick shouldn't use the paid allowance: free %d left %d", last.free, r.shopLeft(last))
	}
	if r.buy(last, "shell") != "" || last.coins != coins-unit {
		t.Errorf("a paid upgrade after it should still cost coins: %d", last.coins)
	}
}

func TestFinalShop(t *testing.T) {
	r := newRoom(Settings{Mode: modeCompetitive, Rounds: 1}, "TEST")
	var ps []*Player
	for i := 0; i < 3; i++ {
		p := r.addPlayer(fmt.Sprintf("P%d", i))
		p.connected = true
		ps = append(ps, p)
	}
	r.start(ps[0])
	for _, p := range ps {
		r.ready(p)
	}
	r.compFinishHeat()
	if !r.comp.result[2].Consolation {
		t.Error("last place in the final seeding round should still get a free upgrade")
	}
	winnerID := r.comp.result[0].ID
	r.compNext() // the last heat is over: one more shop, not the bracket
	if r.phase != "shop" || !r.comp.finalShop || r.comp.stage != "seed" || r.bracket != nil {
		t.Fatalf("expected the final shop, got phase %s stage %s", r.phase, r.comp.stage)
	}
	seeds := map[string]int{}
	for _, p := range ps {
		if p.seed == 0 {
			t.Errorf("%s has no seed before the final shop", p.name)
		}
		seeds[p.id] = p.seed
	}
	best := r.find(winnerID)
	coins := best.coins
	if r.buy(best, "speed") != "" || best.coins >= coins {
		t.Errorf("the final shop should sell upgrades: coins %d -> %d", coins, best.coins)
	}
	for _, p := range ps {
		r.ready(p)
	}
	if r.comp.stage != "elim" || r.bracket == nil {
		t.Fatalf("elimination should start once the final shop closes (stage %s)", r.comp.stage)
	}
	for _, p := range ps {
		if p.seed != seeds[p.id] {
			t.Errorf("%s's seed changed from %d to %d after shopping", p.name, seeds[p.id], p.seed)
		}
	}
	if r.buy(best, "shell") == "" {
		t.Error("upgrades should be locked once elimination starts")
	}
}
