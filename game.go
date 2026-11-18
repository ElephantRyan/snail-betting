package main

import (
	"crypto/rand"
	"encoding/hex"
	"math"
	mrand "math/rand/v2"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	modeClassic  = "classic"
	modeDecision = "decision"
)

const (
	snailCount   = 6
	fps          = 30
	countdownMs  = 3000
	postRaceMs   = 4000 // podium drop-in + a beat before the results panel
	exitProgress = 1.1  // progress at which a snail is fully off screen
	bailoutCoins = 50
	maxPlayers   = 40
	hostGrace    = 20 * time.Second
	codeLetters  = "ABCDEFGHJKLMNPQRSTUVWXYZ"
)

type Settings struct {
	Rounds     int    `json:"rounds"`
	StartCoins int    `json:"startCoins"`
	BetSeconds int    `json:"betSeconds"` // 0 = no timer
	Mode       string `json:"mode"`       // modeClassic | modeDecision
}

type Bet struct {
	Snail  int `json:"snail"`
	Amount int `json:"amount"`
}

type ResultRow struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Snail  int    `json:"snail"`
	Amount int    `json:"amount"`
	Payout int    `json:"payout"`
	Place  int    `json:"place"` // 1-3 if the snail finished in the money, else 0
}

type Results struct {
	Winner   int         `json:"winner"`
	Order    []int       `json:"order"` // lanes, first to last
	Pool     int         `json:"pool"`
	Refunded bool        `json:"refunded"`
	Rows     []ResultRow `json:"rows"`
	Round    int         `json:"round"`
}

type Player struct {
	id, token, name string
	coins           int
	client          *client
	connected       bool
	bet             *Bet
	ready, bailout  bool
}

type raceData struct {
	frames  [][]int
	order   []int // lanes by finishing position; order[0] is the winner
	startAt int64
	labels  []string // decision mode: the name on each lane
}

type Room struct {
	mu       sync.Mutex
	code     string
	settings Settings
	players  []*Player // join order
	phase    string    // lobby | betting | racing | results | final
	round    int
	hostID   string
	deadline int64
	race     *raceData
	results  *Results
	gen      int // bumped whenever a phase timer is replaced, so stale timers do nothing
	timer    *time.Timer
	hostTmr  *time.Timer
	touched  time.Time

	// decision mode
	options   []Option
	nextOptID int
	bracket   *Bracket
}

// ---- helpers --------------------------------------------------------------

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func newCode(taken func(string) bool) string {
	for {
		b := make([]byte, 6)
		for i := range b {
			b[i] = codeLetters[mrand.IntN(len(codeLetters))]
		}
		if c := string(b); !taken(c) {
			return c
		}
	}
}

var nameJunk = regexp.MustCompile(`[^\p{L}\p{N} ._'-]`)

func cleanName(raw string) string {
	s := strings.Join(strings.Fields(nameJunk.ReplaceAllString(raw, "")), " ")
	if r := []rune(s); len(r) > 16 {
		s = strings.TrimSpace(string(r[:16]))
	}
	return s
}

// "Sam" -> "Sam 2" -> "Sam 3" when the name is already taken (case-insensitive)
func uniqueName(name string, taken []string) string {
	lower := map[string]bool{}
	for _, t := range taken {
		lower[strings.ToLower(t)] = true
	}
	if !lower[strings.ToLower(name)] {
		return name
	}
	base := []rune(name)
	if len(base) > 13 {
		base = base[:13]
	}
	for n := 2; ; n++ {
		c := string(base) + " " + strconv.Itoa(n)
		if !lower[strings.ToLower(c)] {
			return c
		}
	}
}

func clampInt(v, lo, hi int) int { return max(lo, min(hi, v)) }

func cleanSettings(s Settings) Settings {
	mode := modeClassic
	if s.Mode == modeDecision {
		mode = modeDecision
	}
	return Settings{
		Rounds:     clampInt(s.Rounds, 1, 20),
		StartCoins: clampInt(s.StartCoins, 100, 100000),
		BetSeconds: clampInt(s.BetSeconds, 0, 180),
		Mode:       mode,
	}
}

// ---- race + payout logic --------------------------------------------------

