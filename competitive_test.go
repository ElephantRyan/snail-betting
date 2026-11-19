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
	}
}

func TestPrizes(t *testing.T) {
	for n, want := range map[int]int{2: 1, 4: 1, 5: 2, 6: 2, 7: 2, 8: 3} {
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
	if len(split) != 3 || sum != 8*2*upgradeUnit(s) || split[0] <= split[1] || split[1] <= split[2] {
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
		t.Error("betting should be closed while seeding")
	}
	spent := 2 * unit
	for guard := 0; r.comp.stage == "seed" && guard < 100; guard++ {
		switch r.phase {
		case "shop":
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
