package main

import (
	"math"
	mrand "math/rand/v2"
	"sort"
	"strings"
	"time"
	"unicode"
)

// Decision mode: players add options (each one is a snail), the snails race in heats of at
// most maxHeat, the top advancePerHeat of every heat move on, and the last heat is the final.

const (
	maxHeat        = 8
	advancePerHeat = 4
	maxOptions     = 64
	minOptions     = 2
	maxOptionRunes = 24
)

type Option struct {
	ID   int
	Name string
	By   string // player id
}

type Elim struct{ Round, Place, Size int }

type HeatResult struct {
	Order   []int `json:"order"` // option ids, first to last
	Advance int   `json:"advance"`
	Final   bool  `json:"final"`
}

type standRow struct {
	Option int `json:"option"`
	Rank   int `json:"rank"`
	Round  int `json:"round"` // bracket round they last raced in (== rounds for finalists)
	Place  int `json:"place"` // finishing place in that heat
	Size   int `json:"size"`  // snails in that heat
}

type Bracket struct {
	round, rounds int
	heats         [][]int // option ids per heat for the current round
	heat          int
	advanced      []int // option ids that have made it through so far this round
	out           map[int]Elim
	result        *HeatResult // the heat that just finished, until the next one starts
	standings     []standRow  // set once the final is done
}

// ---- option names -----------------------------------------------------------------

// cleanOption trims, collapses whitespace, drops control characters and caps the length.
func cleanOption(raw string) string {
	s := strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, raw)), " ")
	if r := []rune(s); len(r) > maxOptionRunes {
		s = strings.TrimSpace(string(r[:maxOptionRunes]))
	}
	return s
}

func exactKey(s string) string { return strings.ToLower(strings.Join(strings.Fields(s), " ")) }

// foldKey keeps only lower-case letters and digits, so "McDonald's" and "mc donalds" match.
func foldKey(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func sortedTokens(s string) string {
	words := strings.Fields(strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			return unicode.ToLower(r)
		}
		return ' '
	}, s))
	sort.Strings(words)
	return strings.Join(words, " ")
}

func levenshtein(a, b []rune) int {
	prev := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur := make([]int, len(b)+1)
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev = cur
	}
	return prev[len(b)]
}

// similar reports whether two (differently spelled) names are probably the same option:
// the same letters ignoring case/spacing/punctuation, a small typo, one name inside the
// other ("Chipotle" / "Chipotle Mexican Grill"), or the same words reordered.
func similar(a, b string) bool {
	fa, fb := foldKey(a), foldKey(b)
	if fa == "" || fb == "" {
		return false
	}
	if fa == fb {
		return true
	}
	ra, rb := []rune(fa), []rune(fb)
	shortest := min(len(ra), len(rb))
	tol := 0
	if shortest >= 4 {
		tol = 1
	}
	if shortest >= 10 {
		tol = 2
	}
	if tol > 0 && levenshtein(ra, rb) <= tol {
		return true
	}
	if shortest >= 4 && (strings.Contains(fa, fb) || strings.Contains(fb, fa)) {
		return true
	}
	return sortedTokens(a) == sortedTokens(b)
}

// ---- bracket planning ---------------------------------------------------------------

// planHeats splits ids into the fewest heats of at most maxHeat, as evenly as possible.
func planHeats(ids []int) [][]int {
	heats := (len(ids) + maxHeat - 1) / maxHeat
	base, extra := len(ids)/heats, len(ids)%heats
	out := make([][]int, 0, heats)
	at := 0
	for h := 0; h < heats; h++ {
		size := base
		if h < extra {
			size++
		}
		out = append(out, ids[at:at+size])
		at += size
	}
	return out
}

func advanceCount(size int) int { return min(advancePerHeat, size-1) }

// bracketRounds is how many rounds (including the final) n snails need.
func bracketRounds(n int) int {
	rounds := 1
	for n > maxHeat {
		heats := (n + maxHeat - 1) / maxHeat
		base, extra := n/heats, n%heats
		next := 0
		for h := 0; h < heats; h++ {
			size := base
			if h < extra {
				size++
			}
			next += advanceCount(size)
		}
		n = next
		rounds++
	}
	return rounds
}

func shuffled(ids []int) []int {
	out := append([]int(nil), ids...)
	mrand.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	return out
}

// ---- room actions (caller holds r.mu) ------------------------------------------------

func (r *Room) option(id int) *Option {
	for i := range r.options {
		if r.options[i].ID == id {
			return &r.options[i]
		}
	}
	return nil
}

// addOption returns a non-empty similarTo (and adds nothing) when the name is a close match
// for an existing snail and force is false.
func (r *Room) addOption(p *Player, raw string, force bool) (similarTo, err string) {
	if r.settings.Mode != modeDecision || r.phase != "snails" {
		return "", "Snails can only be added before the racing starts."
	}
	name := cleanOption(raw)
	if name == "" {
		return "", "Type a name for the snail."
	}
	if len(r.options) >= maxOptions {
		return "", "That's the maximum of 64 snails."
	}
	for _, o := range r.options {
		if exactKey(o.Name) == exactKey(name) {
			return "", "“" + o.Name + "” is already in the race."
		}
	}
	if !force {
		for _, o := range r.options {
			if similar(o.Name, name) {
				return o.Name, ""
			}
		}
	}
	r.nextOptID++
	r.options = append(r.options, Option{r.nextOptID, name, p.id})
	r.broadcast()
	return "", ""
}

