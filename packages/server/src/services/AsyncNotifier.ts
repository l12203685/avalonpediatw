/**
 * AsyncNotifier — 棋瓦 (Avalon Chess) Async-Mode Notification Fan-Out (P2)
 *
 * Responsibility:
 *   When an async-mode room advances a phase, push a "你的回合 / 輪到你了" ping
 *   to every player in `pending.pendingActors` via the channels they support
 *   (Discord DM, LINE direct push). Game-end notifications fan out to ALL
 *   players in the room.
 *
 * Why a separate service:
 *   - Decoupled from GameEngine — GameEngine fires a single optional callback
 *     and never imports any platform SDK. Engine stays unit-testable without
 *     bot mocks.
 *   - Decoupled from socket layer — async games may have ZERO connected
 *     sockets when a phase advances (player closed browser days ago); the
 *     ping has to land via out-of-band channels.
 *   - Per-phase throttle lives here so the engine does not need to track
 *     "did we already ping Bob for VOTE round 2 attempt 1".
 *
 * Channels (P2 scope):
 *   - Discord DM via `getDiscordBot()` + `extractDiscordUserId()` (reuses
 *     the same id-extraction logic as roleReveal.ts so no double source of
 *     truth).
 *   - LINE direct push via `ChatMirror.pushDirect(lineUserId, text)` (new
 *     method added in this commit so per-player pushes do not have to drag
 *     in a separate LINE client wiring).
 *   - Email is deferred to P3.
 *
 * Throttle:
 *   - One notification per (roomId, phase, round, attempt, playerId) tuple.
 *     Re-ping requires the phase to advance to a new tuple. This means a
 *     player who ignored their VOTE ping does NOT get spammed every time
 *     another player submits.
 *   - Game-end notifications use a separate (roomId, 'ended') key so they
 *     fire exactly once even if the engine re-emits.
 *
 * Safety:
 *   - Fire-and-forget: every per-channel push swallows its own errors so a
 *     LINE timeout never blocks the Discord DM (and vice versa). The engine
 *     callback always returns synchronously void; the actual fan-out happens
 *     in the background.
 *   - No-op when `room.mode !== 'async'`. Realtime games never trigger this
 *     service even if the callback gets wired by mistake.
 *   - Empty `pendingActors` = phase is closed; we still log but do not push.
 *
 * Edward 永不棄局: there is no hard deadline; this notifier never schedules
 * a re-ping or "deadline approaching" alert. Default-action policies (P3)
 * will own that behaviour.
 */

import type { Room, PendingDecision, Player, GameState } from '@avalon/shared';
import { extractDiscordUserId } from '../bots/discord/roleReveal';
import { getDiscordBot } from '../bots/discord/client';
import { getChatMirror } from '../bots/ChatMirror';

const LINE_ID_PREFIX = 'line:';

/**
 * Human-readable Chinese labels for each async phase. Used in the outgoing
 * notification body so players know what kind of decision they owe.
 */
const PHASE_LABEL: Record<GameState, string> = {
  lobby: '大廳',
  voting: '隊伍投票',
  quest: '任務投票',
  lady_of_the_lake: '湖中女神',
  discussion: '刺殺梅林',
  ended: '遊戲結束',
};

/**
 * Refined phase label for TEAM_SELECT vs VOTE — both share GameState 'voting'
 * but the engine distinguishes via `room.questTeam.length`.
 */
function refinePhaseLabel(room: Room, pending: PendingDecision): string {
  if (pending.phase === 'voting') {
    return room.questTeam.length === 0 ? '隊長選人' : '隊伍投票';
  }
  return PHASE_LABEL[pending.phase] ?? pending.phase;
}

/**
 * Logger surface — kept narrow so tests can inject a recorder without
 * shimming `console`.
 */
export interface AsyncNotifierLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
}

const defaultLogger: AsyncNotifierLogger = {
  info: (m) => console.log(`[AsyncNotifier] ${m}`),
  warn: (m) => console.warn(`[AsyncNotifier] ${m}`),
  error: (m, err) => console.error(`[AsyncNotifier] ${m}`, err),
};

/**
 * Minimal Discord-DM surface. Real impl uses `getDiscordBot()`; tests inject
 * a mock so no discord.js client is needed in CI.
 */
export interface DiscordDmAdapter {
  /** Send a plain-text DM to a Discord user. Resolves on success, throws on failure. */
  sendDm(discordUserId: string, text: string): Promise<void>;
}

/**
 * Minimal LINE-direct-push surface. Real impl is a thin wrapper over
 * `ChatMirror.pushDirect`; tests inject a mock.
 */
