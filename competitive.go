package main

import (
	"math"
	mrand "math/rand/v2"
	"slices"
	"sort"
	"time"
)

// Competitive mode: every player owns a snail. Seeding rounds (a shop phase, then heats of up to
// maxHeat) hand out points; the seeds then run through the same elimination bracket as decision
// mode, with the top and bottom seeds sharing the first heat. Upgrades are bought only in the
// seeding shops; the snails race themselves, so nobody steers during a race.

const (
	modeCompetitive = "competitive"
	maxCompPlayers  = 16
	maxStatLevel    = 5
	maxAttackLevel  = 3   // shots fired per race
	compStartCoins  = 200 // fixed: prices scale from it, so it is not a room setting
	awardShare      = 2   // the top awardShare/awardOf of a heat's finishers win prize money
	awardOf         = 5
)

// seedPoints is what each finishing place in a seeding heat earns.
var seedPoints = [maxHeat]int{8, 7, 6, 5, 4, 3, 2, 1}

type Upgrades struct {
	Speed  int `json:"speed"`  // flat speed
	Determ int `json:"determ"` // gets faster as the race goes on
	Boost  int `json:"boost"`  // burst of speed after passing a snail
	Shell  int `json:"shell"`  // resists attacks
	Salt   int `json:"salt"`   // shots per race that slow a rival
	Food   int `json:"food"`   // shots per race that distract a rival
}

// slot returns the level for an item and the most it can reach.
func (u *Upgrades) slot(item string) (*int, int) {
	switch item {
	case "speed":
		return &u.Speed, maxStatLevel
	case "determ":
		return &u.Determ, maxStatLevel
	case "boost":
		return &u.Boost, maxStatLevel
	case "shell":
		return &u.Shell, maxStatLevel
	case "salt":
		return &u.Salt, maxAttackLevel
	case "food":
		return &u.Food, maxAttackLevel
	}
	return nil, 0
}

// prizePlaces is how many finishers in a heat of n win prize money: the top 40%, at least one.
func prizePlaces(n int) int { return min(len(placeWeights), max(1, n*awardShare/awardOf)) }

// prizeSplit divides a heat's purse (2 units per racer, paid by the house) among the prize places
// in the podium ratio; the rounding crumbs go to first place.
func prizeSplit(s Settings, n int) []int {
	places := prizePlaces(n)
	purse := n * 2 * upgradeUnit(s)
	total := 0
	for _, w := range placeWeights[:places] {
		total += w
	}
	out := make([]int, places)
	paid := 0
	for i := range out {
		out[i] = purse * placeWeights[i] / total
		paid += out[i]
	}
	out[0] += purse - paid
	return out
}

// shopAllowance is how many upgrades a player may buy in a seeding round (2, 3, 4, ...), and each
// upgrade can only go up one level per round.
func shopAllowance(round int) int { return round + 1 }

// upgradeUnit scales prices to the starting purse: level n costs unit*(n+1).
func upgradeUnit(s Settings) int { return max(10, s.StartCoins/20) }

// tuning holds the numbers that decide how strong each upgrade is. They are variables, not
// constants, so balance_test.go can search for good values.
type tuning struct {
	SpeedPer   float64 // speed gained per Speed level
	DetermPer  float64 // extra speed at the finish line per Determination level
	BoostPer   float64 // speed gained while boosting, per Boost level
	ShellBlock float64 // chance per Shell level that an attack is blocked outright
	ShellShort float64 // share of an attack's duration cut per Shell level
	SaltSlow   float64 // speed multiplier while salted
	SaltFrames float64
	FoodFrames float64
}

// Values found by TestTune (balance_test.go) so that the usual builds come out about even.
var tune = tuning{
	SpeedPer: 0.022, DetermPer: 0.033, BoostPer: 0.055,
	ShellBlock: 0.044, ShellShort: 0.076,
	SaltSlow: 0.36, SaltFrames: 115, FoodFrames: 37,
}