func (r *Room) removeOption(p *Player, id int) string {
	if r.phase != "snails" {
		return "Snails can only be removed before the racing starts."
	}
	for i, o := range r.options {
		if o.ID != id {
			continue
		}
		if p.id != r.hostID && p.id != o.By {
			return "Only the host or whoever added a snail can remove it."
		}
		r.options = append(r.options[:i], r.options[i+1:]...)
		r.broadcast()
		return ""
	}
	return ""
}

func (r *Room) beginBracket(p *Player) string {
	if p.id != r.hostID || r.phase != "snails" {
		return "Only the host can start the racing."
	}
	if len(r.options) < minOptions {
		return "Add at least 2 snails first."
	}
	ids := make([]int, len(r.options))
	for i, o := range r.options {
		ids[i] = o.ID
	}
	r.bracket = &Bracket{
		round: 1, rounds: bracketRounds(len(ids)), out: map[int]Elim{},
		heats: planHeats(shuffled(ids)),
	}
	r.startHeat()
	return ""
}

func (r *Room) startHeat() {
	b := r.bracket
	lanes := b.heats[b.heat]
	labels := make([]string, len(lanes))
	for i, id := range lanes {
		labels[i] = r.option(id).Name
	}
	b.result = nil
	r.round++ // unique per heat; the client resets its track whenever this changes
	r.phase = "racing"
	r.deadline = 0
	frames, order, events := r.simulateHeat(lanes)
	r.race = &raceData{frames, order, time.Now().UnixMilli() + countdownMs, labels, events}
	raceDur := countdownMs*time.Millisecond + time.Duration(len(frames))*time.Second/fps + postRaceMs*time.Millisecond
	r.setTimer(raceDur, r.finishHeat)
	r.broadcast()
	for _, q := range r.players {
		r.sendRace(q)
	}
}

func (r *Room) finishHeat() {
	b := r.bracket
	if r.phase != "racing" || b == nil {
		return
	}
	lanes := b.heats[b.heat]
	if r.comp != nil {
		r.settleHeat(lanes, r.race.order, false)
	}
	ranked := make([]int, len(lanes)) // option ids, first to last
	for i, lane := range r.race.order {
		ranked[i] = lanes[lane]
	}
	final := len(b.heats) == 1
	b.result = &HeatResult{Order: ranked, Final: final}
	if final {
		b.standings = b.rank(ranked)
		r.phase = "final"
		r.broadcast()
		return
	}
	adv := advanceCount(len(ranked))
	b.result.Advance = adv
	b.advanced = append(b.advanced, ranked[:adv]...)
	for i := adv; i < len(ranked); i++ {
		b.out[ranked[i]] = Elim{b.round, i + 1, len(ranked)}
	}
	r.phase = "results"
	r.broadcast()
}

// rank orders every snail: the finalists as they finished, then the rest by how late they
// went out (and, within a round, how close to the front of their heat they finished).
func (b *Bracket) rank(final []int) []standRow {
	rows := make([]standRow, 0, len(final)+len(b.out))
	for i, id := range final {
		rows = append(rows, standRow{id, i + 1, b.round, i + 1, len(final)})
	}
	type out struct {
		id int
		e  Elim
	}
	var rest []out
	for id, e := range b.out {
		rest = append(rest, out{id, e})
	}
	frac := func(e Elim) float64 { return float64(e.Place-1) / math.Max(1, float64(e.Size-1)) }
	sort.Slice(rest, func(i, j int) bool {
		a, c := rest[i], rest[j]
		if a.e.Round != c.e.Round {
			return a.e.Round > c.e.Round
		}
		if fa, fc := frac(a.e), frac(c.e); fa != fc {
			return fa < fc
		}
		return a.id < c.id
	})
	for _, o := range rest {
		rows = append(rows, standRow{o.id, len(rows) + 1, o.e.Round, o.e.Place, o.e.Size})
	}
	return rows
}

func (r *Room) nextHeat() {
	b := r.bracket
	if b == nil || r.phase != "results" {
		return
	}
	if b.heat+1 < len(b.heats) {
		b.heat++
	} else {
		b.round++
		b.heats = planHeats(shuffled(b.advanced))
		b.advanced, b.heat = nil, 0
	}
	r.readyHeat()
}

// ---- wire view ----------------------------------------------------------------------

type optionView struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	By     string `json:"by"`
	ByName string `json:"byName"`
}

type decisionView struct {
	Options   []optionView `json:"options"`
	Round     int          `json:"round"`
	Rounds    int          `json:"rounds"`
	Heat      int          `json:"heat"`
	Heats     int          `json:"heats"`
	Lanes     []int        `json:"lanes"` // option ids in lane order for the current heat
	Result    *HeatResult  `json:"result"`
	Standings []standRow   `json:"standings"`
}

func (r *Room) decisionView() *decisionView {
	v := &decisionView{Options: make([]optionView, len(r.options))}
	for i, o := range r.options {
		by := ""
		if q := r.find(o.By); q != nil {
			by = q.name
		}
		v.Options[i] = optionView{o.ID, o.Name, o.By, by}
	}
	if b := r.bracket; b != nil {
		v.Round, v.Rounds, v.Heat, v.Heats = b.round, b.rounds, b.heat+1, len(b.heats)
		v.Lanes, v.Result, v.Standings = b.heats[b.heat], b.result, b.standings
	}
	return v
}
