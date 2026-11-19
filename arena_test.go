package main

import (
	mrand "math/rand/v2"
	"testing"
)

// Random legal play must always finish, give every seat a distinct rank, and (with 9+ players)
// reach the betting phase.
func TestArenaRandomGames(t *testing.T) {
	for _, players := range []int{2, 8, 9, 16} {
		sawBet := false
		for game := 0; game < 60; game++ {
			g := newArenaGame(players, 4)
			mask := make([]byte, actSize)
			for steps := 0; ; steps++ {
				g.advance()
				if g.finished != nil {
					break
				}
				if steps > 5000 {
					t.Fatalf("%d players: game never ended (phase %s)", players, g.r.phase)
				}
				for _, seat := range g.pending {
					g.legal(g.seats[seat], mask)
					var options []int
					for a, m := range mask {
						if m == '1' {
							options = append(options, a)
						}
					}
					a := options[mrand.IntN(len(options))]
					sawBet = sawBet || a >= actBetBase
					if len(g.observe(seat)) != obsSize {
						t.Fatal("bad observation size")
					}
					g.act(seat, a)
				}
			}
			ranks := map[int]bool{}
			for _, rk := range g.finished.Rank {
				ranks[rk] = true
			}
			if len(ranks) != players {
				t.Fatalf("%d players: ranks %v", players, g.finished.Rank)
			}
			sum := 0.0
			for _, rw := range g.finished.Reward {
				sum += rw
			}
			if want := float64(players) / 2; sum < want-1e-9 || sum > want+1e-9 {
				t.Fatalf("rewards should sum to %v, got %v", want, sum)
			}
		}
		if players >= 9 && !sawBet {
			t.Errorf("%d players never got to bet", players)
		}
		if players <= 8 && sawBet {
			t.Errorf("%d players should have no spectators to bet", players)
		}
	}
}