type raceEvent struct {
	T       int    `json:"t"` // frame the attack lands
	From    int    `json:"from"`
	To      int    `json:"to"`
	Kind    string `json:"kind"` // salt | food
	Blocked bool   `json:"blocked"`
	Dur     int    `json:"dur"` // frames the effect lasts (0 if the shell blocked it)
}

type shot struct {
	at, from int
	kind     string
}

// simulateRaceWith is simulateRace with per-lane upgrades (nil = everyone identical) and the
// attacks the snails fire at each other.
func simulateRaceWith(lanes int, rnd func() float64, mods []Upgrades) ([][]int, []int, []raceEvent) {
	mean := 1.0 / (fps * 14)
	pos, mood, crossed := make([]float64, lanes), make([]float64, lanes), make([]float64, lanes)
	for i := range crossed {
		crossed[i] = math.Inf(1)
	}
	slow, stun := make([]int, lanes), make([]int, lanes)
	boostLeft, boostCool, ahead := make([]int, lanes), make([]int, lanes), make([]int, lanes)

	var shots []shot
	for i, u := range mods {
		for k := 0; k < u.Salt; k++ {
			shots = append(shots, shot{45 + int(rnd()*300), i, "salt"})
		}
		for k := 0; k < u.Food; k++ {
			shots = append(shots, shot{45 + int(rnd()*300), i, "food"})
		}
	}
	var events []raceEvent

	frames := [][]int{make([]int, lanes)}
	for len(frames) < fps*60 {
		now := len(frames)
		for _, s := range shots {
			if s.at != now || lanes < 2 {
				continue
			}
			to := int(rnd() * float64(lanes-1))
			if to >= s.from {
				to++
			}
			shell := float64(mods[to].Shell)
			ev := raceEvent{T: now, From: s.from, To: to, Kind: s.kind, Blocked: rnd() < tune.ShellBlock*shell}
			if !ev.Blocked {
				base := tune.SaltFrames
				if s.kind == "food" {
					base = tune.FoodFrames
				}
				d := int(math.Round(base * (1 - tune.ShellShort*shell)))
				ev.Dur = d
				if s.kind == "salt" {
					slow[to] = max(slow[to], d)
				} else {
					stun[to] = max(stun[to], d)
				}
				boostLeft[s.from] = max(boostLeft[s.from], 20) // a landed hit sets off the attacker's Boost
			}
			events = append(events, ev)
		}

		allOut := true
		for i := range pos {
			prev := pos[i]
			mood[i] = math.Max(-1, math.Min(1, mood[i]*0.96+(rnd()-0.5)*0.5))
			mult := 1.0
			if mods != nil {
				u := mods[i]
				mult = 1 + tune.SpeedPer*float64(u.Speed) + tune.DetermPer*float64(u.Determ)*math.Min(1, pos[i])
				if boostLeft[i] > 0 {
					mult *= 1 + tune.BoostPer*float64(u.Boost)
					boostLeft[i]--
				}
				if slow[i] > 0 {
					mult *= tune.SaltSlow
					slow[i]--
				}
				if stun[i] > 0 {
					mult = 0
					stun[i]--
				}
				boostCool[i] = max(0, boostCool[i]-1)
			}
			pos[i] += mean * (0.7 + 0.6*rnd() + 0.5*mood[i]) * mult
			if math.IsInf(crossed[i], 1) && pos[i] >= 1 {
				// sub-frame crossing time, so two snails in the same frame still have an order
				crossed[i] = float64(len(frames)-1) + (1-prev)/(pos[i]-prev)
			}
			allOut = allOut && pos[i] >= exitProgress
		}
		if mods != nil {
			for i := range pos { // passing a snail sets off the boost
				n := 0
				for j := range pos {
					if pos[j] > pos[i] {
						n++
					}
				}
				if n < ahead[i] && mods[i].Boost > 0 && boostCool[i] == 0 {
					boostLeft[i], boostCool[i] = 20, 60
				}
				ahead[i] = n
			}
		}
		f := make([]int, lanes)
		for i, p := range pos {
			f[i] = int(math.Round(p * 1000))
		}
		frames = append(frames, f)
		if allOut {
			break
		}
	}
	order := make([]int, lanes)
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool {
		if crossed[order[a]] != crossed[order[b]] {
			return crossed[order[a]] < crossed[order[b]]
		}
		return pos[order[a]] > pos[order[b]]
	})
	return frames, order, events
}