// Every snail draws from the same distribution, so each has an equal chance.
// Returns positions per frame (ints, 1000 = finish line) plus the lanes in the order
// they crossed it. The race runs on until every snail has left the screen
// (exitProgress, which the client's camera is built around).
func simulateRace(lanes int, rnd func() float64) ([][]int, []int) {
	mean := 1.0 / (fps * 14)
	pos, mood, crossed := make([]float64, lanes), make([]float64, lanes), make([]float64, lanes)
	for i := range crossed {
		crossed[i] = math.Inf(1)
	}
	frames := [][]int{make([]int, lanes)}
	for len(frames) < fps*60 {
		allOut := true
		for i := range pos {
			prev := pos[i]
			mood[i] = math.Max(-1, math.Min(1, mood[i]*0.96+(rnd()-0.5)*0.5))
			pos[i] += mean * (0.7 + 0.6*rnd() + 0.5*mood[i])
			if math.IsInf(crossed[i], 1) && pos[i] >= 1 {
				// sub-frame crossing time, so two snails in the same frame still have an order
				crossed[i] = float64(len(frames)-1) + (1-prev)/(pos[i]-prev)
			}
			allOut = allOut && pos[i] >= exitProgress
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
	return frames, order
}

type stake struct {
	id            string
	snail, amount int
}

// placeWeights is each podium place's share of the pool (1st, 2nd, 3rd).
var placeWeights = [...]int{60, 25, 15}

// Parimutuel with a podium: the pool is split across the top three snails by
// placeWeights, and each slice is shared among that snail's backers in
// proportion to their stake. A place nobody backed is dropped and its weight is
// spread over the places that were backed. Nobody backed the podium -> everyone
// is refunded. Returns id -> payout (stake included).
func settle(bets []stake, order []int) (payouts map[string]int, pool int, refunded bool) {
	payouts = map[string]int{}
	for _, b := range bets {
		pool += b.amount
	}
	if pool == 0 {
		return
	}
	podium := order[:min(len(order), len(placeWeights))]
	laneStake := map[int]int{}
	totalWeight := 0
	for place, lane := range podium {
		for _, b := range bets {
			if b.snail == lane {
				laneStake[lane] += b.amount
			}
		}
		if laneStake[lane] > 0 {
			totalWeight += placeWeights[place]
		}
	}
	if totalWeight == 0 {
		for _, b := range bets {
			payouts[b.id] = b.amount
		}
		return payouts, pool, true
	}
	paid, top := 0, -1
	for place, lane := range podium {
		if laneStake[lane] == 0 {
			continue
		}
		slice := pool * placeWeights[place] / totalWeight
		for i, b := range bets {
			if b.snail != lane {
				continue
			}
			share := b.amount * slice / laneStake[lane]
			payouts[b.id] += share
			paid += share
			if top < 0 || b.amount > bets[top].amount {
				top = i
			}
		}
	}
	// rounding crumbs go to the biggest podium stake so the pool is fully paid out
	payouts[bets[top].id] += pool - paid
	return payouts, pool, false
}

// ---- room ------------------------------------------------------------------
// Methods below expect r.mu to be held by the caller unless noted.

func newRoom(s Settings, code string) *Room {
	return &Room{code: code, settings: cleanSettings(s), phase: "lobby", touched: time.Now()}
}

func (r *Room) find(id string) *Player {
	for _, p := range r.players {
		if p.id == id {
			return p
		}
	}
	return nil
}

func (r *Room) addPlayer(rawName string) *Player {
	base := cleanName(rawName)
	if base == "" {
		base = "Snail Fan"
	}
	names := make([]string, len(r.players))
	for i, p := range r.players {
		names[i] = p.name
	}
	p := &Player{
		id: randHex(4), token: randHex(16), name: uniqueName(base, names),
		coins: r.settings.StartCoins,
	}
	r.players = append(r.players, p)
	if r.hostID == "" {
		r.hostID = p.id
	}
	return p
}

func (r *Room) byToken(token string) *Player {
	for _, p := range r.players {
		if p.token == token {
			return p
		}
	}
	return nil
}

// after the game starts, an exact name match on a dropped player reclaims the seat
func (r *Room) byDroppedName(name string) *Player {
	want := strings.ToLower(cleanName(name))
	for _, p := range r.players {
		if !p.connected && strings.ToLower(p.name) == want {
			return p
		}
	}
	return nil
}

func (r *Room) attach(p *Player, c *client) {
	if p.client != nil && p.client != c {
		p.client.close()
	}
	p.client, p.connected = c, true
	if r.hostID == p.id && r.hostTmr != nil {
		r.hostTmr.Stop()
	}
}

func (r *Room) detach(p *Player, c *client) {
	if p.client != c { // an older socket closing after a reconnect
		return
	}
	p.client, p.connected = nil, false
	if r.phase == "lobby" && r.hostID != p.id {
		r.removePlayer(p.id)
	} else if r.phase == "betting" {
		r.maybeCloseBetting()
	}
	if r.hostID == p.id {
		if r.hostTmr != nil {
			r.hostTmr.Stop()
		}
		r.hostTmr = time.AfterFunc(hostGrace, func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.transferHost()
		})
	}
	r.broadcast()
}

func (r *Room) removePlayer(id string) {
	for i, p := range r.players {
		if p.id == id {
			r.players = append(r.players[:i], r.players[i+1:]...)
			return
		}
	}
}

func (r *Room) transferHost() {
	if h := r.find(r.hostID); h != nil && h.connected {
		return
	}
	for _, p := range r.players {
		if p.connected {
			r.hostID = p.id
			r.broadcast()
			return
		}
	}
}

func (r *Room) pools() (pools, backers [snailCount]int) {
	for _, p := range r.players {
		if p.bet != nil {
			pools[p.bet.Snail] += p.bet.Amount
			backers[p.bet.Snail]++
		}
	}
	return
}

type playerView struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Coins     int    `json:"coins"`
	Connected bool   `json:"connected"`
	Ready     bool   `json:"ready"`
	Bailout   bool   `json:"bailout"`
}