export interface LineDirectAdapter {
  /** Push a text message to a single LINE user. Resolves on success, throws on failure. */
  pushDirect(lineUserId: string, text: string): Promise<void>;
}

export interface AsyncNotifierConfig {
  /** Optional Discord DM injector (defaults to live `getDiscordBot()`-backed adapter). */
  discord?: DiscordDmAdapter | null;
  /** Optional LINE injector (defaults to live `getChatMirror()`-backed adapter). */
  line?: LineDirectAdapter | null;
  /**
   * Base URL for the [查看局面] link in the notification body. Falls back to
   * `process.env.WEB_BASE_URL` then to `http://localhost:5173`. Trailing
   * slashes are normalised away.
   */
  webBaseUrl?: string;
  /** Custom logger (defaults to console). */
  logger?: AsyncNotifierLogger;
}

/**
 * Build the throttle key for a (room, phase) ping. Includes round + attempt
 * so a re-vote (failCount++) opens a fresh notification window.
 */
function makeThrottleKey(roomId: string, p: PendingDecision, playerId: string): string {
  return `${roomId}|${p.phase}|R${p.round}|A${p.attempt}|${playerId}`;
}

function makeGameEndedKey(roomId: string): string {
  return `${roomId}|ended`;
}

/**
 * Format the outbound message body. Centralised so both Discord and LINE
 * see the same string (one source of truth, easier QA).
 */
export function formatPendingMessage(
  room: Room,
  pending: PendingDecision,
  webBaseUrl: string,
): string {
  const phaseLabel = refinePhaseLabel(room, pending);
  const url = `${webBaseUrl}/room/${room.id}`;
  const round = pending.round > 0 ? `第 ${pending.round} 任務 · ` : '';
  return `棋瓦 ${room.id}: 輪到你了 — ${round}${phaseLabel}\n查看局面: ${url}`;
}

export function formatGameEndedMessage(room: Room, webBaseUrl: string): string {
  const url = `${webBaseUrl}/room/${room.id}`;
  const winner =
    room.evilWins === true ? '邪惡獲勝' :
    room.evilWins === false ? '好人獲勝' :
    '局終';
  return `棋瓦 ${room.id}: ${winner}\n查看結果: ${url}`;
}

// ─── Default live adapters ─────────────────────────────────────────────────

/**
 * Live Discord DM adapter — wraps `getDiscordBot()` so callers (and tests)
 * see the same `DiscordDmAdapter` surface either way.
 */
function buildLiveDiscordAdapter(logger: AsyncNotifierLogger): DiscordDmAdapter | null {
  return {
    sendDm: async (discordUserId, text) => {
      const bot = getDiscordBot();
      if (!bot || !bot.isClientReady()) {
        // Bot not booted yet — soft-fail so caller doesn't crash the engine.
        logger.warn(`Discord bot not ready, skipping DM to ${discordUserId}`);
        return;
      }
      const user = await bot.getClient().users.fetch(discordUserId);
      await user.send(text);
    },
  };
}

/**
 * Live LINE adapter — uses ChatMirror.pushDirect (added in same commit).
 * Returns null when no ChatMirror is initialised so callers know the
 * channel is disabled (vs. configured-but-failing).
 */
function buildLiveLineAdapter(logger: AsyncNotifierLogger): LineDirectAdapter | null {
  return {
    pushDirect: async (lineUserId, text) => {
      const mirror = getChatMirror();
      if (!mirror) {
        logger.warn(`ChatMirror not initialised, skipping LINE push to ${lineUserId}`);
        return;
      }
      await mirror.pushDirect(lineUserId, text);
    },
  };
}

// ─── Core class ────────────────────────────────────────────────────────────

export class AsyncNotifier {
  private readonly discord: DiscordDmAdapter | null;
  private readonly line: LineDirectAdapter | null;
  private readonly webBaseUrl: string;
  private readonly logger: AsyncNotifierLogger;
  /** Throttle store — Set is fine; entries never need expiry within a single game. */
  private readonly sent: Set<string> = new Set();

  constructor(config: AsyncNotifierConfig = {}) {
    this.logger = config.logger ?? defaultLogger;
    // `null` means "explicitly disabled"; `undefined` means "use live adapter".
    this.discord =
      config.discord === null
        ? null
        : config.discord ?? buildLiveDiscordAdapter(this.logger);
    this.line =
      config.line === null
        ? null
        : config.line ?? buildLiveLineAdapter(this.logger);
    const raw = (config.webBaseUrl ?? process.env.WEB_BASE_URL ?? 'http://localhost:5173').trim();
    this.webBaseUrl = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  }

