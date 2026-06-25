/**
 * GitHub 完賽歸檔 (Edward 2026-06-25「遊戲紀錄...直接寫入並存放在 github 上」)。
 *
 * 設計原則 — 為什麼這樣做：
 *   - GitHub 不是資料庫：commit 有延遲(0.5~2s)、流量上限、併發會撞版本。所以
 *     **只在一場遊戲結束後**把該局的 V2 record 當「一場一檔」append-only JSON
 *     寫進一個 repo。live 遊戲狀態仍留在伺服器記憶體 + Socket.IO，維持即時，
 *     完全不受 GitHub 延遲影響。
 *   - 一場一個檔 `games/{YYYY}/{MM}/{gameId}.json` → 永不修改既有檔 → 不會
 *     merge 衝突；可直接在 github.com 上瀏覽 / git clone 全量備份。
 *
 * 啟用方式（未設定則靜默停用，完全 no-op — 對齊 mailer.ts 的行為）：
 *   GITHUB_RECORDS_TOKEN   一顆有目標 repo `contents:write` 權限的 PAT / fine-grained token
 *   GITHUB_RECORDS_REPO    "owner/repo"，例如 "l12203685/avalon-game-records"
 *   GITHUB_RECORDS_BRANCH  目標分支（預設 main）
 *   GITHUB_API_BASE        API base（預設 https://api.github.com；GHE 才需改）
 *
 * 隱私提醒：若 repo 為 public，戰績即公開。含 email / 私密欄位時請用 private repo。
 * V2 record 以 playerSeats(uid) 為主，預設不含 email，但仍建議 private 起步。
 */

import type { GameRecordV2 } from '@avalon/shared';

const TOKEN  = process.env.GITHUB_RECORDS_TOKEN  || '';
const REPO   = process.env.GITHUB_RECORDS_REPO   || '';
const BRANCH = process.env.GITHUB_RECORDS_BRANCH || 'main';
const API    = process.env.GITHUB_API_BASE       || 'https://api.github.com';

/** True iff token + "owner/repo" 都設定好，歸檔才會實際送出。 */
export function isGitHubArchiveConfigured(): boolean {
  return TOKEN.length > 0 && /^[^/\s]+\/[^/\s]+$/.test(REPO);
}

/** 一場一檔的路徑：games/{YYYY}/{MM}/{gameId}.json（UTC 分桶，避免單目錄爆量）。 */
function recordPath(record: GameRecordV2): string {
  const playedAt = typeof record.playedAt === 'number' ? record.playedAt : Date.now();
  const d = new Date(playedAt);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `games/${yyyy}/${mm}/${record.gameId}.json`;
}

function ghHeaders(): Record<string, string> {
  return {
    Authorization:           `Bearer ${TOKEN}`,
    Accept:                  'application/vnd.github+json',
    'X-GitHub-Api-Version':  '2022-11-28',
    'User-Agent':            'avalonpediatw-archive',
  };
}

/**
 * 把一筆完賽 V2 record 歸檔到 GitHub。**Best-effort**：
 *   - 未配置 → 直接 return（no-op）
 *   - 任何網路 / API 錯誤都只記 log，絕不 throw 回 caller（不可阻塞 game flow）
 *   - 同 gameId 已存在 → 視為冪等，跳過（完賽紀錄不會再變動）
 *
 * 呼叫端應 fire-and-forget：`void archiveGameRecordToGitHub(rec)`。
 */
export async function archiveGameRecordToGitHub(record: GameRecordV2): Promise<void> {
  if (!isGitHubArchiveConfigured()) return; // 靜默停用
  if (!record || typeof record.gameId !== 'string' || record.gameId.length === 0) return;

  const path = recordPath(record);
  const url  = `${API}/repos/${REPO}/contents/${encodeURI(path)}`;
  const content = Buffer.from(JSON.stringify(record, null, 2), 'utf8').toString('base64');

  try {
    // 冪等檢查：檔已存在就跳過（避免覆寫 / 重複 commit）。
    const head = await fetch(`${url}?ref=${encodeURIComponent(BRANCH)}`, { headers: ghHeaders() });
    if (head.status === 200) {
      return;
    }

    const winner = record.finalResult?.winnerCamp ?? '?';
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `archive: game ${record.gameId} (${winner})`,
        content,
        branch: BRANCH,
      }),
    });

    // 422 = 併發下別的 instance 剛建好同檔，當成功處理。
    if (!res.ok && res.status !== 422) {
      const txt = await res.text().catch(() => '');
      console.error(
        JSON.stringify({
          event: 'github_archive_error',
          gameId: record.gameId,
          status: res.status,
          detail: txt.slice(0, 200),
        }),
      );
      return;
    }

    console.log(JSON.stringify({ event: 'github_archive_ok', gameId: record.gameId, path }));
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'github_archive_exception',
        gameId: record.gameId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