type stateMsg struct {
	Type      string          `json:"type"`
	ServerNow int64           `json:"serverNow"`
	Code      string          `json:"code"`
	Phase     string          `json:"phase"`
	Round     int             `json:"round"`
	Settings  Settings        `json:"settings"`
	Deadline  *int64          `json:"deadline"`
	HostID    string          `json:"hostId"`
	Me        string          `json:"me"`
	Players   []playerView    `json:"players"`
	Pools     [snailCount]int `json:"pools"`
	Backers   [snailCount]int `json:"backers"`
	MyBet     *Bet            `json:"myBet"`
	Results   *Results        `json:"results"`
	Decision  *decisionView   `json:"decision,omitempty"`
}

type raceMsg struct {
	Type      string   `json:"type"`
	ServerNow int64    `json:"serverNow"`
	StartAt   int64    `json:"startAt"`
	FPS       int      `json:"fps"`
	Frames    [][]int  `json:"frames"`
	Order     []int    `json:"order"`
	Labels    []string `json:"labels,omitempty"`
}

func (r *Room) view(p *Player) stateMsg {
	pools, backers := r.pools()
	m := stateMsg{
		Type: "state", ServerNow: time.Now().UnixMilli(), Code: r.code, Phase: r.phase,
		Round: r.round, Settings: r.settings, HostID: r.hostID, Me: p.id,
		Pools: pools, Backers: backers, MyBet: p.bet, Results: r.results,
		Players: make([]playerView, len(r.players)),
	}
	if r.deadline > 0 {
		m.Deadline = &r.deadline
	}
	for i, q := range r.players {
		m.Players[i] = playerView{q.id, q.name, q.coins, q.connected, q.ready, q.bailout}
	}
	if r.settings.Mode == modeDecision {
		m.Decision = r.decisionView()
	}
	return m
}

func (r *Room) broadcast() {
	r.touched = time.Now()
	for _, p := range r.players {
		if p.client != nil {
			p.client.sendJSON(r.view(p))
		}
	}
}

func (r *Room) sendRace(p *Player) {
	if r.race == nil || p.client == nil {
		return
	}
	p.client.sendJSON(raceMsg{"race", time.Now().UnixMilli(), r.race.startAt, fps, r.race.frames, r.race.order, r.race.labels})
}

func (r *Room) setTimer(d time.Duration, fn func()) {
	if r.timer != nil {
		r.timer.Stop()
	}
	r.gen++
	gen := r.gen
	r.timer = time.AfterFunc(d, func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.gen == gen {
			fn()
		}
	})
}

func (r *Room) clearTimer() {
	if r.timer != nil {
		r.timer.Stop()
	}
	r.gen++
}

// ---- host actions ------------------------------------------------------------

