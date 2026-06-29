// Twitch send path (ChatSink) — Helix POST /chat/messages with the user token.
// Read stays anonymous (IRC); this is the only authenticated outbound surface.
// Sent messages echo back through the normal IRC read path, so there is no
// special local echo to do here. Emotes are sent as plain case-sensitive names
// (no emote payload) — the receiver's 7TV/BTTV/FFZ overlays beautify them.
import type { ChatSink, ResolvedChannel, SendResult } from "../../shared/types";
import { HELIX_BASE, TWITCH_CLIENT_ID } from "../auth/twitch-config";
import { getIdentity, getToken, invalidate } from "../auth/twitch-auth";

interface HelixSendResponse {
  data?: { message_id: string; is_sent: boolean; drop_reason?: { code: string; message: string } }[];
}

export class TwitchSink implements ChatSink {
  readonly platform = "twitch" as const;

  /** login -> Twitch numeric broadcaster id, resolved once per channel. */
  private readonly broadcasterIds = new Map<string, string>();

  capabilities(): { canSend: boolean; rateLimitHint?: number } {
    // Platform capability statement; live "logged in?" gating is driven by the
    // engine's AuthState, not this. ~20 msgs / 30s for a normal (non-mod) user.
    return { canSend: true, rateLimitHint: 20 };
  }

  async send(channel: ResolvedChannel, text: string): Promise<SendResult> {
    const message = text.trim();
    if (!message) return { ok: false, error: "Message is empty" };

    const token = await getToken();
    const identity = await getIdentity();
    if (!token || !identity) return { ok: false, error: "Not logged in" };

    let broadcasterId: string;
    try {
      broadcasterId = await this.resolveBroadcasterId(channel, token);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Channel lookup failed" };
    }

    const res = await fetch(`${HELIX_BASE}/chat/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Client-Id": TWITCH_CLIENT_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        broadcaster_id: broadcasterId,
        sender_id: identity.userId,
        message,
      }),
    });

    if (res.status === 401) {
      await invalidate(); // token died; engine pushes logged-out state so UI re-prompts
      return { ok: false, error: "Session expired — please log in again" };
    }
    if (!res.ok) {
      return { ok: false, error: `Send failed (${res.status})` };
    }

    const body = (await res.json()) as HelixSendResponse;
    const result = body.data?.[0];
    if (result && result.is_sent === false) {
      return { ok: false, error: result.drop_reason?.message || "Message was dropped" };
    }
    return { ok: true };
  }

  /** Helix needs a numeric broadcaster id; FFZ-derived userId may be empty. */
  private async resolveBroadcasterId(channel: ResolvedChannel, token: string): Promise<string> {
    if (channel.userId) return channel.userId;
    const cached = this.broadcasterIds.get(channel.login);
    if (cached) return cached;

    const res = await fetch(`${HELIX_BASE}/users?login=${encodeURIComponent(channel.login)}`, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": TWITCH_CLIENT_ID },
    });
    if (!res.ok) throw new Error(`Could not resolve channel (${res.status})`);
    const data = (await res.json()) as { data?: { id: string }[] };
    const id = data.data?.[0]?.id;
    if (!id) throw new Error("Channel not found on Twitch");
    this.broadcasterIds.set(channel.login, id);
    return id;
  }
}
