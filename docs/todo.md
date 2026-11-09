# TODO

Deferred work, with enough context to pick it up later.

## Snapshot size: delta positions + deflate

Measured on 300 real snapshots from a 1,000-player room (20% moving, ~197 players per
snapshot, 1,381 B on average):

| Layout | Bytes | vs now |
|---|---|---|
| Current (7 B/player) + LZ4 (lz4js) | 1,396 | +1% (and ~240 µs JS decode per frame) |
| Current + deflate-raw L1 / zstd L3 / brotli q5 | 1,415 / 1,312 / 1,267 | +2% / −5% / −8% |
| Delta positions (5 B/player) | 988 | −29% |
| Delta + deflate-raw L1 | 672 | −51% (≈6 µs compress, 4 µs decompress) |

LZ4 is not worth it: the packed binary has almost no repeats. Plan instead:

1. **Safety nets first** (they also fix a risk the current delta-*snapshot* design already has):
   - Close sockets that exceed the backpressure limit instead of letting publish drop
     frames for them (`closeOnBackpressureLimit`); the client reconnects and gets a
     fresh `welcome`.
   - A periodic absolute keyframe (e.g. every 5 s, or a rolling share of players per tick)
     so any drift heals within seconds. Costs ~7% bandwidth in a 1,000-player room.
2. **Delta positions**: entries carry `dx, dy` as int8 in 0.25 px units against the last
   position *broadcast* for that player (a move per tick is at most ~80 units). A spare
   bit in the motion byte marks an absolute entry for big jumps (corrections, migration,
   ~0.8% of entries). Rules: integer wire units on both ends; `welcome` sends the last
   broadcast positions, not the live ones; `player_joined` is always absolute.
3. **deflate-raw level 1** per snapshot (compressed once per room tick), decoded in the
   browser with `DecompressionStream("deflate-raw")` **strictly in order** (a queue).
4. Verification: a randomized test (joins, leaves, moves, jumps, late joiners, migration)
   comparing client reconstruction with server state exactly; a `desync` column in the
   load test (bots check their reconstruction against keyframes; target 0).

Over WebSocket (TCP) nothing is lost or reordered inside a connection; the real risks
are server-side frame drops under backpressure and implementation bugs, both covered
above. An unreliable transport (QUIC datagrams, WebRTC) would need acked baselines instead.

## Chat rides the tick frame

On the Coolify host (Xeon E5-2680 v4, ~21 µs per message vs ~2.5 µs on the dev laptop)
a 1,000-player room holds when chat is off, but with every bot chatting once per 90 s
the loop p99 doubles (800 players: 66 ms with chat, 34 ms without; move p99 989 ms vs
105 ms). Each chat line is its own broadcast to the whole room (~7k extra sends/s at
800 players), and each broadcast is a burst on the event loop that stacks on the tick's.

Plan: queue chat lines per room and send them inside the next tick's frame (snapshot +
chat in one message per player), so a tick costs exactly N sends however chatty the room
is. Chat gains at most 50 ms of latency. Joins and leaves already work this way
(appended to the snapshot, see README "Networking").

## Voice follow-ups

- Measure voice with the load test: a `--speakers N` option where some bots send
  60 B frames at 50/s while "talking", to see the cost of a talking room on Coolify.
- A speaker who reconnects comes back as a guest (roles live with the socket). Keep
  the role for a short grace period, keyed by the player's name + a per-tab token.
- If TCP stalls hurt on mobile networks, move voice to a WebRTC SFU (docs/voice.md
  "Why not WebRTC").

## Voice in browsers without WebCodecs

Supported today: Chrome and Safari on phones; Chrome, Edge and Firefox on computers.
Firefox on Android has no WebCodecs audio, so it cannot play or send voice.

Plan: libopus compiled to WebAssembly as a fallback inside the voice worker, loaded
only when `AudioDecoder` / `AudioEncoder` are missing. Same Opus bitstream, so the
server and other clients do not change.

1. Decoding first (most people are guests who only listen): worker falls back to a
   WASM Opus decoder and posts PCM to the same playback worklet.
2. Then encoding, for hosts and speakers on those browsers.
3. Before choosing a library: check it is maintained, license compatible with MIT
   (libopus is BSD), download size (lazy-loaded), and CPU per stream on a phone.
   Test by disabling WebCodecs in headless Chrome, then on a real Firefox Android.