func (r *Room) start(p *Player) string {
	if p.id != r.hostID || r.phase != "lobby" {
		return "Only the host can start from the lobby."
	}
	if r.settings.Mode == modeDecision {
		r.phase = "snails"
		r.broadcast()
		return ""
	}
	r.startBetting()
	return ""
}

func (r *Room) startBetting() {
	r.round++
	r.phase = "betting"
	r.results, r.race = nil, nil
	for _, q := range r.players {
		q.bet, q.ready, q.bailout = nil, false, false
		if q.coins <= 0 {
			q.coins, q.bailout = bailoutCoins, true
		}
	}
	r.clearTimer()
	r.deadline = 0
	if s := r.settings.BetSeconds; s > 0 {
		r.deadline = time.Now().Add(time.Duration(s) * time.Second).UnixMilli()
		r.setTimer(time.Duration(s)*time.Second, r.closeBetting)
	}
	r.broadcast()
}

func (r *Room) maybeCloseBetting() {
	if r.phase != "betting" {
		return
	}
	live := 0
	for _, q := range r.players {
		if q.connected {
			live++
			if !q.ready {
				return
			}
		}
	}
	if live > 0 {
		r.closeBetting()
	}
}

func (r *Room) closeBetting() {
	if r.phase != "betting" {
		return
	}
	r.phase = "racing"
	r.deadline = 0
	frames, order := simulateRace(snailCount, mrand.Float64)
	r.race = &raceData{frames, order, time.Now().UnixMilli() + countdownMs, nil}
	raceDur := countdownMs*time.Millisecond + time.Duration(len(frames))*time.Second/fps + postRaceMs*time.Millisecond
	r.setTimer(raceDur, r.finishRace)
	r.broadcast()
	for _, q := range r.players {
		r.sendRace(q)
	}
}

func (r *Room) finishRace() {
	if r.phase != "racing" {
		return
	}
	var bets []stake
	for _, q := range r.players {
		if q.bet != nil {
			bets = append(bets, stake{q.id, q.bet.Snail, q.bet.Amount})
		}
	}
	payouts, pool, refunded := settle(bets, r.race.order)
	rows := []ResultRow{}
	for _, b := range bets {
		q := r.find(b.id)
		pay := payouts[b.id]
		q.coins += pay - b.amount
		place := 0
		for i, lane := range r.race.order[:len(placeWeights)] {
			if lane == b.snail {
				place = i + 1
			}
		}
		rows = append(rows, ResultRow{q.id, q.name, b.snail, b.amount, pay, place})
	}
	r.results = &Results{r.race.order[0], r.race.order, pool, refunded, rows, r.round}
	r.phase = "results"
	r.broadcast()
}

func (r *Room) next(p *Player) string {
	if p.id != r.hostID || r.phase != "results" {
		return "Only the host can continue."
	}
	if r.settings.Mode == modeDecision {
		r.nextHeat()
		return ""
	}
	if r.round >= r.settings.Rounds {
		r.phase = "final"
		r.broadcast()
	} else {
		r.startBetting()
	}
	return ""
}

func (r *Room) rematch(p *Player) string {
	if p.id != r.hostID || r.phase != "final" {
		return "Only the host can start a rematch."
	}
	r.phase, r.round = "lobby", 0
	r.results, r.race = nil, nil
	r.options, r.bracket = nil, nil
	kept := r.players[:0]
	for _, q := range r.players {
		if !q.connected {
			continue
		}
		q.coins, q.bet, q.ready, q.bailout = r.settings.StartCoins, nil, false, false
		kept = append(kept, q)
	}
	r.players = kept
	r.broadcast()
	return ""
}

func (r *Room) forceClose(p *Player) string {
	if p.id != r.hostID || r.phase != "betting" {
		return "Only the host can close betting."
	}
	r.closeBetting()
	return ""
}

// ---- player actions ----------------------------------------------------------

func (r *Room) placeBet(p *Player, snail, amount int) string {
	if r.phase != "betting" {
		return "Betting is closed."
	}
	if snail < 0 || snail >= snailCount {
		return "Pick a snail."
	}
	if amount < 1 || amount > p.coins {
		return "Bet between 1 and " + strconv.Itoa(p.coins) + "."
	}
	p.bet, p.ready = &Bet{snail, amount}, true
	r.broadcast()
	r.maybeCloseBetting()
	return ""
}
