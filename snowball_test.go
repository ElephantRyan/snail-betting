package main

import (
	"fmt"
	mrand "math/rand/v2"
	"os"
	"testing"
)

// TestSnowball plays games of identical random shoppers and asks whether a bad first round dooms
// a player:
//
//	BALANCE=1 go test -run TestSnowball -v
//
// Everyone has the same skill, so a fair game gives every first-round finisher the same chance
// (1 in n) to win the race and to finish richest.
func TestSnowball(t *testing.T) {
	if os.Getenv("BALANCE") == "" {
		t.Skip("set BALANCE=1 to run")
	}
	const games, players = 3000, 5
	mask := make([]byte, actSize)
	for _, rounds := range []int{4, 8} {
		var champ, rich [players]float64 // by first-round finish: 0 = won round 1, players-1 = last
		var avgRank [players]float64
		spread := 0.0
		for game := 0; game < games; game++ {
			g := newArenaGame(players, rounds)
			var order []int // seats by first-round points, best first
			for {
				g.advance()
				if g.finished != nil {
					break
				}
				if order == nil && g.r.comp.round == 2 {
					order = make([]int, players)
					for i := range order {
						order[i] = i
					}
					for a := 0; a < players; a++ {
						for b := a + 1; b < players; b++ {
							if g.seats[order[b]].points > g.seats[order[a]].points {
								order[a], order[b] = order[b], order[a]
							}
						}
					}
				}
				for _, seat := range g.pending {
					g.legal(g.seats[seat], mask)
					var opts []int
					for a, m := range mask {
						if m == '1' && a < actDone {
							opts = append(opts, a)
						}
					}
					if len(opts) == 0 || g.r.phase == "betting" {
						g.act(seat, actDone)
					} else {
						g.act(seat, opts[mrand.IntN(len(opts))])
					}
				}
			}
			lo, hi := 1<<30, 0
			for _, c := range g.finished.Coins {
				lo, hi = min(lo, c), max(hi, c)
			}
			spread += float64(hi-lo) / games
			for place, seat := range order {
				avgRank[place] += float64(g.finished.Rank[seat]) / games
				if g.finished.Rank[seat] == 1 {
					champ[place] += 100.0 / games
				}
				if g.finished.WealthRank[seat] == 1 {
					rich[place] += 100.0 / games
				}
			}
		}
		fmt.Printf("\n%d players, %d seeding rounds (fair share %.0f%%), coin gap richest-poorest at the end: %.0f\n", players, rounds, 100.0/players, spread)
		fmt.Printf("%-26s %8s %8s %10s\n", "finish in round 1", "wins race", "richest", "avg rank")
		for place := 0; place < players; place++ {
			fmt.Printf("%-26s %7.1f%% %7.1f%% %10.2f\n", fmt.Sprintf("#%d", place+1), champ[place], rich[place], avgRank[place])
		}
	}
}
