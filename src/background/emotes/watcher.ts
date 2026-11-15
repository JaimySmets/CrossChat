// Live emote updates for the joined channel, so emotes a streamer adds,
// renames or removes mid-stream apply without a page reload.
//
// - 7TV: EventAPI socket. `emote_set.update` on the active set carries the
//   changed emotes (applied as deltas); `user.update` on the 7TV user fires
//   when the channel switches active set (refetch + resubscribe).
// - BTTV: socket, `join_channel` -> emote_create / emote_update / emote_delete.
// - FFZ: no public push feed, so the room endpoint is polled.
//
// Deltas patch the registry in place (the Session holds the same instance).
// Anything we can't parse, and every socket reconnect (events may have been
// missed while down), falls back to refetching that provider's set via REST.
//
// Every applied change is also reported as a chat notice ("7TV: Added emote
// X"), like the provider extensions do on Twitch.
import type { ChatNotice, Fragment, ResolvedChannel } from "../../shared/types";
import type { RegistryEmote } from "./types";
import { emoteKey, invalidateChannelCache, type EmoteLayer, type EmoteRegistry } from "./registry";
import { LiveSocket } from "./live-socket";
import { fetchSeventvChannel, toSeventvEmote, type StvEmote } from "./seventv";
import { fetchBttvChannel, toBttvEmote, type BttvEmote } from "./bttv";
import { fetchFfzRoom } from "./ffz";

const STV_EVENTS_URL = "wss://events.7tv.io/v3";
const BTTV_SOCKET_URL = "wss://sockets.betterttv.net/ws";
const FFZ_POLL_MS = 5 * 60 * 1000;
/** Coalesce bursts (an editor adding several emotes) into one refetch. */
const REFETCH_DEBOUNCE_MS = 2000;
/** More changes than this in one batch (e.g. a set switch) become one summary line. */
const MAX_NOTICE_LINES = 5;

const PROVIDER_LABEL: Record<Exclude<EmoteLayer, "global">, string> = {
  "7tv": "7TV",
  bttv: "BTTV",
  ffz: "FFZ",
};

type EmoteChange =
  | { kind: "added" | "removed"; emote: RegistryEmote }
  | { kind: "renamed"; emote: RegistryEmote; oldName: string };

let noticeSeq = 0;

// Diagnostics in the service worker console (chrome://extensions -> CrossChat ->
// "service worker"). Socket/event traffic is debug level (enable "Verbose");
// applied changes are info level so they're visible by default.
const debug = (...args: unknown[]): void => console.debug("[crosschat] emotes:", ...args);

// 7TV EventAPI opcodes.
const OP_DISPATCH = 0;
const OP_HELLO = 1;
const OP_RECONNECT = 4;
const OP_SUBSCRIBE = 35;
const OP_UNSUBSCRIBE = 36;

interface StvChange {
  key?: string;
  value?: unknown;
  old_value?: unknown;
}
interface StvMessage {
  op: number;
  d?: {
    heartbeat_interval?: number;
    type?: string;
    body?: {
      id?: string;
      actor?: { display_name?: string; username?: string };
      pushed?: StvChange[];
      pulled?: StvChange[];
      updated?: StvChange[];
    };
  };
}

interface BttvMessage {
  name?: string;
  data?: { channel?: string; emote?: BttvEmote; emoteId?: string };
}

export interface SeventvIds {
  setId: string | null;
  stvUserId: string | null;
}

export class EmoteWatcher {
  private stv: LiveSocket | null = null;
  private bttv: LiveSocket | null = null;
  private ffzTimer: ReturnType<typeof setInterval> | null = null;
  private refetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private setId: string | null;
  private readonly stvUserId: string | null;

  constructor(
    private readonly channel: ResolvedChannel,
    private readonly registry: EmoteRegistry,
    stvIds: SeventvIds,
    private readonly onNotice: (notice: ChatNotice) => void,
  ) {
    this.setId = stvIds.setId;
    this.stvUserId = stvIds.stvUserId;
  }

