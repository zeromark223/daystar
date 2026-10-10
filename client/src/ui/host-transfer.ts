import { draw, inviteUrl } from "./invite.ts";

/**
 * Settings → Host transfer: the room's link with the host key in its fragment
 * (/r/<room>#host=<key>), as a QR code and to copy, so the host can carry the
 * room over to a phone. The server makes whoever joins with the key the host and
 * the previous host a guest. The fragment never reaches the server, and the page
 * that opens it drops it from the address bar (see takeHostKeyFromUrl).
 *
 * On the device that handed over, "Take back" makes it the host again.
 */
export class HostTransfer {
  private readonly transferRow = document.getElementById("host-transfer-setting")!;
  private readonly takeBackRow = document.getElementById("take-back-setting")!;
  private readonly dialog = document.getElementById("host-dialog") as HTMLDialogElement;
  private readonly canvas = document.getElementById("host-qr") as HTMLCanvasElement;
  private readonly link = document.getElementById("host-link")!;
  private readonly copy = document.getElementById("host-copy") as HTMLButtonElement;
  private url = "";

  constructor(actions: { hostLink(): string | null; takeBack(): void }) {
    document.getElementById("host-transfer")!.addEventListener("click", () => {
      const url = actions.hostLink();
      if (!url) return;
      if (url !== this.url) {
        this.url = url;
        this.link.textContent = url;
        draw(this.canvas, url);
      }
      this.copy.textContent = "Copy link";
      this.dialog.showModal();
    });
    this.copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(this.url);
        this.copy.textContent = "Copied";
      } catch {
        // No clipboard (e.g. not a secure page): select the link to copy by hand.
        getSelection()?.selectAllChildren(this.link);
      }
    });
    document.getElementById("take-back-host")!.addEventListener("click", () => actions.takeBack());
    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
  }

  /** The host sees Transfer; a device that handed over sees Take back; others neither. */
  update(isHost: boolean, handedOver: boolean): void {
    this.transferRow.hidden = !isHost;
    this.takeBackRow.hidden = isHost || !handedOver;
    if (!isHost && this.dialog.open) this.dialog.close();
  }
}

/** The host link for a room. */
export function hostLink(roomId: string, key: string): string {
  return `${inviteUrl(roomId)}#host=${encodeURIComponent(key)}`;
}

/** A host key handed over in the address (#host=…), removed from the address so it is not shared on. */
export function takeHostKeyFromUrl(): string | null {
  const match = location.hash.match(/^#host=([^&]+)/);
  if (!match) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return decodeURIComponent(match[1]);
}
