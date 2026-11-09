/**
 * The signed-in account (server: server/src/auth). The session lives in HttpOnly
 * cookies this code cannot read; it asks /api/auth/me and keeps the session alive
 * by refreshing shortly before the access token expires. Tabs take turns through
 * a Web Lock so they never present the same refresh token at once.
 */

export interface User {
  id: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
}

export type AccountState =
  /** The server has no accounts (no OIDC_ISSUER). */
  | { kind: "off" }
  | { kind: "signed_out" }
  | { kind: "signed_in"; user: User; expiresAt: number };

/** Refresh this long before the access token expires. */
const REFRESH_AHEAD_MS = 60_000;
/** Inside the lock: another tab refreshed if the token has at least this long left. */
const FRESH_ENOUGH_MS = 2 * REFRESH_AHEAD_MS;
const LOCK = "daystar:auth-refresh";

type Listener = (state: AccountState) => void;

let state: AccountState = { kind: "signed_out" };
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setTimeout> | undefined;

function set(next: AccountState): void {
  state = next;
  clearTimeout(timer);
  if (next.kind === "signed_in") {
    timer = setTimeout(() => void keepAlive(), Math.max(5_000, next.expiresAt - Date.now() - REFRESH_AHEAD_MS));
  }
  for (const l of listeners) l(next);
}

async function me(): Promise<AccountState> {
  const res = await fetch("/api/auth/me", { cache: "no-store" });
  if (res.status === 404) return { kind: "off" };
  if (!res.ok) return { kind: "signed_out" };
  const body = (await res.json()) as { user: User; expiresAt: number };
  return { kind: "signed_in", ...body };
}

async function refresh(): Promise<AccountState> {
  const res = await fetch("/api/auth/refresh", { method: "POST" });
  if (!res.ok) return { kind: "signed_out" };
  const body = (await res.json()) as { user: User; expiresAt: number };
  return { kind: "signed_in", ...body };
}

/** One tab at a time: if another tab just refreshed, its fresh cookie is ours too. */
async function refreshOnce(): Promise<AccountState> {
  const run = async () => {
    const now = await me();
    if (now.kind === "signed_in" && now.expiresAt - Date.now() > FRESH_ENOUGH_MS) return now;
    if (now.kind === "off") return now;
    return refresh();
  };
  return navigator.locks ? navigator.locks.request(LOCK, run) : run();
}

async function keepAlive(): Promise<void> {
  try {
    set(await refreshOnce());
  } catch {
    // Offline: try again in a little while; the refresh token lasts for days.
    clearTimeout(timer);
    timer = setTimeout(() => void keepAlive(), 15_000);
  }
}

/**
 * Who is signed in. A session whose access token expired (a tab asleep for an
 * hour) is renewed with the refresh token, if it is still valid.
 */
export async function loadAccount(): Promise<AccountState> {
  try {
    set(await refreshOnce());
  } catch {
    set({ kind: "off" });
  }
  // Timers sleep with background tabs; check again when the tab comes back.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.kind === "signed_in" && state.expiresAt - Date.now() < REFRESH_AHEAD_MS) {
      void keepAlive();
    }
  });
  return state;
}

export const account = (): AccountState => state;

/**
 * Before joining a room: make sure the access token outlives the join, since
 * /api/join reads it to put the account in the ticket. Never throws; a failed
 * refresh simply joins as a guest.
 */
export async function freshSession(): Promise<void> {
  if (state.kind !== "signed_in" || state.expiresAt - Date.now() > FRESH_ENOUGH_MS) return;
  try {
    set(await refreshOnce());
  } catch {
    // Offline or the server is restarting: join as whoever the cookie says.
  }
}

export function onAccountChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Off to Authentik, then back to this page. */
export function logIn(): void {
  location.href = `/api/auth/login?return=${encodeURIComponent(location.pathname + location.search)}`;
}

/** Signs this browser out of Daystar (Authentik's own session stays). */
export async function logOut(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
  set({ kind: "signed_out" });
}

/** Where the signed-in account is a host or speaker right now (or was, minutes ago). */
export async function myLiveRoom(): Promise<{ room: string; role: "host" | "speaker" } | null> {
  if (state.kind !== "signed_in") return null;
  try {
    const res = await fetch("/api/rooms/mine", { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { room: string | null; role?: "host" | "speaker" };
    return body.room && body.role ? { room: body.room, role: body.role } : null;
  } catch {
    return null;
  }
}

const LOGIN_ERRORS: Record<string, string> = {
  access_denied: "Login was cancelled.",
  expired: "The login took too long; please try again.",
};

/** A failed login comes back as ?auth_error=…: its message, and the URL cleaned up. */
export function takeLoginError(): string | null {
  const url = new URL(location.href);
  const code = url.searchParams.get("auth_error");
  if (!code) return null;
  url.searchParams.delete("auth_error");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  return LOGIN_ERRORS[code] ?? "Login failed; please try again.";
}