Rejected: MediaRecorder (container chunks of hundreds of ms, still needs a decoder),
raw PCM (5x the bandwidth, two formats on the server), WebRTC just for Firefox.

## Presenting files (idea, not planned)

The host shows an image, a PDF or a slide deck to everyone and drives it: page,
scroll and zoom, a laser pointer, highlights. Shelved because accepting uploads is
a large attack surface for a feature nobody needs yet.

Design sketched so far:

- **Everything becomes a set of pages.** An image is 1 page, a PDF N pages, a PPTX
  goes through LibreOffice headless to PDF. A conversion worker, outside the game
  server's event loop, renders each page to WebP (two sizes, for zoom) and the text
  lines' boxes to JSON (`pdftotext -bbox`). Clients then need one viewer, phones
  render nothing heavy, and every screen shows the same pixels, so coordinates
  match exactly.
- **Files never ride the game WebSocket.** 2,800 guests x a 5 MB PDF is ~14 GB
  through the loop that sends the 20 Hz snapshot. Upload with HTTP (host key only,
  ~50 MB / 200 pages cap); serve pages over HTTP at immutable, content-hashed URLs
  so Cloudflare caches them; guests fetch only the page in view and its
  neighbours. Local disk is enough while every server is in one container; a
  multi-machine cluster needs S3 or MinIO. Delete with the room (TTL).
- **Sync what the host sees, not scroll pixels** (screens differ in width):
  `view { file, page: u16, rect: x,y,w,h }` normalised to the page,
  `pointer { x, y: u16, mode }`, `mark { page, rects[] }`. Each guest fits `rect`
  to its own screen, which covers scroll, zoom and aspect ratio at once. Opening,
  page changes and marks are events like `poll` and are in `welcome` for late
  joiners; view and pointer ride the snapshot tail like `pollCounts`, only when
  changed (a few bytes per tick), interpolated on the client. In cluster mode they
  are mirrored over the mesh like roles and moves.
- **Highlights:** a laser dot (any file), a dragged box, and snapping to a text
  line: the host's client finds the nearest line box and sends its rect, so guests
  need no text. Images have no text, so laser and box only.
- **Guests follow the host** by default; they may browse on their own, with a
  "back to the host" button.
- **PPTX limits:** slides and speaker notes (host only) yes; animations, builds,
  video, audio and transitions no; fonts ~90% right (install Carlito, Caladea,
  Noto in the worker). Exporting to PDF from PowerPoint first is the faithful path.

Security, the reason it waits:

- Only the host uploads; check magic bytes, not extensions.
- LibreOffice and poppler have a long CVE history: run them sandboxed (own
  container, no network, time and memory limits).
- Re-encode images (strip EXIF / GPS, cap at ~40 MP against decompression bombs).
- Unguessable URLs (content hash) or URLs signed with the room.

Cheaper ways in, if it comes back:

- **Images only, converted in the host's browser:** the client downscales and
  re-encodes to WebP before sending; the server only accepts size-capped WebP and
  parses nothing complex. The sync design above stays the same.
- **Screen sharing** (`getDisplayMedia`): no files on the server at all, but video
  bandwidth and a different media path (see "Why not WebRTC" in docs/voice.md).

Phases if built: (1) upload, images and PDF, page/rect sync, follow mode, laser,
late joiners, cluster mirroring, a load-test column; (2) boxes, line snapping, pen
strokes; (3) PPTX, speaker notes, thumbnails. Out of scope: PPTX animations and
video, guest uploads, co-editing, the Rust server.

## Rooms limited to an email domain (deferred)

The schema already has `rooms.access = 'domain'` and `allowed_domain`, and tickets
carry `ev` (Authentik vouches for the email). Shelved: testing it needs company
mailboxes, which a dev setup does not have; the accounts work is a proof of
concept of SSO for now.

Before building it, check what Authentik sends as `email_verified`. A
self-registered test account without email verification came back with
`ev: true`; if the default OpenID `email` scope mapping always says true, anyone
could sign up as someone@company.com and enter that company's rooms. Fix the
mapping (or add an email verification stage to enrollment) first.
