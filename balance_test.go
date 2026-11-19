package main

import (
	"fmt"
	"math"
	mrand "math/rand/v2"
	"os"
	"testing"
)

// TestBalance is a Monte Carlo look at the upgrades; it only runs with BALANCE=1:
//
//	BALANCE=1 go test -run TestBalance -v
//
// Snail 0 gets the upgrades, the other seven are plain. The "gain" columns are against a plain
// snail in the same field (win 12.5%, mean seeding points 4.5).
func TestBalance(t *testing.T) {
	if os.Getenv("BALANCE") == "" {
		t.Skip("set BALANCE=1 to run")
	}
	const runs, lanes = 20000, 8
	unit := upgradeUnit(Settings{StartCoins: compStartCoins})
	rnd := mrand.New(mrand.NewPCG(1, 2)).Float64

	measure := func(u Upgrades) (win, pts float64) {
		for i := 0; i < runs; i++ {
			mods := make([]Upgrades, lanes)
			mods[0] = u
			_, order, _ := simulateRaceWith(lanes, rnd, mods)
			for place, lane := range order {
				if lane == 0 {
					pts += float64(seedPoints[place])
					if place == 0 {
						win++
					}
				}
			}
		}
		return win / runs, pts / runs
	}
	cost := func(level int) int { return unit * level * (level + 1) / 2 }

	fmt.Printf("%-8s %5s %6s %7s %7s %12s\n", "upgrade", "level", "coins", "win%", "points", "pts gain/100c")
	for _, item := range []string{"speed", "determ", "boost", "shell", "salt", "food"} {
		_, top := (&Upgrades{}).slot(item)
		for level := 1; level <= top; level++ {
			var u Upgrades
			*func() *int { p, _ := u.slot(item); return p }() = level
			win, pts := measure(u)
			fmt.Printf("%-8s %5d %6d %6.1f%% %7.2f %12.2f\n", item, level, cost(level), win*100, pts, (pts-4.5)/float64(cost(level))*100)
		}
	}
}

// TestBalanceShell measures Shell where it matters: against seven rivals firing every attack.
func TestBalanceShell(t *testing.T) {
	if os.Getenv("BALANCE") == "" {
		t.Skip("set BALANCE=1 to run")
	}
	const runs, lanes = 20000, 8
	rnd := mrand.New(mrand.NewPCG(3, 4)).Float64
	fmt.Printf("\nshell vs 7 rivals with salt 3 + food 3 (plain would be win 12.5%%, points 4.5)\n")
	for shell := 0; shell <= 5; shell++ {
		var win, pts float64
		for i := 0; i < runs; i++ {
			mods := make([]Upgrades, lanes)
			for j := 1; j < lanes; j++ {
				mods[j] = Upgrades{Salt: 3, Food: 3}
			}
			mods[0].Shell = shell
			_, order, _ := simulateRaceWith(lanes, rnd, mods)
			for place, lane := range order {
				if lane == 0 {
					pts += float64(seedPoints[place])
					if place == 0 {
						win++
					}
				}
			}
		}
		fmt.Printf("shell %d: win %5.1f%%  points %.2f\n", shell, win/runs*100, pts/runs)
	}
}

