/**
 * The lobby's account corner: "Log in" (an experiment for now), or who is signed
 * in with "Log out". Hidden when the server has no accounts.
 */
import { loadAccount, logIn, logOut, myLiveRoom, onAccountChange, takeLoginError, type AccountState } from "../account.ts";

const ROLE_WORDS = { host: "hosting", speaker: "a speaker in" } as const;

/**
 * Signed in on the home page while the account holds a seat in a live room
 * (another device, a closed tab): offer to go back. Opening a room's link
 * directly asks nothing; joining it restores the role anyway.
 */
async function offerRejoin(roomId: string | null): Promise<void> {
  const mine = await myLiveRoom();
  if (!mine) return;
  if (roomId !== null) {
    // On that room's own page: say what joining will do.
    if (mine.room !== roomId) return;
    const button = document.getElementById("join-button") as HTMLButtonElement;
    button.textContent = mine.role === "host" ? "Rejoin as host" : "Rejoin as speaker";
    return;
  }
  const box = document.getElementById("rejoin")!;
  document.getElementById("rejoin-text")!.textContent =
    `You are ${ROLE_WORDS[mine.role]} ${mine.room}, which is still live. Rejoin it?`;
  (document.getElementById("rejoin-go") as HTMLAnchorElement).href = `/r/${mine.room}`;
  document.getElementById("rejoin-dismiss")!.addEventListener("click", () => (box.hidden = true), { once: true });
  box.hidden = false;
}

export async function setupAccountBar(nameInput: HTMLInputElement, roomId: string | null): Promise<void> {
  const bar = document.getElementById("account")!;
  const who = document.getElementById("account-who")!;
  const login = document.getElementById("login-button") as HTMLButtonElement;
  const logout = document.getElementById("logout-button") as HTMLButtonElement;
  const error = document.getElementById("account-error")!;

  login.addEventListener("click", () => {
    login.disabled = true;
    logIn();
  });
  logout.addEventListener("click", async () => {
    logout.disabled = true;
    await logOut();
    logout.disabled = false;
  });

  function render(state: AccountState): void {
    bar.hidden = state.kind === "off";
    if (state.kind !== "signed_in") document.getElementById("rejoin")!.hidden = true;
    const signedIn = state.kind === "signed_in";
    login.hidden = signedIn;
    logout.hidden = !signedIn;
    who.hidden = !signedIn;
    if (signedIn) {
      const label = state.user.name || state.user.email || "your account";
      who.textContent = label;
      who.title = state.user.email ?? "";
    }
  }
  onAccountChange(render);

  const failed = takeLoginError();
  if (failed) {
    error.textContent = failed;
    error.hidden = false;
  }
  const state = await loadAccount();
  // First visit while signed in: the account's name is a good default.
  if (state.kind === "signed_in" && !nameInput.value && state.user.name) {
    nameInput.value = state.user.name.slice(0, nameInput.maxLength);
  }
  if (state.kind === "signed_in") await offerRejoin(roomId);
}
