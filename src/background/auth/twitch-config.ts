// Twitch application config for the OAuth send path.
//
// App name on the dev console: "YTCrossChat" (the name "CrossChat" was taken).
// The CLIENT ID below is the ~30-char identifier Twitch generates for that app
// (dev.twitch.tv/console/apps → your app → Client ID) — it is NOT the app name.
// Like the gql web Client-Id used for badges, it is a public identifier, not a
// secret, so it is safe to commit. No client secret is ever used (implicit grant).
//
export const TWITCH_CLIENT_ID = "pr2udl6xh953isw59j6hxy7z4rvjn0";

/** OAuth scope required to send chat messages via Helix. Read stays anonymous. */
export const SEND_SCOPE = "user:write:chat";

export const OAUTH_AUTHORIZE = "https://id.twitch.tv/oauth2/authorize";
export const OAUTH_VALIDATE = "https://id.twitch.tv/oauth2/validate";
export const OAUTH_REVOKE = "https://id.twitch.tv/oauth2/revoke";
export const HELIX_BASE = "https://api.twitch.tv/helix";