// TestBalanceBuilds pits whole builds of about equal cost against each other.
func TestBalanceBuilds(t *testing.T) {
	if os.Getenv("BALANCE") == "" {
		t.Skip("set BALANCE=1 to run")
	}
	type build struct {
		name string
		u    Upgrades
	}
	builds := []build{
		{"plain", Upgrades{}},
		{"speed5+boost1", Upgrades{Speed: 5, Boost: 1}},
		{"determ5+boost1", Upgrades{Determ: 5, Boost: 1}},
		{"boost3+salt3+food3", Upgrades{Boost: 3, Salt: 3, Food: 3}},
		{"boost5+salt1+food1", Upgrades{Boost: 5, Salt: 1, Food: 1}},
		{"shell3+salt3+food3", Upgrades{Shell: 3, Salt: 3, Food: 3}},
		{"all-2s+salt2+food2", Upgrades{Speed: 2, Determ: 2, Boost: 2, Shell: 2, Salt: 2, Food: 2}},
		{"speed3+boost3", Upgrades{Speed: 3, Boost: 3}},
	}
	unit := upgradeUnit(Settings{StartCoins: compStartCoins})
	price := func(u Upgrades) (c int) {
		for _, l := range []int{u.Speed, u.Determ, u.Boost, u.Shell, u.Salt, u.Food} {
			c += unit * l * (l + 1) / 2
		}
		return
	}
	const runs = 20000
	rnd := mrand.New(mrand.NewPCG(5, 6)).Float64

	fmt.Printf("\n%-20s %5s | %-18s | %-18s\n", "build", "coins", "vs 7 plain", "all 8 builds in one heat")
	solo := make([][2]float64, len(builds))
	mixed := make([][2]float64, len(builds))
	for i, b := range builds {
		for r := 0; r < runs; r++ {
			mods := make([]Upgrades, 8)
			mods[0] = b.u
			_, order, _ := simulateRaceWith(8, rnd, mods)
			for place, lane := range order {
				if lane == 0 {
					solo[i][1] += float64(seedPoints[place])
					if place == 0 {
						solo[i][0]++
					}
				}
			}
		}
	}
	for r := 0; r < runs; r++ {
		mods := make([]Upgrades, len(builds))
		for i, b := range builds {
			mods[i] = b.u
		}
		_, order, _ := simulateRaceWith(len(builds), rnd, mods)
		for place, lane := range order {
			mixed[lane][1] += float64(seedPoints[place])
			if place == 0 {
				mixed[lane][0]++
			}
		}
	}
	for i, b := range builds {
		fmt.Printf("%-20s %5d | win %5.1f%% %5.2f pts | win %5.1f%% %5.2f pts\n", b.name, price(b.u),
			solo[i][0]/runs*100, solo[i][1]/runs, mixed[i][0]/runs*100, mixed[i][1]/runs)
	}
}

// ---- automatic tuning ---------------------------------------------------------------

// archetypes are builds a player can afford (about 230 coins) over a 4-round game, where an item
// goes up at most one level per round.
var archetypes = []struct {
	name string
	u    Upgrades
}{
	{"speed", Upgrades{Speed: 4, Determ: 3, Boost: 2, Shell: 2, Salt: 1}},
	{"determ", Upgrades{Speed: 3, Determ: 4, Boost: 2, Shell: 2, Food: 1}},
	{"boost+attacks", Upgrades{Speed: 1, Boost: 4, Salt: 3, Food: 3}},
	{"shell+attacks", Upgrades{Boost: 1, Shell: 4, Salt: 3, Food: 3}},
	{"tank", Upgrades{Speed: 3, Determ: 3, Boost: 2, Shell: 3, Salt: 1, Food: 1}},
	{"spread", Upgrades{Speed: 3, Determ: 3, Boost: 2, Shell: 2, Salt: 2, Food: 2}},
}

type score struct {
	mixed, solo []float64 // per archetype: mean points in a shared heat; win rate against 7 plain snails
	cost        float64
}

func evaluate(runs int) score {
	rnd := mrand.New(mrand.NewPCG(7, 8)).Float64 // same dice every time, so comparisons are fair
	n := len(archetypes)
	sc := score{mixed: make([]float64, n), solo: make([]float64, n)}
	for r := 0; r < runs; r++ {
		mods := make([]Upgrades, n)
		for i, a := range archetypes {
			mods[i] = a.u
		}
		_, order, _ := simulateRaceWith(n, rnd, mods)
		for place, lane := range order {
			sc.mixed[lane] += float64(seedPoints[place]) / float64(runs)
		}
	}
	for i, a := range archetypes {
		for r := 0; r < runs; r++ {
			mods := make([]Upgrades, 8)
			mods[0] = a.u
			_, order, _ := simulateRaceWith(8, rnd, mods)
			if order[0] == 0 {
				sc.solo[i] += 1 / float64(runs)
			}
		}
	}
	// builds should be equally strong in a shared heat, and none should crush plain snails
	sc.cost = sd(sc.mixed) + 4*sd(sc.solo) + 3*math.Abs(mean(sc.solo)-0.55)
	return sc
}

func mean(xs []float64) (m float64) {
	for _, x := range xs {
		m += x / float64(len(xs))
	}
	return
}

func sd(xs []float64) float64 {
	m, v := mean(xs), 0.0
	for _, x := range xs {
		v += (x - m) * (x - m) / float64(len(xs))
	}
	return math.Sqrt(v)
}

