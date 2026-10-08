import qrcode from "qrcode-generator";

/** The room's link to share: without our own query (e.g. ?debug). */
export function inviteUrl(roomId: string): string {
  return `${location.origin}/r/${roomId}`;
}

/** Light modules around the code, as the QR spec asks, so phones find it easily. */
const QUIET_ZONE = 4;
const SIZE_PX = 240;

/**
 * "QR" next to the invite link: a dialog with the link as a QR code, so people
 * in the same room (the physical one) can join by pointing their phone at it.
 * The code is made in the browser; the link is not sent anywhere.
 */
export function setupInviteQr(roomId: string): void {
  const button = document.getElementById("qr-button") as HTMLButtonElement;
  const dialog = document.getElementById("qr-dialog") as HTMLDialogElement;
  const canvas = document.getElementById("qr-canvas") as HTMLCanvasElement;
  const link = document.getElementById("qr-link")!;
  const note = document.getElementById("qr-note")!;
  const url = inviteUrl(roomId);
  link.textContent = url;
  // A link to this computer only works here; say so instead of showing a useless code silently.
  note.hidden = !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

  let drawn = false;
  button.addEventListener("click", () => {
    if (!drawn) {
      draw(canvas, url);
      drawn = true;
    }
    dialog.showModal();
  });
  // A click on the dimmed backdrop (outside the dialog box) closes it.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}

function draw(canvas: HTMLCanvasElement, url: string): void {
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const modules = qr.getModuleCount();
  const total = modules + QUIET_ZONE * 2;
  const dpr = window.devicePixelRatio || 1;
  // Whole device pixels per module keep the edges sharp.
  const cell = Math.max(1, Math.floor((SIZE_PX * dpr) / total));
  canvas.width = canvas.height = cell * total;
  canvas.style.width = canvas.style.height = `${(cell * total) / dpr}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#04050c";
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + QUIET_ZONE) * cell, (r + QUIET_ZONE) * cell, cell, cell);
    }
  }
}
