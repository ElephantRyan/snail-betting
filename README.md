# snails

Multiplayer snail-racing game for team events. Go server (WebSockets, in-memory rooms), TypeScript + Vite front end drawn on a canvas. The built front end is embedded in the Go binary.

## Rules
- The host creates a room (rounds, starting coins, bet timer) and shares the 6-letter code or invite link.
- Display names are unique per room; duplicates get a suffix (`Sam`, `Sam 2`).
- Nobody can join after the first round of betting starts. A dropped player can rejoin by refreshing (same tab) or by entering their exact name.
- Each round, bet on one snail. Odds are equal; payouts are parimutuel with a podium: all bets form a pool split 60/25/15 across the 1st/2nd/3rd place snails (positions when the winner crosses the line), each slice shared among that snail's backers in proportion to their stake. Places nobody backed are redistributed to the backed ones. If nobody backed the top 3, everyone is refunded.
- Players at 0 coins get a 50-coin loan at the start of the next round.

## Decision mode
Pick **Decision** as the game type when creating a room. It's a decision helper (where to eat, what to play) rather than a betting game: no coins, no bets.
- After the lobby everyone adds options; each option becomes a snail (max 24 characters, max 64 snails, at least 2). Names must be unique. A close match (`McDonalds` / `McDonald's`, a small typo, one name inside another, the same words reordered) asks "Add it anyway?" before it is added; an exact duplicate is refused. Whoever added a snail, or the host, can remove it.
- Up to 8 snails race per heat. With more than 8, they are split into even heats, the top 4 of each heat move on, and this repeats until at most 8 are left for the final. The number of rounds follows from the number of snails (64 snails = 4 rounds).
- The host moves from heat to heat. After the final there is a podium for the top 3 and full standings: finalists in finishing order, then everyone else by how late they went out.

## Run it
```
cd web && npm install && npm run build && cd ..
go run .            # http://localhost:3000
```
Front-end dev with hot reload: `INSECURE_ORIGIN=1 go run .` and `cd web && npm run dev` (http://localhost:5173).

Tests: `go test ./...` (`-short` skips the ~20 s websocket game). Front-end types: `cd web && npm run typecheck`.

## Deploy
```
docker compose up -d --build
```
Put it behind a reverse proxy that forwards WebSocket upgrades on `/ws` (and terminates TLS; the client uses `wss://` automatically on https). State lives in memory: restarting the container ends any running games.