  /**
   * Notify the players in `pending.pendingActors` that they owe an action.
   * No-op for realtime rooms, empty pending lists, or already-throttled
   * (room, phase, round, attempt, playerId) tuples.
   *
   * Returns a summary count for observability / tests; callers should NOT
   * await this in a hot path (engine fires it as fire-and-forget).
   */
  public async notify(
    room: Room,
    pending: PendingDecision,
  ): Promise<{ pinged: number; throttled: number; skipped: number }> {
    if (room.mode !== 'async') {
      return { pinged: 0, throttled: 0, skipped: 0 };
    }
    const actors = pending.pendingActors;
    if (!actors || actors.length === 0) {
      return { pinged: 0, throttled: 0, skipped: 0 };
    }

    let pinged = 0;
    let throttled = 0;
    let skipped = 0;

    const text = formatPendingMessage(room, pending, this.webBaseUrl);

    // Fan out in parallel — per-player failures are swallowed inside pushOne.
    await Promise.all(
      actors.map(async (playerId) => {
        const key = makeThrottleKey(room.id, pending, playerId);
        if (this.sent.has(key)) {
          throttled++;
          return;
        }
        const player = room.players[playerId];
        if (!player) {
          skipped++;
          this.logger.warn(`pending actor ${playerId} not in room.players (room=${room.id})`);
          return;
        }
        const sentAny = await this.pushToPlayer(player, text);
        if (sentAny) {
          this.sent.add(key);
          pinged++;
        } else {
          skipped++;
        }
      }),
    );

    this.logger.info(
      `room=${room.id} phase=${pending.phase} R${pending.round}/A${pending.attempt} ` +
        `pinged=${pinged} throttled=${throttled} skipped=${skipped}`,
    );
    return { pinged, throttled, skipped };
  }

  /**
   * Notify every player that the game has ended. Throttled per-room so
   * accidental double-fire from the engine still produces only one ping.
   */
  public async notifyGameEnded(room: Room): Promise<{ pinged: number; throttled: number; skipped: number }> {
    if (room.mode !== 'async') {
      return { pinged: 0, throttled: 0, skipped: 0 };
    }
    const key = makeGameEndedKey(room.id);
    if (this.sent.has(key)) {
      return { pinged: 0, throttled: 1, skipped: 0 };
    }
    this.sent.add(key);

    const text = formatGameEndedMessage(room, this.webBaseUrl);
    let pinged = 0;
    let skipped = 0;

    const players = Object.values(room.players);
    await Promise.all(
      players.map(async (player) => {
        const ok = await this.pushToPlayer(player, text);
        if (ok) pinged++;
        else skipped++;
      }),
    );

    this.logger.info(`room=${room.id} game_ended pinged=${pinged} skipped=${skipped}`);
    return { pinged, throttled: 0, skipped };
  }

  /**
   * Test-only: clear the throttle so the same (room, phase, ...) can fire
   * again. Production code never needs this — entries are bounded by the
   * number of (phase, round, attempt) tuples in a single game.
   */
  public __resetThrottleForTests(): void {
    this.sent.clear();
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /**
   * Push the text to whatever channels this player supports.
   * Returns true if at least one channel succeeded (so the throttle marks
   * "we tried"), false if no channel was available / all failed.
   */
  private async pushToPlayer(player: Player, text: string): Promise<boolean> {
    let success = false;

    const discordId = extractDiscordUserId(player.id);
    if (discordId && this.discord) {
      try {
        await this.discord.sendDm(discordId, text);
        success = true;
      } catch (err) {
        this.logger.error(`Discord DM failed for ${player.id}`, err);
      }
    }

    if (player.id.startsWith(LINE_ID_PREFIX) && this.line) {
      const lineUserId = player.id.slice(LINE_ID_PREFIX.length);
      if (lineUserId) {
        try {
          await this.line.pushDirect(lineUserId, text);
          success = true;
        } catch (err) {
          this.logger.error(`LINE push failed for ${player.id}`, err);
        }
      }
    }

    return success;
  }
}

// ─── Singleton wiring ──────────────────────────────────────────────────────

let asyncNotifierInstance: AsyncNotifier | null = null;

/**
 * Initialise (once) and return the process-wide AsyncNotifier. Idempotent —
 * subsequent calls return the existing instance and ignore `config`.
 */
export function initializeAsyncNotifier(config: AsyncNotifierConfig = {}): AsyncNotifier {
  if (asyncNotifierInstance) return asyncNotifierInstance;
  asyncNotifierInstance = new AsyncNotifier(config);
  return asyncNotifierInstance;
}

export function getAsyncNotifier(): AsyncNotifier | null {
  return asyncNotifierInstance;
}

/** Test-only: reset the singleton so each test gets a clean instance. */
export function __resetAsyncNotifierForTests(): void {
  asyncNotifierInstance = null;
}
