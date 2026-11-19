package main

import (
	"fmt"
	mrand "math/rand/v2"
	"os"
	"testing"
)

// TestSizeProbe shows who pays for spectator betting: small fixed bets against big random ones.
//
//	PROBE=1 go test -run TestSizeProbe -v
func TestSizeProbe(t *testing.T) {
	if os.Getenv("PROBE") == "" {
		t.Skip()
	}
	mask := make([]byte, actSize)
	// seats 0-7: always lane 0 at 10% of the limit. seats 8-15: a random lane at 100%.
	var staked, net [2]float64
	for game := 0; game < 4000; game++ {
		g := newArenaGame(16, 4)
		for {
			g.advance()
			if g.finished != nil {
				break
			}
			for _, seat := range g.pending {
				g.legal(g.seats[seat], mask)
				if g.r.phase == "betting" {
					a := actBetBase + 0*len(betFrac) + 0
					if seat >= 8 {
						a = actBetBase + mrand.IntN(g.r.laneCount())*len(betFrac) + 3
					}
					if mask[a] != '1' {
						a = actDone
					}
					g.act(seat, a)
					continue
				}
				var opts []int
				for a, m := range mask {
					if m == '1' && a < actDone {
						opts = append(opts, a)
					}
				}
				if len(opts) == 0 {
					g.act(seat, actDone)
				} else {
					g.act(seat, opts[mrand.IntN(len(opts))])
				}
			}
		}
		for seat := range g.seats {
			k := seat / 8
			staked[k] += float64(g.finished.BetTotal[seat])
			net[k] += float64(g.finished.BetNet[seat])
		}
	}
	fmt.Printf("small (lane 0, 10%%): %+.3f per coin on %.0f staked\n", net[0]/staked[0], staked[0])
	fmt.Printf("big (random lane, 100%%): %+.3f per coin on %.0f staked\n", net[1]/staked[1], staked[1])
}