func printScore(label string, sc score) {
	fmt.Printf("\n%s (cost %.3f)\n  %-15s %12s %12s\n", label, sc.cost, "build", "shared heat", "win vs plain")
	for i, a := range archetypes {
		fmt.Printf("  %-15s %8.2f pts %11.1f%%\n", a.name, sc.mixed[i], sc.solo[i]*100)
	}
}

// TestTune searches the tuning constants for the most even field of builds:
//
//	BALANCE=1 go test -run TestTune -v -timeout 30m
func TestTune(t *testing.T) {
	if os.Getenv("BALANCE") == "" {
		t.Skip("set BALANCE=1 to run")
	}
	const runs = 2500
	fields := []struct {
		name string
		p    *float64
	}{
		{"SpeedPer", &tune.SpeedPer}, {"DetermPer", &tune.DetermPer}, {"BoostPer", &tune.BoostPer},
		{"ShellBlock", &tune.ShellBlock}, {"ShellShort", &tune.ShellShort}, {"SaltSlow", &tune.SaltSlow},
		{"SaltFrames", &tune.SaltFrames}, {"FoodFrames", &tune.FoodFrames},
	}
	best := evaluate(runs)
	printScore("start", best)
	for pass, step := 0, 0.3; pass < 4; pass, step = pass+1, step*0.6 {
		for _, f := range fields {
			orig := *f.p
			for _, k := range []float64{1 + step, 1 / (1 + step)} {
				*f.p = orig * k
				if f.p == &tune.SaltSlow {
					*f.p = math.Min(0.95, *f.p)
				}
				if f.p == &tune.ShellBlock {
					*f.p = math.Min(0.15, *f.p) // 5 levels must stay under 75%
				}
				if sc := evaluate(runs); sc.cost < best.cost {
					best, orig = sc, *f.p
				}
			}
			*f.p = orig
		}
		fmt.Printf("pass %d: cost %.3f  %+v\n", pass+1, best.cost, tune)
	}
	printScore("tuned (re-measured with more runs)", evaluate(20000))
	fmt.Printf("\nfinal: %+v\n", tune)
}

// TestBalanceShellBuff compares Shell strength settings in a heavy-attack field and a typical one.
func TestBalanceShellBuff(t *testing.T) {
	if os.Getenv("BALANCE") == "" {
		t.Skip("set BALANCE=1 to run")
	}
	saved := tune
	defer func() { tune = saved }()
	const runs, lanes = 20000, 8
	field := func(attackers int, a Upgrades) []Upgrades {
		mods := make([]Upgrades, lanes)
		for j := 1; j <= attackers; j++ {
			mods[j] = a
		}
		return mods
	}
	pts := func(shell int, attackers int, a Upgrades) float64 {
		rnd := mrand.New(mrand.NewPCG(11, 12)).Float64
		total := 0.0
		for i := 0; i < runs; i++ {
			mods := field(attackers, a)
			mods[0].Shell = shell
			_, order, _ := simulateRaceWith(lanes, rnd, mods)
			for place, lane := range order {
				if lane == 0 {
					total += float64(seedPoints[place])
				}
			}
		}
		return total / runs
	}
	fmt.Printf("%-22s %-26s %s\n", "shell setting", "typical room (3 shooters)", "heavy room (7 shooters, max)")
	fmt.Printf("%-22s %-26s %s\n", "(block, shorten)", "pts gain shell 3 / 5", "pts gain shell 3 / 5")
	for _, c := range [][2]float64{{0.044, 0.076}, {0.07, 0.11}, {0.09, 0.13}} {
		tune.ShellBlock, tune.ShellShort = c[0], c[1]
		typ := Upgrades{Salt: 2, Food: 2}
		heavy := Upgrades{Salt: 3, Food: 3}
		t0, h0 := pts(0, 3, typ), pts(0, 7, heavy)
		fmt.Printf("%-22s %+.2f / %+.2f              %+.2f / %+.2f\n", fmt.Sprintf("%.3f, %.3f", c[0], c[1]),
			pts(3, 3, typ)-t0, pts(5, 3, typ)-t0, pts(3, 7, heavy)-h0, pts(5, 7, heavy)-h0)
	}
}
