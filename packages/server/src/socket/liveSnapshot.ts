/**
 * 伺服器更新時保存進度（站長 2026-11-26：「你未來可以先確定沒有影響進行中的局或任務再合併嗎 或是會影響就會儲存進度」）。
 *
 * Render 換版的順序（docs/RENDER_FREE_DEPLOY.md）：新的一台先起來、流量切過去；**60 秒後**舊的那台才收到 SIGTERM，
 * 最多再活 30 秒。舊的那台上的玩家這段時間照常在打（socket 還連在舊的那台）。所以：
 *
 *   舊的那台收到 SIGTERM → 先把遊戲內回饋、練習局回答寫掉 → 拍下每一間「有真人」的房間（saveOnShutdown）→ 不再收
 *   對局動作 → 寫進存檔（services/liveStateStore.ts，私人試算表、加密）→ 結束程序；玩家的連線斷掉、自動重連到新的那台。
 *
 *   新的那台：開機讀一次，之後 5 分鐘內每 10 秒看一次存檔有沒有新的一份（startBootPolling）；玩家重連時要進的房間
 *   還不在，也先看一次存檔（ensureRoom）。讀到就把房間接回來（GameServer.restoreLiveSnapshot：房間、引擎、計時器剩下
 *   的時間、機器人、練習紀錄），然後把存檔清空（不會被讀第二次）。超過 15 分鐘的存檔不讀。
 *
 * 存檔裡：房間（含角色、票、任務、湖中）、引擎的內部狀態、計時器還剩多久、房間密碼、機器人的策略層與指定的 AI騎士、開局時間、
 * 練習房的決策紀錄。整份加密，只在私人試算表；log 只有數字。
 */
import type { Room } from '@avalon/shared';
import type { GameEngineState, PracticeAssignment } from '../game/GameEngine';
import type { PracticeSession } from '../practice/PracticeSessions';
import { LiveStateUnreadableError, type LiveStateStore } from '../services/liveStateStore';

export const LIVE_SNAPSHOT_VERSION = 1;
/** 超過這麼久的存檔不讀（站長的題目：「例如 15 分鐘」）。 */
export const LIVE_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;
/** 開機後多久以內回頭看存檔（舊的那台在新的起來 60 秒後才收到 SIGTERM，再加寫檔時間）。 */
export const LIVE_HANDOVER_MS = 5 * 60 * 1000;
export const LIVE_POLL_MS = 10 * 1000;
/** 接回來後每個階段的計時器至少留這麼久，讓玩家有時間連回來。 */
export const LIVE_RESUME_FLOOR_MS = 45 * 1000;
/** 接回來後玩家看到的一句。 */
export const LIVE_RESTORED_TEXT = '伺服器更新完成，已恢復進度';
/** 舊的那台關機前發的一句。 */
export const LIVE_SAVING_TEXT = '伺服器更新中：這一局已經存好，幾秒後會自動接回來（不用重新整理）';

/** 練習房的紀錄（Set 攤成陣列）。 */
export type StoredPracticeSession = Omit<PracticeSession, 'flaggedEntryIds'> & { flaggedEntryIds: number[] };

export interface LiveRoomSnapshot {
  room: Room;
  /** 大廳的房間沒有。 */
  engine: GameEngineState | null;
  practiceConfig: PracticeAssignment | null;
  /** 這個階段的計時器還剩多久（null＝沒在跑：無限思考時間、棋瓦）。 */
  timerRemainingMs: number | null;
  password: string | null;
  /**
   * 機器人：id、策略層（null＝基準線）、指定的 AI騎士（名冊 id；null＝沒指定＝百科）。
   * `knight` 是後來加的：舊版存的檔沒有這一欄，讀成 null（和以前一樣接回百科）。
   */
  bots: Array<{ id: string; profile: string | null; knight: string | null }>;
  startedAt: number | null;
  /** 玩家 id → supabase id（戰績寫入用；正式機沒設定 supabase 時是空的）。 */
  supabaseIds: Record<string, string>;
  practice: StoredPracticeSession | null;
}

