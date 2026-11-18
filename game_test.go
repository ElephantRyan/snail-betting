package main

import (
	"math/rand/v2"
	"testing"
)

func TestUniqueName(t *testing.T) {
	cases := []struct {
		name  string
		taken []string
		want  string
	}{
		{"Sam", nil, "Sam"},
		{"Sam", []string{"sam"}, "Sam 2"},
		{"Sam", []string{"Sam", "Sam 2"}, "Sam 3"},
	}
	for _, c := range cases {
		if got := uniqueName(c.name, c.taken); got != c.want {
			t.Errorf("uniqueName(%q,%v)=%q want %q", c.name, c.taken, got, c.want)
		}
	}
}

func TestCleanName(t *testing.T) {
	if got := cleanName("  <b>Al</b>   B  "); got != "bAlb B" {
		t.Errorf("got %q", got)
	}
	if got := cleanName("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"); len([]rune(got)) != 16 {
		t.Errorf("not capped: %q", got)
	}
}

func TestSettleSplitsPoolByPlacement(t *testing.T) {
	// podium: lane 0 (60%), lane 1 (25%), lane 2 (15%)
	order := []int{0, 1, 2, 3, 4, 5}
	bets := []stake{{"a", 0, 100}, {"b", 0, 300}, {"c", 1, 200}, {"d", 2, 100}, {"e", 5, 100}}
	p, pool, refunded := settle(bets, order)
	if refunded || pool != 800 {
		t.Fatalf("refunded=%v pool=%d", refunded, pool)
	}
	want := map[string]int{"a": 120, "b": 360, "c": 200, "d": 120}
	for id, w := range want {
		if p[id] != w {
			t.Errorf("%s got %d want %d (all %v)", id, p[id], w, p)
		}
	}
	if _, ok := p["e"]; ok {
		t.Error("unplaced snail was paid")
	}
}

func TestSettleRedistributesUnbackedPlaces(t *testing.T) {
	// only 2nd and 3rd are backed: weights 25:15 share the whole pool
	bets := []stake{{"a", 1, 100}, {"b", 2, 100}, {"c", 5, 200}}
	p, pool, _ := settle(bets, []int{0, 1, 2, 3, 4, 5})
	if pool != 400 || p["a"] != 250 || p["b"] != 150 {
		t.Errorf("payouts=%v pool=%d", p, pool)
	}
	// lone winner backer takes everything
	if p, _, _ := settle([]stake{{"a", 0, 100}, {"c", 5, 200}}, []int{0, 1, 2, 3, 4, 5}); p["a"] != 300 {
		t.Errorf("lone podium backer should take the pool, got %v", p)
	}
}

func TestSettlePaysWholePool(t *testing.T) {
	bets := []stake{{"a", 2, 1}, {"b", 2, 1}, {"c", 2, 1}, {"d", 3, 1}, {"e", 0, 7}, {"f", 1, 3}}
	p, pool, _ := settle(bets, []int{0, 1, 2, 3, 4, 5})
	sum := 0
	for _, v := range p {
		sum += v
	}
	if sum != pool {
		t.Errorf("paid %d of %d", sum, pool)
	}
}

func TestSettleRefundsWhenNobodyPlaces(t *testing.T) {
	p, _, refunded := settle([]stake{{"a", 4, 50}}, []int{0, 1, 2, 3, 4, 5})
	if !refunded || p["a"] != 50 {
		t.Errorf("refunded=%v payouts=%v", refunded, p)
	}
}

func TestSimulateRaceIsFairAndEveryoneFinishes(t *testing.T) {
	const n = 3000
	wins := make([]int, snailCount)
	for i := 0; i < n; i++ {
		frames, order := simulateRace(snailCount, rand.Float64)
		last := frames[len(frames)-1]
		for lane, p := range last {
			if p < int(exitProgress*1000) {
				t.Fatalf("lane %d still on screen at the end: %v", lane, last)
			}
		}
		seen := map[int]bool{}
		for _, lane := range order {
			seen[lane] = true
		}
		if len(order) != snailCount || len(seen) != snailCount {
			t.Fatalf("order is not a permutation: %v", order)
		}
		wins[order[0]]++
	}
	for lane, w := range wins {
		if w < n/snailCount*8/10 || w > n/snailCount*12/10 {
			t.Errorf("lane %d won %d of %d: %v", lane, w, n, wins)
		}
	}
}

func TestRoundFlowAndPayouts(t *testing.T) {
	r := newRoom(Settings{Rounds: 2, StartCoins: 1000, BetSeconds: 0}, "TEST")
	host, guest := r.addPlayer("Host"), r.addPlayer("Host")
	if guest.name != "Host 2" {
		t.Fatalf("guest name %q", guest.name)
	}
	host.connected, guest.connected = true, true
	if r.start(guest) == "" {
		t.Fatal("non-host started the game")
	}
	r.start(host)
	if r.placeBet(host, 0, 5000) == "" {
		t.Fatal("bet over balance accepted")
	}
	r.placeBet(host, 0, 100)
	r.placeBet(guest, 1, 300) // everyone ready -> betting closes and the race starts
	if r.phase != "racing" {
		t.Fatalf("phase %s", r.phase)
	}
	r.race.order = []int{0, 1, 2, 3, 4, 5} // fix the outcome
	r.finishRace()
	if r.phase != "results" || host.coins != 1182 || guest.coins != 818 {
		t.Fatalf("phase=%s host=%d guest=%d", r.phase, host.coins, guest.coins)
	}
}
