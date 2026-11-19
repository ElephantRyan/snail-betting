package main

// Headless arena for bot training: `snail-betting -arena -players 16 -games 256` plays many
// competitive games at once through the real Room rules and talks to bots/train.py over stdin and
// stdout, one JSON object per line.
//
// Every seat that has a decision to make (buy an upgrade or finish shopping while seeding; place a
// bet or skip while sitting out an elimination heat) gets an observation and a mask of the legal
// actions. The trainer answers with one action per seat. A finished game is reported with each
// seat's reward and the game restarts straight away in the same slot.

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"runtime"
	"slices"
	"strconv"
	"sync"
)

const (
	obsSize    = 120
	actDone    = 6 // finish shopping, or skip betting
	actBetBase = 7 // then lane*len(betFrac)+fraction
	betLanes   = maxHeat
	actSize    = actBetBase + betLanes*4
)

// arenaBlind hides every opponent's upgrade levels from the bots, as the real UI does.
var arenaBlind bool

var arenaTap func(size int, order []int) // PROBE

var (
	shopItems = [6]string{"speed", "determ", "boost", "shell", "salt", "food"}
	betFrac   = [4]float64{0.1, 0.25, 0.5, 1}
)

type arenaGame struct {
	r        *Room
	seats    []*Player
	rounds   int
	pending  []int // seats waiting for an action
	finished *arenaResult
	betTotal []int
	betNet   []int
}

// arenaResult is what the trainer hears when a game ends.
type arenaResult struct {
	Game     int       `json:"game"`
	Reward   []float64 `json:"reward"` // 1 for the champion down to 0 for the first one out
	Rank     []int     `json:"rank"`
	Levels   [][6]int  `json:"levels"`
	Coins    []int     `json:"coins"`
	BetTotal []int     `json:"betTotal"`
	BetNet   []int     `json:"betNet"`
}

func newArenaGame(players, rounds int) *arenaGame {
	r := newRoom(Settings{Mode: modeCompetitive, Rounds: rounds}, "ARENA")
	r.headless = true
	g := &arenaGame{r: r, rounds: rounds, betTotal: make([]int, players), betNet: make([]int, players)}
	for i := 0; i < players; i++ {
		p := r.addPlayer("Bot " + strconv.Itoa(i+1))
		p.connected = true
		g.seats = append(g.seats, p)
	}
	r.start(g.seats[0])
	return g
}

func (g *arenaGame) seatOf(p *Player) int { return slices.Index(g.seats, p) }

func levelsOf(u Upgrades) [6]int { return [6]int{u.Speed, u.Determ, u.Boost, u.Shell, u.Salt, u.Food} }

// legal fills the action mask for a seat; the second result is whether anything other than
// finishing is possible.
func (g *arenaGame) legal(p *Player, mask []byte) bool {
	r := g.r
	for i := range mask {
		mask[i] = '0'
	}
	mask[actDone] = '1'
	choice := false
	switch r.phase {
	case "shop":
		if len(p.bought) < shopAllowance(r.comp.round) {
			for i, item := range shopItems {
				level, top := p.upg.slot(item)
				if *level < top && !slices.Contains(p.bought, item) && upgradeUnit(r.settings)*(*level+1) <= p.coins {
					mask[i], choice = '1', true
				}
			}
		}
	case "betting":
		limit := r.settings.betLimit(p.coins)
		if limit >= 1 {
			for lane := 0; lane < r.laneCount(); lane++ {
				for f := range betFrac {
					mask[actBetBase+lane*len(betFrac)+f], choice = '1', true
				}
			}
		}
	}
	return choice
}

