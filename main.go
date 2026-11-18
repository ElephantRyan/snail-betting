package main

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

//go:embed all:web/dist
var distFS embed.FS

var (
	roomsMu sync.Mutex
	rooms   = map[string]*Room{}
)

// client is one websocket connection. Writes go through a buffered channel so a slow
// phone can never stall a room.
type client struct {
	conn   *websocket.Conn
	out    chan []byte
	once   sync.Once
	cancel context.CancelFunc
	room   *Room
	player *Player
}

func (c *client) close() { c.once.Do(func() { c.cancel() }) }

func (c *client) sendJSON(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case c.out <- b:
	default:
		c.close() // hopelessly behind; it will rejoin with its token
	}
}

type inMsg struct {
	Type     string    `json:"type"`
	Name     string    `json:"name"`
	Code     string    `json:"code"`
	Token    string    `json:"token"`
	Settings *Settings `json:"settings"`
	Snail    int       `json:"snail"`
	Amount   int       `json:"amount"`
	ID       int       `json:"id"`    // removeSnail
	Force    bool      `json:"force"` // addSnail: add despite a close match
}

// bootID changes on every server start; clients reload when it does, so a restart never leaves
// a tab running the previous build.
var bootID = randHex(4)

func fail(c *client, msg string) { c.sendJSON(map[string]string{"type": "error", "message": msg}) }

// enter binds a connection to a player. Caller holds room.mu.
func enter(c *client, r *Room, p *Player) {
	c.room, c.player = r, p
	r.attach(p, c)
	c.sendJSON(map[string]string{"type": "joined", "code": r.code, "token": p.token, "id": p.id, "name": p.name})
	r.broadcast()
	if r.phase == "racing" {
		r.sendRace(p)
	}
}

func handleCreate(c *client, m inMsg) {
	s := Settings{Rounds: 5, StartCoins: 1000, BetSeconds: 30}
	if m.Settings != nil {
		s = *m.Settings
	}
	roomsMu.Lock()
	code := newCode(func(code string) bool { return rooms[code] != nil })
	r := newRoom(s, code)
	rooms[code] = r
	roomsMu.Unlock()

	r.mu.Lock()
	defer r.mu.Unlock()
	enter(c, r, r.addPlayer(m.Name))
}

func handleJoin(c *client, m inMsg) {
	roomsMu.Lock()
	r := rooms[strings.ToUpper(strings.TrimSpace(m.Code))]
	roomsMu.Unlock()
	if r == nil {
		fail(c, "No room with that code.")
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if m.Token != "" {
		if p := r.byToken(m.Token); p != nil {
			enter(c, r, p)
			return
		}
	}
	if r.phase == "lobby" || r.phase == "snails" { // decision mode lets late arrivals in while snails are being added
		if len(r.players) >= maxPlayers {
			fail(c, "This room is full.")
			return
		}
		enter(c, r, r.addPlayer(m.Name))
		return
	}
	if p := r.byDroppedName(m.Name); p != nil {
		enter(c, r, p)
		return
	}
	fail(c, "The game has already started. Use the exact name of a player who dropped to rejoin.")
}

func handleAction(c *client, m inMsg) {
	r, p := c.room, c.player
	r.mu.Lock()
	defer r.mu.Unlock()
	var err string
	switch m.Type {
	case "start":
		err = r.start(p)
	case "bet":
		err = r.placeBet(p, m.Snail, m.Amount)
	case "close":
		err = r.forceClose(p)
	case "next":
		err = r.next(p)
	case "rematch":
		err = r.rematch(p)
	case "addSnail":
		var near string
		if near, err = r.addOption(p, m.Name, m.Force); near != "" {
			c.sendJSON(map[string]string{"type": "similar", "name": cleanOption(m.Name), "match": near})
		}
	case "removeSnail":
		err = r.removeOption(p, m.ID)
	case "begin":
		err = r.beginBracket(p)
	}
	if err != "" {
		fail(c, err)
	}
}

func wsHandler(insecureOrigin bool) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		conn, err := websocket.Accept(w, req, &websocket.AcceptOptions{InsecureSkipVerify: insecureOrigin})
		if err != nil {
			return
		}
		conn.SetReadLimit(4096)
		ctx, cancel := context.WithCancel(req.Context())
		c := &client{conn: conn, out: make(chan []byte, 32), cancel: cancel}
		c.sendJSON(map[string]string{"type": "hello", "boot": bootID})
		defer func() {
			cancel()
			if c.room != nil {
				c.room.mu.Lock()
				c.room.detach(c.player, c)
				c.room.mu.Unlock()
			}
			conn.CloseNow()
		}()

		go func() { // writer
			for {
				select {
				case b := <-c.out:
					wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
					err := conn.Write(wctx, websocket.MessageText, b)
					wcancel()
					if err != nil {
						cancel()
						return
					}
				case <-ctx.Done():
					return
				}
			}
		}()
		go func() { // keepalive, so proxies don't drop idle sockets
			t := time.NewTicker(25 * time.Second)
			defer t.Stop()
			for {
				select {
				case <-t.C:
					pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
					err := conn.Ping(pctx)
					pcancel()
					if err != nil {
						cancel()
						return
					}
				case <-ctx.Done():
					return
				}
			}
		}()

		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var m inMsg
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			switch {
			case c.room == nil && m.Type == "create":
				handleCreate(c, m)
			case c.room == nil && m.Type == "join":
				handleJoin(c, m)
			case c.room != nil:
				handleAction(c, m)
			}
		}
	}
}

func sweepRooms(maxIdle time.Duration) {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	for code, r := range rooms {
		r.mu.Lock()
		if time.Since(r.touched) > maxIdle {
			r.clearTimer()
			delete(rooms, code)
		}
		r.mu.Unlock()
	}
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	dist, err := fs.Sub(distFS, "web/dist")
	if err != nil {
		log.Fatal(err)
	}
	files := http.FileServer(http.FS(dist))

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", wsHandler(os.Getenv("INSECURE_ORIGIN") == "1")) // INSECURE_ORIGIN=1 only for the Vite dev proxy
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	mux.HandleFunc("/", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, req)
	})

	go func() {
		for range time.Tick(time.Minute) {
			sweepRooms(4 * time.Hour)
		}
	}()

	log.Printf("snail-betting listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
