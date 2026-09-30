import "./style.css";
import { ROOM_ID_PATTERN } from "../../shared/src/constants.ts";
import type { PlayerInfo, ServerMessage } from "../../shared/src/protocol.ts";
import { canSpeak, ROLE_LABELS, type Role } from "../../shared/src/roles.ts";
import { Game } from "./game/game.ts";
import { Connection, createRoom } from "./net.ts";
import { ChatPanel } from "./ui/chat.ts";
import { runLobby, type LobbyChoice } from "./ui/lobby.ts";
import { PeoplePanel } from "./ui/people.ts";
import { unlockAudio } from "./voice/audio.ts";
import { Microphone } from "./voice/microphone.ts";
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
  player: "WASD / arrows or tap to move · wheel or +/− to zoom · Enter to chat · Esc to stop typing",
  host: "You are the sun · tap a player to choose speakers · wheel or +/− to zoom · Enter to chat",
};

async function main(): Promise<void> {
  let roomId = roomFromUrl();
  /** Kept in memory too, in case storage is blocked. */
  let hostKey = roomId ? loadHostKey(roomId) : "";
  const hud = document.getElementById("hud")!;
  const count = document.getElementById("hud-count")!;
  const roleChip = document.getElementById("hud-role")!;
  const hint = document.getElementById("hint")!;
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
  const people = new PeoplePanel({ setRole: (id, role) => conn?.send({ t: "set_role", id, role }) });
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
    hint.textContent = role === "host" ? HINTS.host : HINTS.player;
    if (!canSpeak(role)) mic.stop();
    renderMic();
    if (!announce || before === role) return;
    if (role === "speaker") chat?.addSystem("The host invited you to speak. Turn your mic on when you are ready.");
    else if (before === "speaker" && role === "guest") chat?.addSystem("You are a guest again; your mic is off.");
    else if (before === "host") chat?.addSystem("You are hosting from another tab now.");
  };

  // ------------------------------------------------------------ messages

  const addPlayer = (p: PlayerInfo) => {
    people.upsert(p.id, p.name, p.role);
    game!.addPlayer(p);
  };

  const handle = (msg: ServerMessage, from: Connection) => {
    if (!game || !chat || from !== conn) return;
    switch (msg.t) {
      case "welcome": {
        // A second welcome means we moved or reconnected: rebuild the room from it.
        const rejoin = joined;
        game.resetPlayers();
        people.clear();
        player.clear();
        selfId = msg.selfId;
        game.setSelf(msg.selfId);
        people.setSelf(msg.selfId);
        for (const p of msg.players) addPlayer(p);
        setSelfRole(msg.players.find((p) => p.id === msg.selfId)?.role ?? "guest", rejoin);
        if (!rejoin) {
          msg.chat.forEach((m) => chat!.addMessage(m));
          chat.addSystem(`You joined ${roomId}.`);
          if (selfRole === "host") chat.addSystem("You are the host. Tap a player, or open People, to choose speakers.");
          if (!VoicePlayer.supported()) chat.addSystem("This browser cannot play voice; try a recent Chrome, Edge or Firefox.");
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
      case "player_left": {
        const name = people.nameOf(msg.id);
        people.remove(msg.id);
        player.remove(msg.id);
        game.removePlayer(msg.id);
        if (name) chat.addSystem(`${name} left.`);
        updateCount();
        break;
      }
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
      case "chat":
        chat.addMessage(msg.message);
        game.showChat(msg.message.playerId, msg.message.text);
        break;
      case "snapshot":
        game.applySnapshot(msg.players);
        for (const frame of msg.voice) if (frame.id !== selfId) player.push(frame);
        break;
      case "correction":
        game.applyCorrection(msg.x, msg.y);
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
    chat = new ChatPanel((text) => conn?.send({ t: "chat", text }));
    adopt(first);
  });

  document.getElementById("hud-room")!.textContent = roomId;
  document.getElementById("copy-link")!.addEventListener("click", async (e) => {
    const button = e.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(location.href);
      button.textContent = "Copied!";
    } catch {
      button.textContent = location.href;
    }
    setTimeout(() => (button.textContent = "Copy invite link"), 1500);
  });
  hud.hidden = false;
}

main();