// advance runs the game until some seat has to decide, or the game is over.
func (g *arenaGame) advance() {
	r := g.r
	mask := make([]byte, actSize)
	for guard := 0; guard < 10000; guard++ {
		switch r.phase {
		case "shop", "betting":
			g.pending = g.pending[:0]
			forced := false
			for seat, p := range g.seats {
				if p.ready || r.isRacing(p) {
					continue
				}
				if !g.legal(p, mask) { // nothing to choose: just finish
					r.ready(p)
					forced = true
					break
				}
				g.pending = append(g.pending, seat)
			}
			if forced {
				continue
			}
			if len(g.pending) == 0 {
				r.closeRound()
				continue
			}
			return
		case "racing":
			if r.comp.stage == "seed" {
				r.compFinishHeat()
			} else {
				if arenaTap != nil {
					arenaTap(len(r.race.order), r.race.order)
				}
				r.finishHeat()
				for _, b := range r.comp.bets {
					seat := slices.IndexFunc(g.seats, func(p *Player) bool { return p.id == b.ID })
					g.betTotal[seat] += b.Amount
					g.betNet[seat] += b.Payout - b.Amount
				}
			}
		case "results":
			if r.comp.stage == "seed" {
				r.compNext()
			} else {
				r.next(g.seats[0])
			}
		case "final":
			g.finish()
			return
		default:
			panic("arena stuck in phase " + r.phase)
		}
	}
	panic("arena loop did not end")
}

func (g *arenaGame) finish() {
	n := len(g.seats)
	res := &arenaResult{
		Reward: make([]float64, n), Rank: make([]int, n), Levels: make([][6]int, n), Coins: make([]int, n),
		BetTotal: g.betTotal, BetNet: g.betNet,
	}
	for _, row := range g.r.bracket.standings {
		seat := slices.IndexFunc(g.seats, func(p *Player) bool { return p.optID == row.Option })
		res.Rank[seat] = row.Rank
		res.Reward[seat] = 1 - float64(row.Rank-1)/float64(n-1)
	}
	for i, p := range g.seats {
		res.Levels[i], res.Coins[i] = levelsOf(p.upg), p.coins
	}
	g.finished, g.pending = res, nil
}

// act applies one seat's action; anything illegal just ends that seat's turn.
func (g *arenaGame) act(seat, action int) {
	if seat < 0 || seat >= len(g.seats) {
		return
	}
	r, p := g.r, g.seats[seat]
	if p.ready {
		return
	}
	switch {
	case action >= 0 && action < len(shopItems) && r.phase == "shop":
		if r.buy(p, shopItems[action]) != "" {
			r.ready(p)
		}
	case action >= actBetBase && action < actSize && r.phase == "betting":
		lane, f := (action-actBetBase)/len(betFrac), (action-actBetBase)%len(betFrac)
		amount := max(1, int(float64(r.settings.betLimit(p.coins))*betFrac[f]))
		if r.placeBet(p, lane, amount) != "" {
			r.ready(p)
		}
	default:
		r.ready(p)
	}
}

func b2f(b bool) float32 {
	if b {
		return 1
	}
	return 0
}

// observe describes the game from one seat's point of view; everything in it is public in the UI.
func (g *arenaGame) observe(seat int) []float32 {
	r, c, p := g.r, g.r.comp, g.seats[seat]
	n := float32(len(g.seats))
	rounds := float32(r.settings.Rounds)
	o := make([]float32, obsSize)
	o[0], o[1], o[2] = b2f(c.stage == "seed"), b2f(r.phase == "shop"), b2f(r.phase == "betting")
	o[3] = float32(c.round) / rounds
	if r.phase == "shop" {
		o[4] = float32(shopAllowance(c.round)-len(p.bought)) / 6
	}
	o[5] = min(2, float32(p.coins)/float32(2*compStartCoins))
	maxPts := 8 * rounds
	o[6] = float32(p.points) / maxPts
	ahead := 0
	var mean, top [6]float32
	for _, q := range r.players {
		if q.points > p.points {
			ahead++
		}
		if q != p {
			for i, l := range levelsOf(q.upg) {
				mean[i] += float32(l) / (n - 1)
				top[i] = max(top[i], float32(l))
			}
		}
	}
	o[7] = float32(ahead) / (n - 1)
	o[8] = n / 16
	for i, l := range levelsOf(p.upg) {
		o[9+i] = float32(l) / 5
		o[21+i] = mean[i] / 5
		o[27+i] = top[i] / 5
		o[15+i] = b2f(slices.Contains(p.bought, shopItems[i]))
	}
	o[33] = float32(p.seed) / n
	if c.stage == "elim" && r.bracket != nil {
		pools, _ := r.pools()
		total := 0
		for _, v := range pools {
			total += v
		}
		for lane, id := range r.bracket.heats[r.bracket.heat] {
			q := r.playerByOpt(id)
			base := 35 + lane*9
			o[base], o[base+1], o[base+2] = 1, float32(q.seed)/n, float32(q.points)/maxPts
			for i, l := range levelsOf(q.upg) {
				o[base+3+i] = float32(l) / 5
			}
			if total > 0 {
				o[107+lane] = float32(pools[lane]) / float32(total)
			}
		}
		o[116] = float32(total) / float32(int(n)*compStartCoins)
	}
	if arenaBlind {
		for i := 0; i < 6; i++ {
			o[21+i], o[27+i] = 0, 0
		}
		for lane := 0; lane < betLanes; lane++ {
			for i := 0; i < 6; i++ {
				o[35+lane*9+3+i] = 0
			}
		}
	}
	if p.coins > 0 {
		o[115] = float32(r.settings.betLimit(p.coins)) / float32(p.coins)
	}
	return o
}

