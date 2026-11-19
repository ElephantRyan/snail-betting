package main

import "testing"

// A competitive room has no game state until it starts, but the lobby still has to render.
func TestCompetitiveLobbyView(t *testing.T) {
	r := newRoom(Settings{Mode: modeCompetitive, Rounds: 4}, "TEST")
	p := r.addPlayer("Host")
	p.connected = true
	if m := r.view(p); m.Phase != "lobby" || len(m.Players) != 1 {
		t.Fatalf("bad lobby view: %+v", m)
	}
}