func simulateRace(lanes int, rnd func() float64) ([][]int, []int) {
	frames, order, _ := simulateRaceWith(lanes, rnd, nil)
	return frames, order
}

// simulateHeat races the given option ids, with upgrades in competitive mode.
func (r *Room) simulateHeat(lanes []int) ([][]int, []int, []raceEvent) {
	var mods []Upgrades
	if r.settings.Mode == modeCompetitive {
		mods = make([]Upgrades, len(lanes))
		for i, id := range lanes {
			if q := r.playerByOpt(id); q != nil {
				mods[i] = q.upg
			}
		}
	}
	return simulateRaceWith(len(lanes), mrand.Float64, mods)
}

// ---- seeding + bracket planning -----------------------------------------------------

// seededHeats builds the first elimination round from the seed order (best first). With two heats
// the first takes the top and bottom seeds (1-4 and 13-16 of 16) and the second the middle.
func seededHeats(seeds []int) [][]int {
	plan := planHeats(seeds)
	if len(plan) != 2 {
		out := planHeats(shuffled(seeds))
		return out
	}
	n, first := len(seeds), len(plan[0])
	top := (first + 1) / 2
	bottom := first - top
	a := append(append([]int(nil), seeds[:top]...), seeds[n-bottom:]...)
	b := append([]int(nil), seeds[top:n-bottom]...)
	return [][]int{shuffled(a), shuffled(b)}
}

// ---- room actions (caller holds r.mu) -------------------------------------------------

type CompRow struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Lane   int    `json:"lane"`
	Place  int    `json:"place"`
	Points int    `json:"points"` // seeding heats only
	Prize  int    `json:"prize"`
}

// CompBet is a spectator's bet on the heat, settled when it finishes.
type CompBet struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Lane   int    `json:"lane"`
	Amount int    `json:"amount"`
	Payout int    `json:"payout"`
}

type Comp struct {
	stage  string // "seed" | "elim"
	round  int    // seeding round, 1-based
	heats  [][]int
	heat   int
	result []CompRow
	bets   []CompBet
}

func (r *Room) playerByOpt(id int) *Player {
	for _, p := range r.players {
		if p.optID == id {
			return p
		}
	}
	return nil
}

func (r *Room) startCompetitive() string {
	if len(r.players) < 2 {
		return "You need at least 2 players."
	}
	r.options, r.nextOptID, r.bracket = nil, 0, nil
	for _, p := range r.players {
		r.nextOptID++
		p.optID, p.points, p.upg = r.nextOptID, 0, Upgrades{}
		r.options = append(r.options, Option{p.optID, p.name, p.id})
	}
	r.comp = &Comp{stage: "seed"}
	r.startShop()
	return ""
}

func (r *Room) startShop() {
	c := r.comp
	c.round++
	c.heat, c.result, c.bets = 0, nil, nil
	r.round++
	r.phase = "shop"
	r.results, r.race = nil, nil
	ids := make([]int, len(r.players))
	for i, q := range r.players {
		ids[i] = q.optID
		q.bet, q.ready, q.bailout, q.bought = nil, false, false, nil
		if q.coins <= 0 {
			q.coins, q.bailout = bailoutCoins, true
		}
	}
	c.heats = planHeats(shuffled(ids))
	r.clearTimer()
	r.deadline = 0
	if s := r.settings.BetSeconds; s > 0 {
		r.deadline = time.Now().Add(time.Duration(s) * time.Second).UnixMilli()
		r.setTimer(time.Duration(s)*time.Second, r.compCloseShop)
	}
	r.broadcast()
}

func (r *Room) compCloseShop() {
	if r.phase != "shop" {
		return
	}
	r.comp.heat = 0
	r.readyHeat()
}

