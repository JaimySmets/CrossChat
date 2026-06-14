// Orchestration (ARCHITECTURE.md §3, §9). One Session per connected panel:
// resolve the channel, drive a ChatSource, and stream normalized messages to
// the panel. The Emote Registry pass (Phase 3) is applied in `emit`.
import type { ChatSource, NormalizedMessage } from "../../shared/types";
import type { WorkerPort } from "../../shared/messaging";
import { TwitchIrcSource } from "../sources/twitch-irc-source";
import { buildRegistry, EmoteRegistry } from "../emotes/registry";
import { applyRegistry } from "../emotes/apply";
import { getMapping, setMapping } from "./channel-map";
import { resolveTwitchChannel } from "./resolve";

export class Session {
  private source: ChatSource | null = null;
  private handle: string | null = null;
  private registry: EmoteRegistry | null = null;

  constructor(private readonly port: WorkerPort) {}

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
  }

  private async connect(login: string): Promise<void> {
    this.detach();
    this.port.send({ type: "state", state: { status: "connecting" } });

    const { channel, ffzChannelEmotes } = await resolveTwitchChannel(login);
    this.port.send({ type: "channel-resolved", channel });

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

    const source = new TwitchIrcSource();
    source.onState((state) => this.port.send({ type: "state", state }));
    source.onMessage((msg) => this.emit(msg));
    this.source = source;
    await source.connect(channel);
  }

  private emit(msg: NormalizedMessage): void {
    const composited = this.registry ? applyRegistry(msg, this.registry) : msg;
    this.port.send({ type: "message", message: composited });
  }
}
