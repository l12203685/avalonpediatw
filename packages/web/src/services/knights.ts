/**
 * AI騎士 名冊（站長 2026-11-26：「所以如果練習台想呼叫AI騎士_ED 有辦法嗎」）：練習台與房間「指定哪一位 AI騎士」的選單。
 *
 * 伺服器 `knights:list`（packages/server/src/arena/knights.ts）回傳官方 AI騎士 清單（百科在第一個）。
 * 舊版伺服器沒有這個事件：等不到就只列百科，選單照樣能用（加機器人、練習照舊）。
 */
import { useEffect, useState } from 'react';
import { getSocket } from './socket';

export interface KnightSummary {
  id: string;
  /** 不帶座位序號的名字（`AI騎士_ED`）；房間裡的座位名另外加 `_01`、`_02`。 */
  name: string;
  tag?: string;
  style: string;
  /** 學習樣本（站長 2026-11-27）：網站真人局場數、拿來學的座位數。百科、舊版伺服器沒有。 */
  samples?: { games: number; seats: number };
}

export const DEFAULT_KNIGHT_ID = 'baike';
/** 練習台「隨機混搭」：每個機器人座位各抽一位。 */
export const KNIGHT_MIX_ID = 'random-mix';

export const FALLBACK_KNIGHTS: readonly KnightSummary[] = [
  { id: DEFAULT_KNIGHT_ID, name: 'AI騎士_百科', style: '目前訓練出來的百科AI 本身，沒有另外調任何開關。' },
];

const ACK_TIMEOUT_MS = 6000;
let cache: KnightSummary[] | null = null;
let inflight: Promise<KnightSummary[]> | null = null;

function isSummary(v: unknown): v is KnightSummary {
  const k = v as KnightSummary;
  return typeof k === 'object' && k !== null && typeof k.id === 'string' && typeof k.name === 'string' && typeof k.style === 'string';
}

/** 讀名冊（成功一次就快取；失敗回百科一位、下次再試）。 */
export function fetchKnights(): Promise<KnightSummary[]> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = new Promise<KnightSummary[]>((resolve) => {
    let socket;
    try {
      socket = getSocket();
    } catch {
      resolve([...FALLBACK_KNIGHTS]);
      return;
    }
    socket.timeout(ACK_TIMEOUT_MS).emit('knights:list', (err: Error | null, res: { ok?: boolean; knights?: unknown }) => {
      const list = !err && res?.ok && Array.isArray(res.knights) ? res.knights.filter(isSummary) : [];
      if (list.length > 0) {
        cache = list;
        resolve(list);
      } else {
        resolve([...FALLBACK_KNIGHTS]);
      }
    });
  }).finally(() => { inflight = null; });
  return inflight;
}

/**
 * 名冊 hook：讀到之前先顯示百科。`enabled` = false 時不去問（例如還沒連線）。
 * 沒讀到（還沒連上、舊版伺服器）每 3 秒再試，最多 5 次；`ready` = 讀到名冊或放棄了。
 */
export function useKnights(enabled = true): { knights: readonly KnightSummary[]; ready: boolean } {
  const [knights, setKnights] = useState<readonly KnightSummary[]>(cache ?? FALLBACK_KNIGHTS);
  const [ready, setReady] = useState(cache !== null);
  useEffect(() => {
    if (!enabled) return;
    if (cache) { setKnights(cache); setReady(true); return; }
    let alive = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (): void => {
      tries++;
      void fetchKnights().then((list) => {
        if (!alive) return;
        setKnights(list);
        if (cache || tries >= 5) setReady(true);
        else timer = setTimeout(attempt, 3000);
      });
    };
    attempt();
    return (): void => { alive = false; if (timer) clearTimeout(timer); };
  }, [enabled]);
  return { knights, ready };
}

/** `AI騎士_ED` → `ED`（小標籤用）。 */
export function knightShortName(name: string): string {
  return name.replace(/^AI騎士_/, '');
}

/**
 * 一句話的說明（房間選單用）：官方 AI騎士 的說明是「依一位玩家…擬合的打法。風格「藏鋒」：梅林比其他 AI騎士藏得深。和百科AI 不同的地方：…」，
 * 取「風格「X」：」後面那一句；其他取第一句。
 */
export function knightBlurb(style: string): string {
  const m = /風格「[^」]+」：([^。]+)。?/.exec(style);
  if (m) return m[1].trim();
  const first = style.split('。')[0]?.trim() ?? '';
  return first || style.trim();
}

/** 選單上的一小行「學習樣本 299 場」（站長 2026-11-27）；沒有樣本數（百科、舊版伺服器）→ 空字串。 */
export function knightSamplesLine(k: Pick<KnightSummary, 'samples'>): string {
  return k.samples && k.samples.games > 0 ? `學習樣本 ${k.samples.games} 場` : '';
}