func (r *Room) laneLabels(lanes []int) []string {
	labels := make([]string, len(lanes))
	for i, id := range lanes {
		labels[i] = r.option(id).Name
	}
	return labels
}

func (r *Room) compStartHeat() {
	c := r.comp
	lanes := c.heats[c.heat]
	c.result, c.bets = nil, nil
	r.round++
	r.phase = "racing"
	r.deadline = 0
	frames, order, events := r.simulateHeat(lanes)
	r.race = &raceData{frames, order, time.Now().UnixMilli() + countdownMs, r.laneLabels(lanes), events}
	raceDur := countdownMs*time.Millisecond + time.Duration(len(frames))*time.Second/fps + postRaceMs*time.Millisecond
	r.setTimer(raceDur, r.compFinishHeat)
	r.broadcast()
	for _, q := range r.players {
		r.sendRace(q)
	}
}

func (r *Room) compFinishHeat() {
	c := r.comp
	if r.phase != "racing" || c == nil || c.stage != "seed" {
		return
	}
	r.settleHeat(c.heats[c.heat], r.race.order, true)
	r.phase = "results"
	r.broadcast()
}

// settleHeat pays the prize money to the racers who finished in the top 40% (and, while seeding,
// hands out the points), then settles the spectators' bets by the usual podium split.
func (r *Room) settleHeat(lanes, order []int, seeding bool) {
	c := r.comp
	prizes := prizeSplit(r.settings, len(lanes))
	c.result = make([]CompRow, 0, len(lanes))
	for place, lane := range order {
		q := r.playerByOpt(lanes[lane])
		row := CompRow{ID: q.id, Name: q.name, Lane: lane, Place: place + 1}
		if seeding {
			row.Points = seedPoints[place]
			q.points += row.Points
		}
		if place < len(prizes) {
			row.Prize = prizes[place]
			q.coins += row.Prize
		}
		c.result = append(c.result, row)
	}
	var bets []stake
	for _, q := range r.players {
		if q.bet != nil {
			bets = append(bets, stake{q.id, q.bet.Snail, q.bet.Amount})
		}
	}
	payouts, _, _ := settle(bets, order)
	c.bets = nil
	for _, b := range bets {
		q := r.find(b.id)
		q.coins += payouts[b.id] - b.amount
		c.bets = append(c.bets, CompBet{q.id, q.name, b.snail, b.amount, payouts[b.id]})
	}
}

func (r *Room) compNext() string {
	c := r.comp
	switch {
	case c.heat+1 < len(c.heats):
		c.heat++
		r.readyHeat()
	case c.round < r.settings.Rounds:
		r.startShop()
	default:
		r.beginElimination()
	}
	return ""
}

// seedOrder ranks the players by seeding points, then coins, then luck.
func (r *Room) seedOrder() []*Player {
	order := append([]*Player(nil), r.players...)
	mrand.Shuffle(len(order), func(i, j int) { order[i], order[j] = order[j], order[i] })
	sort.SliceStable(order, func(a, b int) bool {
		if order[a].points != order[b].points {
			return order[a].points > order[b].points
		}
		return order[a].coins > order[b].coins
	})
	return order
}

func (r *Room) beginElimination() {
	order := r.seedOrder()
	seeds := make([]int, len(order))
	for i, q := range order {
		q.seed = i + 1
		seeds[i] = q.optID
	}
	r.comp.stage = "elim"
	r.bracket = &Bracket{round: 1, rounds: bracketRounds(len(seeds)), out: map[int]Elim{}, heats: seededHeats(seeds)}
	r.readyHeat()
}