func arenaMain(args []string) {
	fs := flag.NewFlagSet("arena", flag.ExitOnError)
	players := fs.Int("players", 8, "players per game (2-16)")
	games := fs.Int("games", 128, "games played side by side")
	rounds := fs.Int("rounds", 4, "seeding rounds per game")
	fs.BoolVar(&arenaBlind, "blind", false, "hide opponents' upgrade levels from the bots")
	_ = fs.Parse(args)
	if *players < 2 || *players > maxCompPlayers {
		fmt.Fprintln(os.Stderr, "players must be 2-16")
		os.Exit(2)
	}

	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	out := bufio.NewWriterSize(os.Stdout, 1<<20)
	slots := make([]*arenaGame, *games)
	for i := range slots {
		slots[i] = newArenaGame(*players, *rounds)
	}

	workers := runtime.NumCPU()
	var buf []byte
	mask := make([]byte, actSize)
	for {
		// run every game up to its next decision, in parallel
		var wg sync.WaitGroup
		next := make(chan int)
		for w := 0; w < workers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := range next {
					slots[i].advance()
				}
			}()
		}
		for i := range slots {
			next <- i
		}
		close(next)
		wg.Wait()

		// report finished games and restart them (a new game may need no decision, so loop)
		var done []*arenaResult
		for i, g := range slots {
			for g.finished != nil {
				g.finished.Game = i
				done = append(done, g.finished)
				g = newArenaGame(*players, *rounds)
				g.advance()
				slots[i] = g
			}
		}

		buf = append(buf[:0], `{"done":`...)
		doneJSON, _ := json.Marshal(done)
		if done == nil {
			doneJSON = []byte("[]")
		}
		buf = append(buf, doneJSON...)
		buf = append(buf, `,"who":[`...)
		first := true
		for i, g := range slots {
			for _, seat := range g.pending {
				if !first {
					buf = append(buf, ',')
				}
				first = false
				buf = append(buf, '[')
				buf = strconv.AppendInt(buf, int64(i), 10)
				buf = append(buf, ',')
				buf = strconv.AppendInt(buf, int64(seat), 10)
				buf = append(buf, ']')
			}
		}
		buf = append(buf, `],"obs":[`...)
		first = true
		for _, g := range slots {
			for _, seat := range g.pending {
				if !first {
					buf = append(buf, ',')
				}
				first = false
				buf = append(buf, '[')
				for k, v := range g.observe(seat) {
					if k > 0 {
						buf = append(buf, ',')
					}
					buf = strconv.AppendFloat(buf, float64(v), 'f', 3, 32)
				}
				buf = append(buf, ']')
			}
		}
		buf = append(buf, `],"mask":[`...)
		first = true
		for _, g := range slots {
			for _, seat := range g.pending {
				if !first {
					buf = append(buf, ',')
				}
				first = false
				g.legal(g.seats[seat], mask)
				buf = append(buf, '"')
				buf = append(buf, mask...)
				buf = append(buf, '"')
			}
		}
		buf = append(buf, "]}\n"...)
		if _, err := out.Write(buf); err != nil || out.Flush() != nil {
			return
		}

		line, err := in.ReadBytes('\n')
		if err != nil {
			return
		}
		var msg struct {
			Actions [][3]int `json:"actions"`
		}
		if json.Unmarshal(line, &msg) != nil {
			fmt.Fprintln(os.Stderr, "bad message from trainer")
			os.Exit(1)
		}
		for _, a := range msg.Actions {
			if a[0] >= 0 && a[0] < len(slots) {
				slots[a[0]].act(a[1], a[2])
			}
		}
	}
}
