/**
 * The lobby's account corner: "Log in" (an experiment for now), or who is signed
 * in with "Log out". Hidden when the server has no accounts.
 */
import { loadAccount, logIn, logOut, onAccountChange, takeLoginError, type AccountState } from "../account.ts";

export async function setupAccountBar(nameInput: HTMLInputElement): Promise<void> {
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
}
