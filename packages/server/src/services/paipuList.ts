/**
 * GET /api/analysis/paipu 的資料（網站「牌譜紀錄」頁籤，Edward 2026-10-30：「百科網站可以直接多一個頁籤是
 * 『牌譜紀錄與覆盤』…直接同步現在 DC 的牌譜紀錄與覆盤頻道」）。
 *
 * - 來源：packages/server/paipu_cache.json，由 refresh-analysis-cache.yml 每天跑 discord_paipu_export.py 產生、
 *   跟分析快取一起 commit（Discord 論壇每篇貼文 = 一局：標題、標籤、發文時間、解析後的牌譜；不含起始訊息原文，
 *   也不含討論串裡的回覆）。伺服器執行期不連 Discord、不需要任何金鑰。
 * - 檔案不存在或格式不對 → 503 'Paipu list not yet generated'（網站顯示「尚未產生」）。
 * - 回應本體組一次、預先壓成 gzip / brotli，強 ETag，If-None-Match → 304（同 /api/analysis/games）。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

/** 本機預覽或測試用另一份清單（比照 AVALON_GAMES_DATASET）；正式環境不設。 */
export const ENV_PAIPU_CACHE = 'AVALON_PAIPU_CACHE';
export const PAIPU_FORMAT = 'avalon-paipu';
export const PAIPU_VERSION = 1;
export const PAIPU_NOT_GENERATED = 'Paipu list not yet generated';

const PAIPU_PATHS = [
  path.resolve(__dirname, '..', '..', 'paipu_cache.json'),
  path.resolve(__dirname, '..', '..', '..', '..', '..', 'packages', 'server', 'paipu_cache.json'),
];

export interface PaipuPayload {
  identity: Buffer;
  gzip: Buffer;
  br: Buffer;
  etag: string;
  posts: number;
  /** 清單裡的貼文 id（回覆路由只讀這些貼文的討論串）。 */
  ids: ReadonlySet<string>;
  guildId: string;
}

export type PaipuLoad = { ok: true; payload: PaipuPayload } | { ok: false; status: number; error: string };

let loaded: PaipuLoad | null = null;

function paipuPaths(): string[] {
  const override = process.env[ENV_PAIPU_CACHE]?.trim();
  return override ? [path.resolve(override)] : PAIPU_PATHS;
}

/** 只看外形（format、version、posts 是陣列）；欄位的隱私形狀已由產生器在寫檔前檢查。 */
export function isPaipuDocument(doc: unknown): doc is { format: string; version: number; guildId: string; posts: unknown[] } {
  if (!doc || typeof doc !== 'object') return false;
  const d = doc as Record<string, unknown>;
  return d.format === PAIPU_FORMAT && d.version === PAIPU_VERSION && typeof d.guildId === 'string'
    && /^\d{15,22}$/.test(d.guildId) && Array.isArray(d.posts);
}

function build(): PaipuLoad {
  const file = paipuPaths().find((p) => fs.existsSync(p));
  if (!file) return { ok: false, status: 503, error: PAIPU_NOT_GENERATED };
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    console.error('[analysis/paipu] 讀取失敗：1');
    return { ok: false, status: 503, error: PAIPU_NOT_GENERATED };
  }
  if (!isPaipuDocument(doc)) {
    console.error('[analysis/paipu] 格式不符：1');
    return { ok: false, status: 503, error: PAIPU_NOT_GENERATED };
  }
  const identity = Buffer.from(JSON.stringify({ success: true, data: doc }), 'utf-8');
  return {
    ok: true,
    payload: {
      identity,
      gzip: zlib.gzipSync(identity, { level: 9 }),
      br: zlib.brotliCompressSync(identity, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }),
      etag: `"${crypto.createHash('sha1').update(identity).digest('hex')}"`,
      posts: doc.posts.length,
      ids: new Set(doc.posts.map((p) => String((p as { id?: unknown })?.id ?? '')).filter((id) => /^\d{15,22}$/.test(id))),
      guildId: doc.guildId,
    },
  };
}

/** 第一次呼叫時讀檔、檢查、壓縮；之後回傳同一份（invalidatePaipuPayload 清掉）。缺檔不快取，部署後補上即可讀到。 */
export function loadPaipuPayload(): PaipuLoad {
  if (loaded?.ok) return loaded;
  loaded = build();
  return loaded;
}

export function invalidatePaipuPayload(): void {
  loaded = null;
}
