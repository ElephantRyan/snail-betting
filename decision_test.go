package main

import (
	"fmt"
	"testing"
)

func TestSimilarNames(t *testing.T) {
	near := [][2]string{
		{"McDonalds", "McDonald's"},
		{"mcdonalds", "McDonald's"},
		{"Chick-fil-A", "Chick fil A"},
		{"Pizza", "Pizzas"},
		{"Chipotle", "Chipotle Mexican Grill"},
		{"Thai Palace", "Palace Thai"},
		{"Panera Bread", "Panera Bred"},
	}
	for _, c := range near {
		if !similar(c[0], c[1]) {
			t.Errorf("%q and %q should be flagged as close", c[0], c[1])
		}
	}
	apart := [][2]string{
		{"Wendys", "Subway"},
		{"Taco Bell", "Pizza Hut"},
		{"Sushi", "Burgers"},
		{"Cat", "Car"}, // too short for a typo to count
		{"🍕", "🍔"},
	}
	for _, c := range apart {
		if similar(c[0], c[1]) {
			t.Errorf("%q and %q should be treated as different", c[0], c[1])
		}
	}
}

func TestCleanOption(t *testing.T) {
	if got := cleanOption("  Joe's \t Diner\n"); got != "Joe's Diner" {
		t.Errorf("got %q", got)
	}
	if got := cleanOption("12345678901234567890123456789"); len([]rune(got)) != maxOptionRunes {
		t.Errorf("not capped: %q", got)
	}
}

func TestPlanHeatsAndRounds(t *testing.T) {
	for n := 2; n <= maxOptions; n++ {
		ids := make([]int, n)
		for i := range ids {
			ids[i] = i
		}
		seen, lo, hi := 0, n, 0
		for _, h := range planHeats(ids) {
			if len(h) > maxHeat || len(h) < 2 {
				t.Fatalf("n=%d heat of %d", n, len(h))
			}
			seen += len(h)
			lo, hi = min(lo, len(h)), max(hi, len(h))
		}
		if seen != n || hi-lo > 1 {
			t.Fatalf("n=%d split badly (seen %d, sizes %d..%d)", n, seen, lo, hi)
		}
	}
	for n, want := range map[int]int{2: 1, 8: 1, 9: 2, 16: 2, 17: 3, 32: 3, 33: 4, 64: 4} {
		if got := bracketRounds(n); got != want {
			t.Errorf("bracketRounds(%d)=%d want %d", n, got, want)
		}
	}
}

func decisionRoom(t *testing.T, names ...string) (*Room, *Player) {
	t.Helper()
	r := newRoom(Settings{Mode: modeDecision}, "TEST")
	host := r.addPlayer("Host")
	host.connected = true
	if r.start(host) != "" || r.phase != "snails" {
		t.Fatalf("phase %s", r.phase)
	}
	for _, n := range names {
		if near, err := r.addOption(host, n, true); near != "" || err != "" {
			t.Fatalf("add %q: near=%q err=%q", n, near, err)
		}
	}
	return r, host
}

func TestAddOptionRules(t *testing.T) {
	r, host := decisionRoom(t, "McDonalds")
	if _, err := r.addOption(host, "  MCDONALDS ", true); err == "" {
		t.Error("exact duplicate accepted, even with force")
	}
	near, err := r.addOption(host, "McDonald's", false)
	if near != "McDonalds" || err != "" || len(r.options) != 1 {
		t.Errorf("near=%q err=%q options=%d", near, err, len(r.options))
	}
	if near, err = r.addOption(host, "McDonald's", true); near != "" || err != "" || len(r.options) != 2 {
		t.Errorf("force add failed: near=%q err=%q options=%d", near, err, len(r.options))
	}
	if _, err = r.addOption(host, "   ", false); err == "" {
		t.Error("blank name accepted")
	}
	if err := r.beginBracket(host); err != "" {
		t.Errorf("two snails should be enough: %s", err)
	}
}

func TestOptionCap(t *testing.T) {
	r, host := decisionRoom(t)
	for i := 0; i < maxOptions; i++ {
		if _, err := r.addOption(host, fmt.Sprintf("snail %d", i), true); err != "" {
			t.Fatalf("option %d: %s", i, err)
		}
	}
	if _, err := r.addOption(host, "one too many", true); err == "" {
		t.Error("65th snail accepted")
	}
}

func TestFullBracketToStandings(t *testing.T) {
	for _, n := range []int{2, 5, 8, 9, 20, 33, 64} {
		names := make([]string, n)
		for i := range names {
			names[i] = fmt.Sprintf("Place number %d", i*1000+i)
		}
		r, host := decisionRoom(t, names...)
		if len(r.options) != n {
			t.Fatalf("n=%d: %d options added", n, len(r.options))
		}
		if r.beginBracket(host) != "" {
			t.Fatalf("n=%d: begin failed", n)
		}
		heats := 0
		for r.phase == "racing" {
			heats++
			r.finishHeat()
			if r.phase == "results" {
				res := r.bracket.result
				if res.Advance < 1 || res.Advance >= len(res.Order) {
					t.Fatalf("n=%d: advance %d of %d", n, res.Advance, len(res.Order))
				}
				r.nextHeat()
			}
		}
		if r.phase != "final" {
			t.Fatalf("n=%d: ended in %s", n, r.phase)
		}
		st := r.bracket.standings
		if len(st) != n {
			t.Fatalf("n=%d: %d standings", n, len(st))
		}
		seen := map[int]bool{}
		for i, row := range st {
			if row.Rank != i+1 || seen[row.Option] {
				t.Fatalf("n=%d: bad standings row %+v", n, row)
			}
			seen[row.Option] = true
		}
		if win := r.bracket.result.Order[0]; st[0].Option != win {
			t.Errorf("n=%d: winner of the final is not rank 1", n)
		}
		finalists := 0
		for _, row := range st {
			if row.Round == r.bracket.rounds {
				finalists++
			}
		}
		if finalists != len(r.bracket.result.Order) || finalists > maxHeat {
			t.Errorf("n=%d: %d finalists", n, finalists)
		}
		if n <= maxHeat && heats != 1 || n > maxHeat && heats < 2 {
			t.Errorf("n=%d: %d heats", n, heats)
		}
	}
}