  start(): void {
    // 7TV and BTTV are keyed by Twitch user id; without one (FFZ had no record)
    // there's nothing to subscribe to, same as the initial build.
    if (this.channel.userId) {
      // No 7TV account yet -> no ids to subscribe to; it would only matter if
      // the streamer signs up mid-stream, which a reload covers.
      if (this.setId || this.stvUserId) {
        this.stv = new LiveSocket(STV_EVENTS_URL, {
          onOpen: (reconnected) => {
            if (reconnected) this.scheduleRefetch("7tv");
          },
          onMessage: (data) => this.onSeventv(data),
        });
        this.stv.start();
      }
      this.bttv = new LiveSocket(BTTV_SOCKET_URL, {
        onOpen: (reconnected) => {
          debug("BTTV socket connected; joining", this.bttvChannel);
          this.bttv?.send({ name: "join_channel", data: { name: this.bttvChannel } });
          if (reconnected) this.scheduleRefetch("bttv");
        },
        onMessage: (data) => this.onBttv(data),
      });
      this.bttv.start();
    }
    this.ffzTimer = setInterval(() => void this.refetch("ffz"), FFZ_POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    this.stv?.stop();
    this.bttv?.stop();
    this.stv = this.bttv = null;
    if (this.ffzTimer) clearInterval(this.ffzTimer);
    this.ffzTimer = null;
    for (const t of this.refetchTimers.values()) clearTimeout(t);
    this.refetchTimers.clear();
  }

  setNetworkOnline(online: boolean): void {
    this.stv?.setNetworkOnline(online);
    this.bttv?.setNetworkOnline(online);
  }

  private get bttvChannel(): string {
    return `twitch:${this.channel.userId}`;
  }

  // ---- 7TV ----------------------------------------------------------------

  private stvSubscribe(op: number, type: string, objectId: string): void {
    this.stv?.send({ op, d: { type, condition: { object_id: objectId } } });
  }

  private onSeventv(raw: string): void {
    let msg: StvMessage;
    try {
      msg = JSON.parse(raw) as StvMessage;
    } catch {
      return;
    }
    switch (msg.op) {
      case OP_HELLO: {
        debug("7TV events connected; subscribing set", this.setId, "user", this.stvUserId);
        // The server heartbeats (op 2) every heartbeat_interval; three missed
        // beats means a half-open socket.
        const beat = msg.d?.heartbeat_interval;
        if (beat) this.stv?.setDeadAfter(beat * 3);
        if (this.setId) this.stvSubscribe(OP_SUBSCRIBE, "emote_set.update", this.setId);
        if (this.stvUserId) this.stvSubscribe(OP_SUBSCRIBE, "user.update", this.stvUserId);
        break;
      }
      case OP_RECONNECT:
        this.stv?.reconnect();
        break;
      case OP_DISPATCH:
        if (msg.d?.type === "emote_set.update" || msg.d?.type === "user.update") {
          debug("7TV event", msg.d.type, msg.d.body);
        }
        this.onSeventvDispatch(msg.d?.type, msg.d?.body);
        break;
    }
  }

  private onSeventvDispatch(
    type: string | undefined,
    body: NonNullable<StvMessage["d"]>["body"],
  ): void {
    if (type === "user.update") {
      // Covers an active-set switch; cheaper to refetch than to dig the new
      // set id out of the nested connections diff.
      this.scheduleRefetch("7tv");
      return;
    }
    if (type !== "emote_set.update" || !body || body.id !== this.setId) return;

    const changes: EmoteChange[] = [];
    let unparsed = false;
    const removeOld = (c: StvChange): RegistryEmote | undefined => {
      const old = c.old_value as StvEmote | undefined;
      if (!old?.id) {
        unparsed = true;
        return undefined;
      }
      return this.registry.remove("7tv", old.id, old.name || undefined);
    };
    /** The parsed emote, and whether it was new to the layer (false = replay). */
    const addNew = (c: StvChange): { emote: RegistryEmote; isNew: boolean } | null => {
      const emote = c.value ? toSeventvEmote(c.value as StvEmote, true) : null;
      if (!emote) {
        unparsed = true;
        return null;
      }
      return { emote, isNew: this.registry.add("7tv", emote) };
    };
    for (const c of body.pulled ?? []) {
      if (c.key !== "emotes") continue;
      const removed = removeOld(c);
      if (removed) changes.push({ kind: "removed", emote: removed });
    }
    for (const c of body.pushed ?? []) {
      if (c.key !== "emotes") continue;
      const added = addNew(c);
      if (added?.isNew) changes.push({ kind: "added", emote: added.emote });
    }
    for (const c of body.updated ?? []) {
      if (c.key !== "emotes") continue;
      // Rename keeps the id; remove-then-add also covers an id swap.
      const before = removeOld(c);
      const after = addNew(c);
      const oldName = (c.old_value as StvEmote | undefined)?.name ?? before?.name;
      if (after && oldName && oldName !== after.emote.name) {
        changes.push({ kind: "renamed", emote: after.emote, oldName });
      }
    }
    if (changes.length) invalidateChannelCache(this.channel.userId);
    const actor = body.actor?.display_name || body.actor?.username;
    this.report("7tv", changes, actor);
    if (unparsed) this.scheduleRefetch("7tv");
  }

  // ---- BTTV ---------------------------------------------------------------

  private onBttv(raw: string): void {
    let msg: BttvMessage;
    try {
      msg = JSON.parse(raw) as BttvMessage;
    } catch {
      return;
    }
    const data = msg.data;
    if (msg.name?.startsWith("emote_")) debug("BTTV event", msg.name, data);
    if (!data || data.channel !== this.bttvChannel) return;
    let change: EmoteChange | null = null;
    switch (msg.name) {
      case "emote_create":
      case "emote_update": {
        const emote = data.emote ? toBttvEmote(data.emote, true) : null;
        if (!emote) {
          this.scheduleRefetch("bttv");
          return;
        }
        // BTTV ids are unique per channel, so an update replaces by id.
        const previous = this.registry.remove("bttv", emote.id);
        this.registry.add("bttv", emote);
        if (!previous) change = { kind: "added", emote };
        else if (previous.name !== emote.name) change = { kind: "renamed", emote, oldName: previous.name };
        break;
      }
      case "emote_delete": {
        if (!data.emoteId) {
          this.scheduleRefetch("bttv");
          return;
        }
        const removed = this.registry.remove("bttv", data.emoteId);
        if (removed) change = { kind: "removed", emote: removed };
        break;
      }
      default:
        return; // lookup_user etc. — not emote changes
    }
    if (!change) return; // replay of a change we already have
    invalidateChannelCache(this.channel.userId);
    this.report("bttv", [change]);
  }

  // ---- REST fallback --------------------------------------------------------

  private scheduleRefetch(provider: "7tv" | "bttv"): void {
    if (this.stopped) return;
    const pending = this.refetchTimers.get(provider);
    if (pending) clearTimeout(pending);
    this.refetchTimers.set(
      provider,
      setTimeout(() => {
        this.refetchTimers.delete(provider);
        void this.refetch(provider);
      }, REFETCH_DEBOUNCE_MS),
    );
  }

  /** Replace one provider's layer from REST; a failed fetch keeps the current one. */
  private async refetch(provider: "7tv" | "bttv" | "ffz"): Promise<void> {
    debug("refetching", provider, "channel set");
    const { userId, login } = this.channel;
    if (provider === "7tv") {
      const stv = await fetchSeventvChannel(userId);
      if (!stv || this.stopped) return;
      this.replaceLayer("7tv", stv.emotes);
      if (stv.setId !== this.setId) {
        if (this.setId) this.stvSubscribe(OP_UNSUBSCRIBE, "emote_set.update", this.setId);
        this.setId = stv.setId;
        if (this.setId) this.stvSubscribe(OP_SUBSCRIBE, "emote_set.update", this.setId);
      }
    } else if (provider === "bttv") {
      const bttv = await fetchBttvChannel(userId);
      if (!bttv || this.stopped) return;
      this.replaceLayer("bttv", bttv);
    } else {
      const room = await fetchFfzRoom(login);
      if (!room || this.stopped) return;
      this.replaceLayer("ffz", room.emotes);
      return; // FFZ channel emotes aren't in the registry's channel cache
    }
    invalidateChannelCache(userId);
  }

  /** Swap a layer for a refetched set and report what differs from before. */
  private replaceLayer(layer: Exclude<EmoteLayer, "global">, next: RegistryEmote[]): void {
    const before = new Map(this.registry.getLayer(layer).map((e) => [emoteKey(e), e]));
    this.registry.setLayer(layer, next);
    const added: RegistryEmote[] = [];
    for (const emote of this.registry.getLayer(layer)) {
      if (!before.delete(emoteKey(emote))) added.push(emote);
    }
    // Whatever is left in `before` is gone. Same id on both sides = a rename.
    const removed = [...before.values()];
    const changes: EmoteChange[] = [];
    for (const emote of added) {
      const index = removed.findIndex((r) => r.id === emote.id);
      if (index >= 0) {
        changes.push({ kind: "renamed", emote, oldName: removed[index].name });
        removed.splice(index, 1);
      } else {
        changes.push({ kind: "added", emote });
      }
    }
    for (const emote of removed) changes.push({ kind: "removed", emote });
    this.report(layer, changes);
  }

  // ---- Chat notices ---------------------------------------------------------

  private report(layer: Exclude<EmoteLayer, "global">, changes: EmoteChange[], actor?: string): void {
    if (!changes.length || this.stopped) return;
    const label = PROVIDER_LABEL[layer];
    const notice = (fragments: Fragment[]): void => {
      const text = fragments.map((f) => (f.type === "text" ? f.value : "")).join("");
      console.info(`[crosschat] emotes: ${label}: ${text.replace(/\s+/g, " ").trim()}`);
      this.onNotice({ id: `notice-${Date.now()}-${++noticeSeq}`, label, fragments, timestamp: Date.now() });
    };

    if (changes.length > MAX_NOTICE_LINES) {
      const count = (kind: EmoteChange["kind"]) => changes.filter((c) => c.kind === kind).length;
      const parts = [
        [count("added"), "added"],
        [count("removed"), "removed"],
        [count("renamed"), "renamed"],
      ]
        .filter(([n]) => n)
        .map(([n, verb]) => `${n} ${verb}`)
        .join(", ");
      notice([{ type: "text", value: `${actor ? `${actor} updated` : "Updated"} the emote set: ${parts}` }]);
      return;
    }

    for (const change of changes) {
      const { emote } = change;
      const image: Fragment = { type: "emote", name: emote.name, url: emote.url, provider: emote.provider };
      const verb =
        change.kind === "renamed"
          ? `renamed emote ${change.oldName} to `
          : `${change.kind === "added" ? "added" : "removed"} emote `;
      const lead = actor ? `${actor} ${verb}` : verb.charAt(0).toUpperCase() + verb.slice(1);
      notice([{ type: "text", value: lead }, image, { type: "text", value: ` ${emote.name}` }]);
    }
  }
}
