// Orchestration (ARCHITECTURE.md §3, §9). One Session per connected panel:
// resolve the channel, drive a ChatSource, and stream normalized messages to
// the panel. The Emote Registry pass (Phase 3) is applied in `emit`.
import type { ChatSink, ChatSource, NormalizedMessage, ResolvedChannel } from "../../shared/types";
import type { WorkerPort } from "../../shared/messaging";
import { TwitchIrcSource } from "../sources/twitch-irc-source";
import { TwitchSink } from "../sinks/twitch-sink";
import { buildRegistry, EmoteRegistry } from "../emotes/registry";
import { applyRegistry } from "../emotes/apply";
import { buildBadgeRegistry, applyBadges, BadgeRegistry } from "../badges/twitch-badges";
import * as auth from "../auth/twitch-auth";
import { getMapping, setMapping } from "./channel-map";
import { resolveTwitchChannel } from "./resolve";

export class Session {
  private source: ChatSource | null = null;
  private handle: string | null = null;
  private registry: EmoteRegistry | null = null;
  private badges: BadgeRegistry | null = null;
  private channel: ResolvedChannel | null = null;
  private readonly sink: ChatSink = new TwitchSink();

  constructor(private readonly port: WorkerPort) {}

  /** Push the current auth state to the panel (gates the composer). */
  private async sendAuthState(): Promise<void> {
    this.port.send({ type: "auth", auth: await auth.getAuthState() });
  }

  async login(): Promise<void> {
    try {
      await auth.login();
    } catch {
      /* cancelled / failed — fall through to report the (still logged-out) state */
    }
    await this.sendAuthState();
  }

  async logout(): Promise<void> {
    await auth.logout();
    await this.sendAuthState();
  }

  async send(text: string): Promise<void> {
    if (!this.channel) {
      this.port.send({ type: "send-result", ok: false, error: "Not connected" });
      return;
    }
    const result = await this.sink.send(this.channel, text);
    this.port.send({ type: "send-result", ok: result.ok, error: result.error });
    // A dropped send may mean the token expired (sink invalidates it); resync.
    if (!result.ok) await this.sendAuthState();
  }

  async attach(youtubeHandle: string): Promise<void> {
    this.handle = youtubeHandle;
    const login = await getMapping(youtubeHandle);
    if (!login) {
      this.port.send({ type: "need-mapping", youtubeHandle });
      return;
    }
    await this.connect(login);
  }

  async setMapping(youtubeHandle: string, twitchLogin: string): Promise<void> {
    await setMapping(youtubeHandle, twitchLogin);
    if (youtubeHandle === this.handle) await this.connect(twitchLogin);
  }

  detach(): void {
    this.source?.disconnect();
    this.source = null;
    this.registry = null;
    this.badges = null;
    this.channel = null;
  }

  private async connect(login: string): Promise<void> {
    this.detach();
    this.port.send({ type: "state", state: { status: "connecting" } });

    const { channel, ffzChannelEmotes } = await resolveTwitchChannel(login);
    this.channel = channel;
    this.port.send({ type: "channel-resolved", channel });
    void this.sendAuthState(); // let the panel show login button / composer

    // Build the Emote Registry for this channel; messages are composited in
    // `emit` before they reach the panel (§5). Don't block the chat connection
    // on registry build — native emotes still render while it loads.
    void buildRegistry(channel, ffzChannelEmotes)
      .then((registry) => {
        this.registry = registry;
      })
      .catch(() => {
        /* registry stays null; messages render with native emotes only */
      });

    // Resolve real badge artwork in parallel; on failure badges stay null and
    // render.ts falls back to CSS role chips.
    void buildBadgeRegistry(channel)
      .then((badges) => {
        this.badges = badges;
      })
      .catch(() => {
        /* badges stay null; role chips remain the fallback */
      });

    const source = new TwitchIrcSource();
    source.onState((state) => this.port.send({ type: "state", state }));
    source.onMessage((msg) => this.emit(msg));
    this.source = source;
    await source.connect(channel);
  }

  private emit(msg: NormalizedMessage): void {
    let out = this.registry ? applyRegistry(msg, this.registry) : msg;
    if (this.badges) out = applyBadges(out, this.badges);
    this.port.send({ type: "message", message: out });
  }
}
