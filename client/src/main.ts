import "./style.css";
import { ROOM_ID_PATTERN } from "../../shared/src/constants.ts";
import type { ServerMessage } from "../../shared/src/protocol.ts";
import { Game } from "./game/game.ts";
import { Connection } from "./net.ts";
import { ChatPanel } from "./ui/chat.ts";
import { runLobby, type LobbyChoice } from "./ui/lobby.ts";

function randomRoomId(): string {
  const words = ["cozy", "sunny", "mossy", "fuzzy", "sleepy", "bouncy", "misty", "happy"];
  const nouns = ["meadow", "burrow", "grove", "den", "garden", "hollow", "ruins", "glade"];
  const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];
  return `${pick(words)}-${pick(nouns)}-${Math.floor(Math.random() * 900 + 100)}`;
}

function currentRoomId(): string {
  const match = location.pathname.match(/^\/r\/([^/]+)\/?$/);
  const id = match ? decodeURIComponent(match[1]).toLowerCase() : "";
  if (ROOM_ID_PATTERN.test(id)) return id;
  const fresh = randomRoomId();
  history.replaceState(null, "", `/r/${fresh}`);
  return fresh;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RECONNECT_ATTEMPTS = 5;

async function main(): Promise<void> {
  const roomId = currentRoomId();
  const hud = document.getElementById("hud")!;
  const count = document.getElementById("hud-count")!;
  const names = new Map<number, string>();
  let game: Game | null = null;
  let chat: ChatPanel | null = null;
  let joined = false;
  /** The socket we play on; replaced on migration and reconnect. */
  let conn: Connection | null = null;
  let identity: LobbyChoice | null = null;
  let switching = false;

  const updateCount = () => {
    count.textContent = `${names.size} here`;
  };

  const showDisconnected = (reason?: string) => {
    if (reason) document.getElementById("disconnected-reason")!.textContent = reason;
    document.getElementById("disconnected")!.hidden = false;
  };

  const handle = (msg: ServerMessage, from: Connection) => {
    if (!game || !chat || from !== conn) return;
    switch (msg.t) {
      case "welcome": {
        // A second welcome means we moved or reconnected: rebuild the room from it.
        const rejoin = joined;
        game.resetPlayers();
        names.clear();
        game.setSelf(msg.selfId);
        for (const p of msg.players) {
          names.set(p.id, p.name);
          game.addPlayer(p);
        }
        if (!rejoin) {
          msg.chat.forEach((m) => chat!.addMessage(m));
          chat.addSystem(`You joined ${roomId}.`);
        }
        updateCount();
        joined = true;
        break;
      }
      case "player_joined":
        names.set(msg.player.id, msg.player.name);
        game.addPlayer(msg.player);
        chat.addSystem(`${msg.player.name} joined.`);
        updateCount();
        break;
      case "player_left": {
        const name = names.get(msg.id);
        names.delete(msg.id);
        game.removePlayer(msg.id);
        if (name) chat.addSystem(`${name} left.`);
        updateCount();
        break;
      }
      case "chat":
        chat.addMessage(msg.message);
        game.showChat(msg.message.playerId, msg.message.text);
        break;
      case "snapshot":
        game.applySnapshot(msg.players);
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
    next.send({ t: "join", name: identity!.name, character: identity!.character });
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
          adopt(await Connection.open(roomId, handlers));
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

  await runLobby(roomId, async (choice) => {
    const first = await Connection.open(roomId, handlers);
    identity = choice;
    game ??= await Game.create(document.getElementById("stage")!, {
      sendMove: (x, y, dir, moving) => conn?.send({ t: "move", x, y, dir, moving }),
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
