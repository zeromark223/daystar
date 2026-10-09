import "./style.css";
import { ROOM_ID_PATTERN } from "../../shared/src/constants.ts";
import type { Poll } from "../../shared/src/poll.ts";
import type { PlayerInfo, ServerMessage } from "../../shared/src/protocol.ts";
import { canSpeak, ROLE_LABELS, type Role } from "../../shared/src/roles.ts";
import { Game, type GatherStyle } from "./game/game.ts";
import { MissingPlayers } from "./missing-players.ts";
import { Connection, createRoom } from "./net.ts";
import { AudienceBar } from "./ui/audience.ts";
import { ChatPanel } from "./ui/chat.ts";
import { inviteUrl, setupInviteQr } from "./ui/invite.ts";
import { runLobby, type LobbyChoice } from "./ui/lobby.ts";
import { PeoplePanel } from "./ui/people.ts";
import { PollPanel } from "./ui/poll.ts";
import { SettingsPanel } from "./ui/settings.ts";
import { Tutorial } from "./ui/tutorial.ts";
import { unlockAudio } from "./voice/audio.ts";
import { Microphone } from "./voice/microphone.ts";
import { voiceProblem } from "./voice/support.ts";
import { VoicePlayer } from "./voice/voice-player.ts";

/** The room in the URL (/r/<id>), or null on the home page (create a room). */
function roomFromUrl(): string | null {
  const match = location.pathname.match(/^\/r\/([^/]+)\/?$/);
  const id = match ? decodeURIComponent(match[1]).toLowerCase() : "";
  return ROOM_ID_PATTERN.test(id) ? id : null;
}

const hostKeyName = (room: string) => `daystar:host:${room}`;

function loadHostKey(room: string): string {
  try {
    return localStorage.getItem(hostKeyName(room)) ?? "";
  } catch {
    return "";
  }
}

