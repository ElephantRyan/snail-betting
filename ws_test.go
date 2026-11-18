package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type testClient struct {
	t    *testing.T
	conn *websocket.Conn
}

func dial(t *testing.T, url string) *testClient {
	t.Helper()
	conn, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(url, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	conn.SetReadLimit(1 << 20)
	t.Cleanup(func() { conn.CloseNow() })
	return &testClient{t, conn}
}

func (c *testClient) send(v any) {
	b, _ := json.Marshal(v)
	if err := c.conn.Write(context.Background(), websocket.MessageText, b); err != nil {
		c.t.Fatal(err)
	}
}

// read messages until one of the wanted type (and, for state, phase) arrives
func (c *testClient) until(typ, phase string) map[string]any {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	for {
		_, data, err := c.conn.Read(ctx)
		if err != nil {
			c.t.Fatalf("waiting for %s/%s: %v", typ, phase, err)
		}
		var m map[string]any
		_ = json.Unmarshal(data, &m)
		if m["type"] == typ && (phase == "" || m["phase"] == phase) {
			return m
		}
	}
}

func TestFullGameOverWebsocket(t *testing.T) {
	if testing.Short() {
		t.Skip("plays a real ~20s race")
	}
	srv := httptest.NewServer(wsHandler(false))
	defer srv.Close()

	host := dial(t, srv.URL)
	host.send(map[string]any{"type": "create", "name": "Ann", "settings": map[string]int{"rounds": 1, "startCoins": 1000, "betSeconds": 0}})
	joined := host.until("joined", "")
	code := joined["code"].(string)

	guest := dial(t, srv.URL)
	guest.send(map[string]any{"type": "join", "code": strings.ToLower(code), "name": "Ann"})
	if name := guest.until("joined", "")["name"]; name != "Ann 2" {
		t.Fatalf("duplicate name not suffixed: %v", name)
	}

	host.send(map[string]any{"type": "start"})
	host.until("state", "betting")
	host.send(map[string]any{"type": "bet", "snail": 2, "amount": 200})
	guest.send(map[string]any{"type": "bet", "snail": 4, "amount": 300})

	race := host.until("race", "")
	if frames := race["frames"].([]any); len(frames) < 100 {
		t.Fatalf("race too short: %d frames", len(frames))
	}
	winner := int(race["order"].([]any)[0].(float64))

	late := dial(t, srv.URL)
	late.send(map[string]any{"type": "join", "code": code, "name": "Late"})
	if msg := late.until("error", "")["message"].(string); !strings.Contains(msg, "already started") {
		t.Fatalf("late joiner not rejected: %q", msg)
	}

	res := host.until("state", "results")["results"].(map[string]any)
	if int(res["winner"].(float64)) != winner {
		t.Fatalf("results disagree with race: %v vs %d", res["winner"], winner)
	}
	host.send(map[string]any{"type": "next"})
	host.until("state", "final")
}