// buy raises one of the player's upgrades by a level; only the seeding shops sell them.
func (r *Room) buy(p *Player, item string) string {
	if r.settings.Mode != modeCompetitive || r.phase != "shop" {
		return "The shop is closed."
	}
	level, top := p.upg.slot(item)
	if level == nil {
		return "Unknown upgrade."
	}
	if *level >= top {
		return "That upgrade is maxed out."
	}
	if slices.Contains(p.bought, item) {
		return "You can only upgrade each item once per round."
	}
	if len(p.bought) >= shopAllowance(r.comp.round) {
		return "You're out of upgrades for this round."
	}
	cost := upgradeUnit(r.settings) * (*level + 1)
	if cost > p.coins {
		return "Not enough coins."
	}
	p.coins -= cost
	*level++
	p.bought = append(p.bought, item)
	r.broadcast()
	return ""
}

// ready says the player is done shopping, or (elimination) done betting; spectators who press it
// without having bet are simply skipping the heat.
func (r *Room) ready(p *Player) string {
	if r.settings.Mode != modeCompetitive || (r.phase != "shop" && r.phase != "betting") {
		return "Nothing to get ready for."
	}
	if r.phase == "betting" {
		if r.isRacing(p) {
			return ""
		}
		p.bet = nil
	}
	p.ready = true
	r.broadcast()
	r.maybeCloseBetting()
	return ""
}

// heatIDs are the snails (option ids) in the heat being set up or run, seeding or elimination.
func (r *Room) heatIDs() []int {
	c := r.comp
	switch {
	case c == nil:
		return nil
	case c.stage == "elim":
		if r.bracket == nil {
			return nil
		}
		return r.bracket.heats[r.bracket.heat]
	case c.heat < len(c.heats):
		return c.heats[c.heat]
	}
	return nil
}

// isRacing reports whether the player's snail is in the heat being set up or run. Everyone else
// can bet on it.
func (r *Room) isRacing(p *Player) bool {
	return slices.Contains(r.heatIDs(), p.optID)
}

// beginHeat runs the heat that has been set up.
func (r *Room) beginHeat() {
	if r.comp.stage == "seed" {
		r.compStartHeat()
	} else {
		r.startHeat()
	}
}

// readyHeat starts a heat (seeding or elimination), after a betting phase if anyone is sitting it out.
func (r *Room) readyHeat() {
	if r.settings.Mode != modeCompetitive {
		r.startHeat()
		return
	}
	r.comp.result, r.comp.bets = nil, nil
	spectators := false
	for _, q := range r.players {
		q.bet, q.ready = nil, false
		spectators = spectators || (q.connected && !r.isRacing(q))
	}
	if !spectators {
		r.beginHeat()
		return
	}
	r.round++
	r.phase = "betting"
	r.results, r.race = nil, nil
	r.clearTimer()
	r.deadline = 0
	if s := r.settings.BetSeconds; s > 0 {
		r.deadline = time.Now().Add(time.Duration(s) * time.Second).UnixMilli()
		r.setTimer(time.Duration(s)*time.Second, r.closeRound)
	}
	r.broadcast()
}

// ---- wire view ----------------------------------------------------------------------

type compView struct {
	Stage  string    `json:"stage"`
	Round  int       `json:"round"`
	Rounds int       `json:"rounds"`
	Heat   int       `json:"heat"`
	Heats  int       `json:"heats"`
	Unit   int       `json:"unit"`
	Allow  int       `json:"allow"` // upgrades each player may buy this seeding round
	Lanes  []string  `json:"lanes"` // player ids in lane order for the current heat
	Result []CompRow `json:"result"`
	Bets   []CompBet `json:"bets"`
}

func (r *Room) compView() *compView {
	c := r.comp
	if c == nil {
		return nil
	}
	v := &compView{Stage: c.stage, Round: c.round, Rounds: r.settings.Rounds, Unit: upgradeUnit(r.settings), Allow: shopAllowance(c.round), Result: c.result, Bets: c.bets}
	heats, heat := c.heats, c.heat
	if c.stage == "elim" {
		heats, heat = r.bracket.heats, r.bracket.heat
	}
	v.Heat, v.Heats = heat+1, len(heats)
	if heat < len(heats) {
		for _, id := range heats[heat] {
			if q := r.playerByOpt(id); q != nil {
				v.Lanes = append(v.Lanes, q.id)
			}
		}
	}
	return v
}
