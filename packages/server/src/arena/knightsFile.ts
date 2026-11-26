/**
 * 官方 AI騎士 名冊 → `knights.generated.json`（`scripts/knightsGenerate.ts` 寫、`__tests__/knights.test.ts` 比對）。
 * 執行期不讀資料夾：伺服器只讀那份 JSON（`knights.ts`）。
 */
import * as path from 'path';
import { loadRoster } from './registry';
import type { BotProfile } from './profile';

export interface KnightsFileEntry {
  /** 資料夾名稱（`community-bots/_knights/<id>/`），也是練習台、房間指定騎士用的 id。 */
  id: string;
  profile: BotProfile;
}

export interface KnightsFile {
  note: string;
  knights: KnightsFileEntry[];
}

export const GENERATED_KNIGHTS_PATH = path.resolve(__dirname, 'knights.generated.json');

const NOTE = '自動產生，不要手改：community-bots/_knights/ 改了之後跑 pnpm --filter @avalon/server knights:generate';

/** 讀 `community-bots/_knights/`（同一套 `arena:check` 檢查），只收官方 AI騎士。 */
export function buildKnightsFile(dir?: string): { file: KnightsFile; rejected: { id: string; errors: string[] }[] } {
  const roster = loadRoster({ dir, includeExamples: false, includeHouse: true });
  const knights = roster.bots
    .filter((b) => b.source === 'house' && b.profile)
    .map((b) => ({ id: b.id, profile: b.profile! }));
  const rejected = roster.rejected.filter((r) => r.id.startsWith('_knights/'));
  return { file: { note: NOTE, knights }, rejected };
}

export function serializeKnightsFile(file: KnightsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