export interface LiveSnapshotFile {
  version: number;
  savedAt: number;
  rooms: LiveRoomSnapshot[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 存檔 → 讀得懂的內容；版本不同、太舊、壞掉 → null（附原因）。內容是加密過、有驗證的（GCM），只檢查形狀。
 */
export function parseLiveSnapshot(json: unknown, now: number, maxAgeMs = LIVE_SNAPSHOT_MAX_AGE_MS): { file: LiveSnapshotFile } | { file: null; reason: 'version' | 'stale' | 'shape' } {
  if (!isObj(json) || json.version !== LIVE_SNAPSHOT_VERSION) return { file: null, reason: 'version' };
  if (typeof json.savedAt !== 'number' || !Array.isArray(json.rooms)) return { file: null, reason: 'shape' };
  if (now - json.savedAt > maxAgeMs || json.savedAt - now > 60_000) return { file: null, reason: 'stale' };
  const rooms: LiveRoomSnapshot[] = [];
  for (const r of json.rooms as unknown[]) {
    if (!isObj(r) || !isObj(r.room) || typeof r.room.id !== 'string' || !isObj(r.room.players)) continue;
    if (r.engine !== null && (!isObj(r.engine) || r.engine.roomId !== r.room.id)) continue;
    rooms.push({
      room: r.room as unknown as Room,
      engine: (r.engine as GameEngineState | null) ?? null,
      practiceConfig: isObj(r.practiceConfig) ? (r.practiceConfig as unknown as PracticeAssignment) : null,
      timerRemainingMs: typeof r.timerRemainingMs === 'number' && Number.isFinite(r.timerRemainingMs) ? r.timerRemainingMs : null,
      password: typeof r.password === 'string' && r.password ? r.password : null,
      bots: Array.isArray(r.bots)
        ? (r.bots as unknown[]).flatMap((b) => (isObj(b) && typeof b.id === 'string'
          ? [{ id: b.id, profile: typeof b.profile === 'string' ? b.profile : null, knight: typeof b.knight === 'string' && b.knight ? b.knight : null }]
          : []))
        : [],
      startedAt: typeof r.startedAt === 'number' ? r.startedAt : null,
      supabaseIds: isObj(r.supabaseIds)
        ? Object.fromEntries(Object.entries(r.supabaseIds).filter((e): e is [string, string] => typeof e[1] === 'string'))
        : {},
      practice: isObj(r.practice) && typeof r.practice.roomId === 'string' ? (r.practice as unknown as StoredPracticeSession) : null,
    });
  }
  return { file: { version: LIVE_SNAPSHOT_VERSION, savedAt: json.savedAt, rooms } };
}

/** GameServer 提供給這裡的幾件事。 */
export interface LiveSnapshotHost {
  /** 寫掉還在記憶體、重啟會丟的東西（遊戲內回饋、練習局回答）。 */
  flushPendingWrites(): Promise<void>;
  buildLiveSnapshot(now: number): LiveSnapshotFile;
  /** 不再收對局動作；跟房間裡的人說一聲。 */
  freezeForShutdown(roomIds: readonly string[]): void;
  /** 接回來；已經有的房間不動。回接回來幾間。 */
  restoreLiveSnapshot(file: LiveSnapshotFile, now: number): number;
  hasRoom(roomId: string): boolean;
}

/** /api/bots/status → live.restart（只有數字和固定字）。 */
export interface LiveRestartStatus {
  /** 有存檔的地方（私人試算表）。 */
  configured: boolean;
  /** 這台開機後接回來幾間。 */
  restoredRooms: number;
  /** 最近一次讀存檔的結果。 */
  lastRead: 'none' | 'empty' | 'restored' | 'stale' | 'version' | 'unreadable' | 'error' | 'skipped';
  /** 關機時存了幾間（這台關機時才會有）。 */
  savedRooms: number;
  saveFailures: number;
}

export interface LiveRestoreOptions {
  now?: () => number;
  maxAgeMs?: number;
  handoverMs?: number;
  pollMs?: number;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

export class LiveRestore {
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly handoverMs: number;
  private readonly pollMs: number;
  private readonly logger: { info: (m: string) => void; warn: (m: string) => void };
  private readonly bootAt: number;
  private inflight: Promise<number> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private readonly seenVersions = new Set<string>();
  private stopped = false;
  private readonly counts: Omit<LiveRestartStatus, 'configured'> = { restoredRooms: 0, lastRead: 'none', savedRooms: 0, saveFailures: 0 };

  constructor(
    private readonly host: LiveSnapshotHost,
    private readonly store: Pick<LiveStateStore, 'read' | 'write'> | null,
    opts: LiveRestoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? LIVE_SNAPSHOT_MAX_AGE_MS;
    this.handoverMs = opts.handoverMs ?? LIVE_HANDOVER_MS;
    this.pollMs = opts.pollMs ?? LIVE_POLL_MS;
    this.logger = opts.logger ?? {
      // eslint-disable-next-line no-console
      info: (m): void => { console.log(`[live-state] ${m}`); },
      // eslint-disable-next-line no-console
      warn: (m): void => { console.warn(`[live-state] ${m}`); },
    };
    this.bootAt = this.now();
  }

  status(): LiveRestartStatus {
    return { configured: !!this.store, ...this.counts };
  }

  /** 開機後的這段時間（舊的那台可能還在跑、還沒存檔）。 */
  inHandover(): boolean {
    return !!this.store && !this.stopped && this.now() - this.bootAt < this.handoverMs;
  }

  /** 開機讀一次，之後每 pollMs 看一次，直到 handoverMs 過去。 */
  startBootPolling(): void {
    if (!this.store) {
      this.logger.warn('no live-state store (GOOGLE_SERVICE_ACCOUNT_JSON / JWT_SECRET): rooms are not saved across restarts');
      return;
    }
    void this.tryRestore();
    this.poller = setInterval(() => {
      if (!this.inHandover()) {
        if (this.poller) clearInterval(this.poller);
        this.poller = null;
        return;
      }
      void this.tryRestore();
    }, this.pollMs);
    this.poller.unref?.();
  }

  /** 玩家要進的房間不在：剛開機的話先看一次存檔。回這間現在在不在。 */
  async ensureRoom(roomId: string): Promise<boolean> {
    if (this.host.hasRoom(roomId)) return true;
    if (!this.inHandover()) return false;
    await this.tryRestore();
    return this.host.hasRoom(roomId);
  }

  /** 讀存檔、接回來、清空存檔。同時只跑一個；從不丟錯。 */
  tryRestore(): Promise<number> {
    if (!this.store || this.stopped) return Promise.resolve(0);
    this.inflight ??= this.doRestore().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async doRestore(): Promise<number> {
    const store = this.store!;
    let got: { json: unknown; version: string } | null;
    try {
      got = await store.read('rooms');
    } catch (err) {
      this.counts.lastRead = err instanceof LiveStateUnreadableError ? 'unreadable' : 'error';
      return 0;
    }
    if (!got) {
      this.counts.lastRead = 'empty';
      return 0;
    }
    if (this.seenVersions.has(got.version)) {
      this.counts.lastRead = 'skipped';
      return 0;
    }
    this.seenVersions.add(got.version);
    const parsed = parseLiveSnapshot(got.json, this.now(), this.maxAgeMs);
    let restored = 0;
    if (parsed.file) {
      restored = this.host.restoreLiveSnapshot(parsed.file, this.now());
      this.counts.restoredRooms += restored;
      this.counts.lastRead = 'restored';
      this.logger.info(`restored ${restored} of ${parsed.file.rooms.length} saved rooms`);
    } else {
      this.counts.lastRead = parsed.reason === 'stale' ? 'stale' : 'version';
    }
    // 讀過就清空（只清自己讀到的那一版；別人剛寫了新的一份就不動）。
    try {
      await store.write('rooms', null, got.version);
    } catch {
      // 清不掉：下次讀到同一版會跳過（seenVersions），太舊的也不讀。
    }
    return restored;
  }

  /** SIGTERM：寫掉待寫的、拍下房間、不再收動作、存檔。回存了幾間。從不丟錯。 */
  async saveOnShutdown(): Promise<number> {
    this.stopped = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    try {
      await this.host.flushPendingWrites();
    } catch {
      // 寫不掉的照舊不見；不影響存房間。
    }
    const file = this.host.buildLiveSnapshot(this.now());
    this.host.freezeForShutdown(file.rooms.map((r) => r.room.id));
    if (!this.store || file.rooms.length === 0) return 0;
    try {
      const res = await this.store.write('rooms', file);
      if (!res.ok) throw new Error('too large');
      this.counts.savedRooms = file.rooms.length;
      this.logger.info(`saved ${file.rooms.length} rooms before exit`);
      return file.rooms.length;
    } catch {
      this.counts.saveFailures += 1;
      this.logger.warn(`saving ${file.rooms.length} rooms before exit failed`);
      return 0;
    }
  }
}