function saveHostKey(room: string, key: string): void {
  try {
    localStorage.setItem(hostKeyName(room), key);
  } catch {
    // Blocked storage: this tab is still the host until it reconnects.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RECONNECT_ATTEMPTS = 5;

const HINTS = {
  player: "WASD / arrows or tap to move · 1–6 react · H raise hand · wheel or +/− to zoom · Enter to chat",
  host: "You are the sun · tap a player to choose speakers · 1–6 react · wheel or +/− to zoom · Enter to chat",
  touchPlayer: "Drag anywhere to move · tap to go there · pinch to zoom",
  touchHost: "You are the sun · tap a player to choose speakers · pinch to zoom",
};
const TOUCH = matchMedia("(pointer: coarse)").matches;
/** On phones the hint is shown for a while after joining, then gets out of the way. */
const TOUCH_HINT_MS = 10_000;

async function main(): Promise<void> {
  let roomId = roomFromUrl();
  /** Kept in memory too, in case storage is blocked. */
  let hostKey = roomId ? loadHostKey(roomId) : "";
  const hud = document.getElementById("hud")!;
  const count = document.getElementById("hud-count")!;
  const roleChip = document.getElementById("hud-role")!;
  const hint = document.getElementById("hint")!;
  let touchHintTimer: ReturnType<typeof setTimeout> | undefined;
  const micButton = document.getElementById("mic-button") as HTMLButtonElement;
  const soundButton = document.getElementById("sound-button") as HTMLButtonElement;
  let game: Game | null = null;
  let chat: ChatPanel | null = null;
  let joined = false;
  let selfId = -1;
  let selfRole: Role = "guest";
  /** The socket we play on; replaced on migration and reconnect. */
  let conn: Connection | null = null;
  let identity: LobbyChoice | null = null;
  let switching = false;

  const player = new VoicePlayer();
  const mic = new Microphone((seq, data) => conn?.send({ t: "voice", seq, data }));
  const people = new PeoplePanel({
    setRole: (id, role) => conn?.send({ t: "set_role", id, role }),
    lowerHand: (id) => conn?.send({ t: "hand", id, up: false }),
  });
  const audience = new AudienceBar({
    react: (kind) => conn?.send({ t: "react", kind }),
    hand: (up) => conn?.send({ t: "hand", id: selfId, up }),
  });
  const polls = new PollPanel({
    start: (question, options) => conn?.send({ t: "poll_start", question, options }),
    end: () => conn?.send({ t: "poll_end" }),
  });

  const missing = new MissingPlayers((ids) => conn?.send({ t: "who", ids }));
  const gatherButton = document.getElementById("gather-button") as HTMLButtonElement;
  const orbitBanner = document.getElementById("orbit-banner")!;
  let orbiting = false;
  gatherButton.addEventListener("click", () => conn?.send({ t: orbiting ? "release" : "gather" }));

  /** Orbit mode on or off: the host's button, the banner, polls. */
  const showOrbit = (on: boolean, announce: boolean) => {
    orbiting = on;
    gatherButton.textContent = on ? "Release" : "Gather";
    gatherButton.setAttribute("aria-pressed", String(on));
    orbitBanner.hidden = !on || selfRole === "host";
    if (on) hint.classList.remove("touch"); // the banner takes its place on phones
    polls.setLocked(on);
    if (on) polls.hide();
    if (!announce) return;
    if (on) chat?.addSystem("The host gathered everyone around the sun.");
    else chat?.addSystem("The host let everyone go. You can move again.");
  };
  const tutorial = new Tutorial();
  /** Settings that apply to the game, which is created after the lobby. */
  let orbitNames = false;
  let gatherStyle: GatherStyle = "corona";
  new SettingsPanel({
    gatherStyle: (style) => {
      gatherStyle = style;
      game?.setGatherStyle(style);
    },
    replayTutorial: () => tutorial.replay(selfRole),
    orbitNames: (shown) => {
      orbitNames = shown;
      game?.setOrbitNames(shown);
    },
  });

  /** A poll started or ended (or was already open when we joined). */
  const showPoll = (poll: Poll, announce: boolean) => {
    game!.showPoll(poll);
    polls.show(poll);
    hint.classList.remove("touch"); // the card takes its place on phones
    if (!announce) return;
    if (poll.open) chat?.addSystem(`Poll: ${poll.question} Fly to an answer's planet around the sun to vote.`);
    else chat?.addSystem(`Poll closed: ${poll.options.map((o, i) => `${o} ${poll.counts[i] ?? 0}`).join(" · ")}`);
  };
  if (new URLSearchParams(location.search).has("debug")) Object.assign(window, { voice: player, mic });

  const updateCount = () => {
    count.textContent = `${people.size} here`;
  };

  const showDisconnected = (reason?: string) => {
    if (reason) document.getElementById("disconnected-reason")!.textContent = reason;
    document.getElementById("disconnected")!.hidden = false;
  };

  // ------------------------------------------------------------ voice controls

  const renderMic = () => {
    micButton.hidden = !canSpeak(selfRole);
    micButton.setAttribute("aria-pressed", String(mic.live));
    micButton.textContent = mic.live ? "Mic on" : "Turn mic on";
  };

  micButton.addEventListener("click", async () => {
    if (mic.live) {
      mic.mute();
      renderMic();
      return;
    }
    unlockAudio();
    micButton.disabled = true;
    try {
      await mic.start();
    } catch (err) {
      chat?.addSystem(err instanceof Error ? err.message : String(err));
    } finally {
      micButton.disabled = false;
      renderMic();
    }
  });

  soundButton.addEventListener("click", () => {
    unlockAudio();
    player.setMuted(!player.isMuted);
    soundButton.setAttribute("aria-pressed", String(!player.isMuted));
    soundButton.textContent = player.isMuted ? "Sound off" : "Sound on";
  });

  /** Our own role changed (welcome, or the host's decision). */
  const setSelfRole = (role: Role, announce: boolean) => {
    const before = selfRole;
    selfRole = role;
    roleChip.hidden = role === "guest";
    roleChip.textContent = ROLE_LABELS[role];
    roleChip.className = `role-chip ${role}`;
    audience.setCanRaise(role === "guest");
    polls.setHost(role === "host");
    gatherButton.hidden = role !== "host";
    orbitBanner.hidden = !orbiting || role === "host";
    if (TOUCH) hint.textContent = role === "host" ? HINTS.touchHost : HINTS.touchPlayer;
    else hint.textContent = role === "host" ? HINTS.host : HINTS.player;
    if (TOUCH && (!announce || before !== role)) {
      hint.classList.add("touch");
      clearTimeout(touchHintTimer);
      touchHintTimer = setTimeout(() => hint.classList.remove("touch"), TOUCH_HINT_MS);
    }
    if (!canSpeak(role)) mic.stop();
    renderMic();
    // First time in this role: a short tour (after the HUD has laid out).
    setTimeout(() => tutorial.offer(role), 600);
    if (!announce || before === role) return;
    if (role === "speaker") chat?.addSystem("The host invited you to speak. Turn your mic on when you are ready.");
    else if (before === "speaker" && role === "guest") chat?.addSystem("You are a guest again; your mic is off.");
    else if (before === "host") chat?.addSystem("You are hosting from another tab now.");
  };

  // ------------------------------------------------------------ messages

  const addPlayer = (p: PlayerInfo) => {
    missing.found(p.id);
    people.upsert(p.id, p.name, p.role, p.hand);
    game!.addPlayer(p);
    if (p.id === selfId) audience.setHand(p.hand > 0);
  };

  const handChanged = (id: number, hand: number) => {
    const before = people.handOf(id);
    people.setHand(id, hand);
    game!.setHand(id, hand > 0);
    if (id === selfId) audience.setHand(hand > 0);
    else if (selfRole === "host" && hand > 0 && before === 0) chat?.addSystem(`${people.nameOf(id)} raised a hand.`);
  };

  const playerLeft = (id: number) => {
    const name = people.nameOf(id);
    if (name === undefined) return; // never seen (left before we joined)
    people.remove(id);
    player.remove(id);
    game!.removePlayer(id);
    chat!.addSystem(`${name} left.`);
    updateCount();
  };

  const handle = (msg: ServerMessage, from: Connection) => {
    if (!game || !chat || from !== conn) return;
    switch (msg.t) {
      case "welcome": {
        // A second welcome means we moved or reconnected: rebuild the room from it.
        const rejoin = joined;
        game.resetPlayers();
        missing.reset();
        people.clear();
        player.clear();
        selfId = msg.selfId;
        game.setSnapshotRate(msg.snapshotHz);
        game.setSelf(msg.selfId);
        people.setSelf(msg.selfId);
        for (const p of msg.players) addPlayer(p);
        setSelfRole(msg.players.find((p) => p.id === msg.selfId)?.role ?? "guest", rejoin);
        if (msg.poll) showPoll(msg.poll, !rejoin);
        else if (rejoin) polls.hide();
        if (msg.orbit) game.startOrbit(msg.orbit, false);
        showOrbit(msg.orbit !== null, false);
        if (!rejoin) {
          msg.chat.forEach((m) => chat!.addMessage(m));
          chat.addSystem(`You joined ${roomId}.`);
          if (selfRole === "host") chat.addSystem("You are the host. Tap a player, or open People, to choose speakers.");
          const problem = voiceProblem("play");
          if (problem) chat.addSystem(problem);
        }
        updateCount();
        joined = true;
        break;
      }
      case "player_joined":
        addPlayer(msg.player);
        chat.addSystem(`${msg.player.name} joined.`);
        updateCount();
        break;
      case "player_left":
        playerLeft(msg.id);
        break;
      case "role": {
        const before = people.roleOf(msg.id);
        people.setRole(msg.id, msg.role);
        game.setRole(msg.id, msg.role);
        if (!canSpeak(msg.role)) player.remove(msg.id);
        if (msg.id === selfId) {
          setSelfRole(msg.role, true);
        } else if (before !== msg.role) {
          const name = people.nameOf(msg.id);
          if (msg.role === "speaker") chat.addSystem(`${name} is now a speaker.`);
          else if (before === "speaker") chat.addSystem(`${name} is a guest again.`);
        }
        break;
      }
      case "rate":
        // The room got big (or small again): snapshots now come at a different rate.
        game.setSnapshotRate(msg.snapshotHz);
        break;
      case "chat":
        chat.addMessage(msg.message);
        game.showChat(msg.message.playerId, msg.message.text);
        break;
      case "view":
        game.applyView(msg.from, msg.to, msg.players);
        for (const p of msg.players) if (p.id !== selfId && people.nameOf(p.id) === undefined) missing.saw(p.id);
        break;
      case "snapshot":
        // Joins first (positions may refer to them), leaves last. A newcomer also gets
        // the joins already in its welcome, and its own: skip players we have.
        for (const p of msg.joined) {
          if (p.id === selfId || people.nameOf(p.id) !== undefined) continue;
          addPlayer(p);
          chat.addSystem(`${p.name} joined.`);
        }
        if (msg.joined.length) updateCount();
        game.applySnapshot(msg.players, msg.time);
        for (const s of msg.slots) game.setSlot(s.id, s.slot);
        // Someone we never heard join (a frame to us was dropped): ask who it is.
        for (const p of msg.players) if (p.id !== selfId && people.nameOf(p.id) === undefined) missing.saw(p.id);
        player.push(msg.voice.filter((frame) => frame.id !== selfId));
        for (const r of msg.reactions) game.react(r.id, r.kind);
        for (const h of msg.hands) handChanged(h.id, h.hand);
        if (msg.pollCounts.length > 0) {
          game.setPollCounts(msg.pollCounts);
          polls.setCounts(msg.pollCounts);
        }
        for (const id of msg.left) playerLeft(id);
        break;
      case "correction":
        game.applyCorrection(msg.x, msg.y);
        break;
      case "poll":
        showPoll(msg.poll, true);
        break;
      case "orbit":
        if (msg.active) game.startOrbit(msg, true);
        else game.releaseOrbit(msg);
        showOrbit(msg.active, true);
        break;
      case "players":
        // Answer to "who": players we missed the join of, quietly added; ids that
        // are gone we drop if we still show them (we missed their leave too).
        for (const p of msg.players) if (p.id !== selfId && people.nameOf(p.id) === undefined) addPlayer(p);
        for (const id of msg.missing) playerLeft(id);
        if (msg.players.length) updateCount();
        break;
      case "migrate":
        void migrate();
        break;
      case "error":
        if (joined) chat.addSystem(msg.message);
        else showDisconnected(msg.message);
        break;
    }
  };

  const handlers = { onMessage: handle, onLost: (c: Connection) => void lost(c) };

  /** Switch to a new socket: join there first, then drop the old one. */
  const adopt = (next: Connection) => {
    const old = conn;
    conn = next;
    next.send({ t: "join", name: identity!.name, appearance: identity!.appearance, hostKey });
    old?.close();
  };

  /** Cluster: the server is shedding load; move without leaving the room. */
  async function migrate(): Promise<void> {
    if (switching || !conn?.ticket) return;
    switching = true;
    try {
      adopt(await Connection.migrate(conn.ticket, handlers));
    } catch {
      // Stay where we are; the server keeps us and may ask again later.
    } finally {
      switching = false;
    }
  }

  /** The server (or network) went away: rejoin the room through the agent. */
  async function lost(c: Connection): Promise<void> {
    if (c !== conn || switching) return;
    switching = true;
    chat?.addSystem("Connection lost, reconnecting…");
    try {
      for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
        try {
          adopt(await Connection.open(roomId!, handlers));
          chat?.addSystem("Reconnected.");
          return;
        } catch {
          await sleep(attempt * 1000);
        }
      }
      showDisconnected();
    } finally {
      switching = false;
    }
  }

  await runLobby(roomId, hostKey !== "", async (choice) => {
    // Still inside the click: the only moment browsers let audio start.
    unlockAudio();
    if (!roomId) {
      const created = await createRoom();
      roomId = created.room;
      hostKey = created.hostKey;
      saveHostKey(roomId, hostKey);
      history.replaceState(null, "", `/r/${roomId}${location.search}`);
    }
    const first = await Connection.open(roomId, handlers);
    identity = choice;
    game ??= await Game.create(document.getElementById("stage")!, {
      sendMove: (x, y, dir, moving) => conn?.send({ t: "move", x, y, dir, moving }),
      voiceLevel: (id) => (id === selfId ? mic.level : player.level(id)),
      pick: (id, x, y) => people.openMenu(id, x, y),
    });
    game.setOrbitNames(orbitNames);
    game.setGatherStyle(gatherStyle);
    chat = new ChatPanel((text) => conn?.send({ t: "chat", text }));
    // Which answer planet we are on, for the poll card.
    setInterval(() => polls.setMine(game!.pollAnswer), 200);
    adopt(first);
  });

  document.getElementById("hud-room")!.textContent = roomId;
  document.getElementById("copy-link")!.addEventListener("click", async (e) => {
    const button = e.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(inviteUrl(roomId!));
      button.textContent = "Copied!";
    } catch {
      button.textContent = inviteUrl(roomId!);
    }
    setTimeout(() => (button.textContent = "Copy invite link"), 1500);
  });
  setupInviteQr(roomId!);
  hud.hidden = false;
  audience.show();
}

main();
