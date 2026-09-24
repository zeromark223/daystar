import "./style.css";
import { ROOM_ID_PATTERN } from "../../shared/src/constants.ts";
import type { ServerMessage } from "../../shared/src/protocol.ts";
import { Game } from "./game/game.ts";
import { Connection } from "./net.ts";
import { ChatPanel } from "./ui/chat.ts";
import { runLobby } from "./ui/lobby.ts";

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

async function main(): Promise<void> {
  const roomId = currentRoomId();
  const hud = document.getElementById("hud")!;
  const count = document.getElementById("hud-count")!;
  const names = new Map<number, string>();
  let game: Game | null = null;
  let chat: ChatPanel | null = null;
  let joined = false;

  const updateCount = () => {
    count.textContent = `${names.size} here`;
  };

  const showDisconnected = (reason?: string) => {
    if (reason) document.getElementById("disconnected-reason")!.textContent = reason;
    document.getElementById("disconnected")!.hidden = false;
  };

  const handle = (msg: ServerMessage) => {
    if (!game || !chat) return;
    switch (msg.t) {
      case "welcome":
        game.setSelf(msg.selfId);
        for (const p of msg.players) {
          names.set(p.id, p.name);
          game.addPlayer(p);
        }
        msg.chat.forEach((m) => chat!.addMessage(m));
        chat.addSystem(`You joined ${roomId}.`);
        updateCount();
        joined = true;
        break;
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
      case "correction":
        game.applyCorrection(msg.x, msg.y);
        break;
      case "error":
        if (joined) chat.addSystem(msg.message);
        else showDisconnected(msg.message);
        break;
    }
  };

  await runLobby(roomId, async (choice) => {
    const conn = await Connection.open(roomId, {
      onMessage: handle,
      onSnapshot: (players) => game?.applySnapshot(players),
      onClose: () => showDisconnected(),
    });
    game ??= await Game.create(document.getElementById("stage")!, {
      sendMove: (x, y, dir, moving) => conn.sendMove(x, y, dir, moving),
    });
    chat = new ChatPanel((text) => conn.send({ t: "chat", text }));
    conn.send({ t: "join", name: choice.name, character: choice.character });
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
