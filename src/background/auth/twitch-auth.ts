// Twitch Auth Manager — the opt-in OAuth identity behind the send path.
//
// Flow: implicit grant via chrome.identity.launchWebAuthFlow. Twitch does not
// support auth-code + PKCE for public clients (the token exchange mandates a
// client secret), so implicit is the no-secret path. Tradeoff: no refresh
// token — when the access token expires the user re-authenticates. The token +
// identity live in chrome.storage.local; the worker owns this, never the panel.
//
// This is the real implementation the `getUserToken()` seam in
// badges/twitch-badges.ts anticipated; wiring badges to it is a later follow-up.
import type { AuthState } from "../../shared/types";
import {
  HELIX_BASE,
  OAUTH_AUTHORIZE,
  OAUTH_REVOKE,
  OAUTH_VALIDATE,
  SEND_SCOPE,
  TWITCH_CLIENT_ID,
} from "./twitch-config";

const STORE_KEY = "auth:twitch";
/** Re-auth a little before the real expiry so a send never races the deadline. */
const EXPIRY_SKEW_MS = 60_000;

interface StoredAuth {
  token: string;
  userId: string;
  login: string;
  displayName: string;
  expiresAt: number;
}

let cache: StoredAuth | null | undefined; // undefined = not yet loaded

async function load(): Promise<StoredAuth | null> {
  if (cache !== undefined) return cache;
  const out = await chrome.storage.local.get(STORE_KEY);
  const v = out[STORE_KEY] as StoredAuth | undefined;
  cache = v && typeof v.token === "string" ? v : null;
  return cache;
}

async function store(auth: StoredAuth | null): Promise<void> {
  cache = auth;
  if (auth) await chrome.storage.local.set({ [STORE_KEY]: auth });
  else await chrome.storage.local.remove(STORE_KEY);
}

const toState = (a: StoredAuth | null): AuthState =>
  a ? { loggedIn: true, login: a.login, displayName: a.displayName } : { loggedIn: false };

/** Run the interactive implicit-grant flow and persist the resulting token. */
export async function login(): Promise<AuthState> {
  const redirectUri = chrome.identity.getRedirectURL();
  const state = crypto.randomUUID();
  const url =
    `${OAUTH_AUTHORIZE}?response_type=token` +
    `&client_id=${encodeURIComponent(TWITCH_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(SEND_SCOPE)}` +
    `&state=${encodeURIComponent(state)}` +
    `&force_verify=true`;

  const redirect = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  if (!redirect) throw new Error("login cancelled");

  // The token comes back in the URL fragment (implicit grant).
  const frag = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (frag.get("error")) throw new Error(frag.get("error_description") || frag.get("error")!);
  if (frag.get("state") !== state) throw new Error("state mismatch");
  const token = frag.get("access_token");
  if (!token) throw new Error("no access token in response");

  const auth = await buildStored(token);
  await store(auth);
  return toState(auth);
}

/** Validate the token + fetch display name, producing a StoredAuth record. */
async function buildStored(token: string): Promise<StoredAuth> {
  const v = await fetch(OAUTH_VALIDATE, { headers: { Authorization: `OAuth ${token}` } });
  if (!v.ok) throw new Error(`token validation failed (${v.status})`);
  const vd = (await v.json()) as { user_id: string; login: string; expires_in: number };

  // Display name is cosmetic; fall back to login if the /users call fails.
  let displayName = vd.login;
  try {
    const u = await fetch(`${HELIX_BASE}/users`, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": TWITCH_CLIENT_ID },
    });
    if (u.ok) {
      const ud = (await u.json()) as { data?: { display_name?: string }[] };
      displayName = ud.data?.[0]?.display_name || vd.login;
    }
  } catch {
    /* keep login as displayName */
  }

  return {
    token,
    userId: vd.user_id,
    login: vd.login,
    displayName,
    expiresAt: Date.now() + Math.max(0, vd.expires_in) * 1000,
  };
}

/** Current token if present and not (about to be) expired, else null. */
export async function getToken(): Promise<string | null> {
  const a = await load();
  if (!a) return null;
  if (Date.now() >= a.expiresAt - EXPIRY_SKEW_MS) {
    await store(null);
    return null;
  }
  return a.token;
}

/** Authenticated identity for `sender_id`, or null when logged out. */
export async function getIdentity(): Promise<{ userId: string; login: string } | null> {
  const t = await getToken();
  const a = await load();
  return t && a ? { userId: a.userId, login: a.login } : null;
}

/** Derived auth state for the panel. */
export async function getAuthState(): Promise<AuthState> {
  await getToken(); // drops an expired token first so the state is honest
  return toState(await load());
}

/** Drop the stored token (e.g. after a 401 from Helix); panel re-prompts login. */
export async function invalidate(): Promise<void> {
  await store(null);
}

/** Best-effort revoke at Twitch, then clear local state. */
export async function logout(): Promise<void> {
  const a = await load();
  if (a) {
    try {
      await fetch(OAUTH_REVOKE, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `client_id=${encodeURIComponent(TWITCH_CLIENT_ID)}&token=${encodeURIComponent(a.token)}`,
      });
    } catch {
      /* revoke is best-effort; clear locally regardless */
    }
  }
  await store(null);
}
