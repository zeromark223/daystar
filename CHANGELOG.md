# Changelog

Notable changes to Daystar. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Earlier history is in `git log`.

## [Unreleased]

### Added

- **The account reaches the room:** `/api/join` signs the signed-in account into
  the WebSocket ticket (the agent's player ticket in a cluster, a new 30 s join
  ticket standalone), migration tickets carry it over, and the game server keeps
  it on the player, server-side only. Guests join exactly as before.
- The client refreshes the session before joining or reconnecting when it is
  about to expire, so the ticket carries the account.
- **Hosts and speakers keep their seat by account:** for 10 minutes after
  leaving, a signed-in host or speaker gets the role back on rejoining, after a
  dropped connection, a reload or from another device (the old one steps down to
  guest; a demoted speaker is told why). Automatic reconnects (`reconnect` in
  `/api/join`) never take a seat held live on another device. Lost when the host
  demotes them or someone else becomes the host.
- **"Rejoin?" on another device:** signed in on the home page while holding a
  seat in a live room, the lobby offers to go back (`GET /api/rooms/mine`); on
  the room's own page the button reads "Rejoin as host / speaker".
- **Load test runs in Postgres:** every run (command line and web UI) is logged
  to `loadtest_runs` and its rows to `loadtest_rows` (migration 002), next to
  the CSV; on when `PGHOST` is set, `--no-db` to skip, never blocking a run.
  `bun run loadtest:runs [id]` lists runs or shows one.
- Load test: Ctrl+C stops a run cleanly (summary written, run saved as
  `stopped`); a second Ctrl+C quits at once.
- WebSocket upgrades from another site's page are refused (`Origin` must be the
  server's own host or `PUBLIC_URL`; no `Origin` passes).
- docs/todo.md: seats by account across a cluster (they work per server today).
- docs/todo.md: rooms limited to an email domain (deferred), and the
  `email_verified` question to settle first.

- README, Capacity: many rooms and the cluster (one core with rooms of 100; a
  4-server cluster with one spanning room, and with rooms of 100 and 1,000, on the
  laptop and an i7-13700K desktop).
- docs/todo.md: cluster v2 with shards (under consideration), one clock for all
  of a server's rooms, and the mesh cluster's overload behaviour.

### Fixed

- Load test: a bot worker crashed (`InvalidStateError` in `promoteSpeakers`) when
  a room's host bot lost its socket under heavy load (seen at ~30,000 bots on a
  4-server cluster) and a speaker rejoined; the host now promotes only while its
  socket is open.

### Changed

- `.env.example` is now `example.env` and documents every variable the server
  reads (server, capacity, cluster, Postgres, accounts). Every line is commented
  out with an explanation, its default and an example: uncomment what you need.

## [0.2.0] - 2026-11-08

### Added

- **Accounts (experiment):** log in with Authentik (OIDC code flow with PKCE,
  state and nonce); off unless `OIDC_ISSUER` is set, and never needed by guests.
  - `/api/auth/login`, `/callback`, `/refresh`, `/logout`, `/me`, served by the
    standalone server or, in a cluster, by the agent.
  - Daystar's own sessions: a 15-minute access JWT and a 30-day refresh token in
    HttpOnly cookies. Each refresh swaps the token; a used token presented again
    (outside 10 s, for tabs racing) revokes every token of that login.
  - Id_tokens checked against Authentik's JWKS: RS256 only, issuer, audience,
    expiry, nonce. Return paths stay on the site; POSTs from other origins are refused.
  - Lobby: a "Log in · Experiment" button, or the account's name with "Log out";
    hidden when the server has no accounts. The client refreshes a minute before
    expiry, one tab at a time (Web Locks), and fills in the name from the account.
- **Postgres:** the first database (`users`, `refresh_tokens`, `rooms`,
  `room_members`), configured with the standard `PG*` variables. Numbered SQL
  migrations, applied at startup under an advisory lock or with `bun run db:migrate`.
- `.env.example` listing every variable.
- Tests against a fake OIDC provider and the database in `.env`, each run in a
  throwaway schema (skipped without `PGHOST`).
- README: the demo server's 20-day run behind Cloudflare.
- docs/todo.md: presenting files (shelved idea, with its security concerns).
- This changelog.
