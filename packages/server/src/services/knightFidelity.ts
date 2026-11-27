/**
 * 統一 AI騎士（B2）— 讀取逐動作精準度報告（`docs/ai/gap/knight_fidelity.json`）。
 *
 * 供「我的騎士」頁面顯示玩家騎士在各決策點（整體、任務牌、派隊、投票、查驗對象、紅方報湖、
 * 非常規票 F1、派西信任回合、梅林差距）與真人牌譜的一致率（D 百科AI / K v1 / V2 殘差層）。
 */

import fs from 'fs';
import path from 'path';

export interface FidelityMetricCell {
  n?: number;
  D: number | null;
  K: number | null;
  V2: number | null;
}

export interface FidelitySplitMetrics {
  overall?: FidelityMetricCell;
  quest?: FidelityMetricCell;
  teamTop1?: FidelityMetricCell;
  vote?: FidelityMetricCell;
  lakeTarget?: FidelityMetricCell;
  lakeClaimRed?: FidelityMetricCell;
  abnormalF1?: {
    red?: { n?: number; D: number | null; K: number | null; V2: number | null };
    blue?: { n?: number; D: number | null; K: number | null; V2: number | null };
  };
  percivalTrustRound?: FidelityMetricCell;
  merlinRateGap?: FidelityMetricCell;
  teamTop3?: { n?: number; V2: number | null };
  lakeTop3?: { n?: number; V2: number | null };
}

export interface KnightFidelityEntry {
  knight: string;
  time?: FidelitySplitMetrics;
  half?: FidelitySplitMetrics;
}

export interface KnightFidelityFile {
  generatedAt?: string;
  method?: string;
  medians?: {
    time?: Record<string, number>;
    half?: Record<string, number>;
  };
  knights?: KnightFidelityEntry[];
}

export interface KnightFidelitySummary {
  knight: string;
  generatedAt: string | null;
  method: string | null;
  time: FidelitySplitMetrics | null;
  half: FidelitySplitMetrics | null;
}

let cachedFile: KnightFidelityFile | null | undefined;

function candidatePaths(): string[] {
  return [
    path.resolve(__dirname, '../../../../docs/ai/gap/knight_fidelity.json'),
    path.resolve(process.cwd(), 'docs/ai/gap/knight_fidelity.json'),
    path.resolve(process.cwd(), '../../docs/ai/gap/knight_fidelity.json'),
  ];
}

export function loadKnightFidelityFile(): KnightFidelityFile | null {
  if (cachedFile !== undefined) return cachedFile;
  for (const p of candidatePaths()) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        cachedFile = JSON.parse(raw) as KnightFidelityFile;
        return cachedFile;
      }
    } catch {
      // try next path
    }
  }
  cachedFile = null;
  return null;
}

function foldKnightName(s: string): string {
  return s.normalize('NFKC').trim().toLowerCase().replace(/_\d{1,3}$/, '');
}

/** 依玩家 ID 或騎士名稱查詢逐動作精準度（支援 `ED`、`AI騎士_ED`、`AI騎士_ED_01`）。 */
export function findKnightFidelity(
  playerIdOrKnight: string,
  file: KnightFidelityFile | null = loadKnightFidelityFile(),
): KnightFidelitySummary | null {
  if (!file || !Array.isArray(file.knights)) return null;
  const raw = playerIdOrKnight.normalize('NFKC').trim();
  if (!raw) return null;

  const targetExact = raw.toLowerCase();
  const targetFolded = foldKnightName(raw);
  const targetPrefixed = foldKnightName(raw.startsWith('AI騎士_') ? raw : `AI騎士_${raw}`);

  const found = file.knights.find((entry) => {
    if (!entry || typeof entry.knight !== 'string') return false;
    const ek = entry.knight.normalize('NFKC').trim();
    const folded = foldKnightName(ek);
    return ek.toLowerCase() === targetExact || folded === targetFolded || folded === targetPrefixed;
  });

  if (!found) return null;
  return {
    knight: found.knight,
    generatedAt: typeof file.generatedAt === 'string' ? file.generatedAt : null,
    method: typeof file.method === 'string' ? file.method : null,
    time: found.time ?? null,
    half: found.half ?? null,
  };
}
