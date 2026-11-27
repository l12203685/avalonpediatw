/**
 * 統一 AI騎士（B2）前端 API 服務與外部 AI 提示詞產生器。
 */

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

export type ClaimStatus = 'pending' | 'approved' | 'rejected';

export interface MyKnightClaim {
  id: string;
  playerId: string;
  knightId: string | null;
  note?: string;
  status: ClaimStatus;
  createdAt: string;
  reviewedAt?: string;
  reviewReason?: string;
}

export interface AdminKnightClaim extends MyKnightClaim {
  uid: string;
  displayName: string;
  reviewedBy?: string;
}

export interface KnobMeta {
  key: string;
  kind: 'number' | 'boolean';
  side: 'good' | 'evil' | 'assassin';
  min?: number;
  max?: number;
  defaultValue: number | boolean;
  zh: string;
  en: string;
  zhUp: string;
  zhDown: string;
}

export interface OfficialKnightOption {
  id: string;
  name: string;
  playerId: string;
  tag?: string;
  style: string;
}

export type ResidualActionKey = 'team' | 'vote' | 'quest' | 'lakeTarget' | 'lakeClaim' | 'assassinate';

export interface KnightAdjustPayload {
  schema: 1;
  note?: string;
  source?: string;
  overrides?: Record<string, number | boolean>;
  sides?: {
    good?: Record<string, number | boolean>;
    evil?: Record<string, number | boolean>;
  };
  roles?: Record<string, Record<string, number | boolean>>;
  residualOff?: ResidualActionKey[];
}

export interface MyKnightHistoryItem {
  id: string;
  at: string;
  source: string;
  note?: string;
  feedback?: string;
  summary: string;
  adjust: KnightAdjustPayload;
}

export interface Layer1ProfileSummary {
  id: string;
  name: string;
  tag?: string;
  style: string;
  fit: 'fitted' | 'none';
  hasResidual: boolean;
  overrides?: Record<string, number | boolean>;
  sides?: Record<string, Record<string, number | boolean>>;
  roles?: Record<string, Record<string, number | boolean>>;
}

export interface MyKnightData {
  playerId: string;
  knightId: string | null;
  displayName: string;
  layer1: Layer1ProfileSummary | null;
  adjust: KnightAdjustPayload;
  updatedAt: string;
  history: MyKnightHistoryItem[];
}

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
    red?: FidelityMetricCell;
    blue?: FidelityMetricCell;
  };
  percivalTrustRound?: FidelityMetricCell;
  merlinRateGap?: FidelityMetricCell;
}

export interface FidelitySummary {
  knight: string;
  generatedAt: string | null;
  method: string | null;
  time: FidelitySplitMetrics | null;
  half: FidelitySplitMetrics | null;
}

export interface MyKnightResponse {
  user: {
    uid: string;
    displayName: string;
    isAdmin: boolean;
  };
  claims: MyKnightClaim[];
  knight: MyKnightData | null;
  fidelity: FidelitySummary | null;
  knobs: KnobMeta[];
  residualActions: ResidualActionKey[];
  officialKnights: OfficialKnightOption[];
}

export interface ValidateAdjustResponse {
  ok: boolean;
  errors: string[];
  warnings: string[];
  adjust: KnightAdjustPayload | null;
  diffSummary: string | null;
}

export class KnightApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'KnightApiError';
  }
}

async function knightFetch<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string } & T;
  if (!res.ok) {
    throw new KnightApiError(body.error || `API ${res.status}`, res.status, body.code);
  }
  return body;
}

export function fetchMyKnight(token: string): Promise<MyKnightResponse> {
  return knightFetch<MyKnightResponse>('/api/knights/me', token);
}

export function submitKnightClaim(
  token: string,
  playerId: string,
  note?: string,
): Promise<{ claim: MyKnightClaim }> {
  return knightFetch<{ claim: MyKnightClaim }>('/api/knights/claim', token, {
    method: 'POST',
    body: JSON.stringify({ playerId, ...(note?.trim() ? { note: note.trim() } : {}) }),
  });
}

export function validateKnightAdjust(
  token: string,
  adjust: unknown,
): Promise<ValidateAdjustResponse> {
  return knightFetch<ValidateAdjustResponse>('/api/knights/me/adjust/validate', token, {
    method: 'POST',
    body: JSON.stringify({ adjust }),
  });
}

export function saveKnightAdjust(
  token: string,
  adjust: KnightAdjustPayload,
  feedback?: string,
  source = 'web',
): Promise<{ ok: true; warnings: string[]; adjust: KnightAdjustPayload; updatedAt: string; history: MyKnightHistoryItem[] }> {
  return knightFetch('/api/knights/me/adjust', token, {
    method: 'PUT',
    body: JSON.stringify({
      adjust,
      ...(feedback?.trim() ? { feedback: feedback.trim() } : {}),
      source,
    }),
  });
}

export function fetchAdminKnightClaims(token: string): Promise<{ claims: AdminKnightClaim[] }> {
  return knightFetch<{ claims: AdminKnightClaim[] }>('/api/knights/admin/claims', token);
}

export function reviewAdminKnightClaim(
  token: string,
  claimId: string,
  decision: 'approved' | 'rejected',
  reason?: string,
): Promise<{ claim: AdminKnightClaim }> {
  return knightFetch<{ claim: AdminKnightClaim }>(
    `/api/knights/admin/claims/${encodeURIComponent(claimId)}/review`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({ decision, ...(reason?.trim() ? { reason: reason.trim() } : {}) }),
    },
  );
}

/** 從外部 AI 回覆中抽出 JSON 區塊（支援 ```json ... ``` 或純 JSON）。 */
export function extractJsonFromAiReply(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: '請先貼上 AI 產生的 JSON' };
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fence ? fence[1].trim() : trimmed;
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (err) {
    return {
      ok: false,
      error: `JSON 格式無法解析：${err instanceof Error ? err.message : '語法錯誤'}`,
    };
  }
}

export const RESIDUAL_ACTION_LABELS: Record<ResidualActionKey, string> = {
  team: '派隊',
  vote: '投票',
  quest: '任務牌',
  lakeTarget: '查驗對象',
  lakeClaim: '報湖宣告',
  assassinate: '刺殺',
};

/** 產生「用你自己的 AI 調整」可複製提示詞。 */
export function buildExternalAiPrompt(params: {
  knight: MyKnightData;
  fidelity: FidelitySummary | null;
  knobs: KnobMeta[];
  userGoal: string;
  gameLink: string;
}): string {
  const { knight, fidelity, knobs, userGoal, gameLink } = params;
  const knobLines = knobs.map((k) => {
    const range = k.kind === 'number' ? `數字 ${k.min}~${k.max}` : '布林 true/false';
    return `- ${k.key}（${k.side}，${range}，預設 ${String(k.defaultValue)}）：${k.zh} 調高/開：${k.zhUp} 調低/關：${k.zhDown}`;
  });

  const fidelityLines: string[] = [];
  const t = fidelity?.time;
  if (t) {
    const fmt = (label: string, cell?: FidelityMetricCell): void => {
      if (!cell || cell.V2 === null) return;
      const d = cell.D !== null ? `${(cell.D * 100).toFixed(1)}%` : '—';
      const v2 = `${(cell.V2 * 100).toFixed(1)}%`;
      fidelityLines.push(`- ${label}（n=${cell.n ?? 0}）：百科AI ${d} → 我的騎士 v2 ${v2}`);
    };
    fmt('整體', t.overall);
    fmt('投票', t.vote);
    fmt('任務牌', t.quest);
    fmt('派隊 Top1', t.teamTop1);
    fmt('查驗對象', t.lakeTarget);
    fmt('紅方報湖', t.lakeClaimRed);
    fmt('紅方非常規票 F1', t.abnormalF1?.red);
    fmt('藍方非常規票 F1', t.abnormalF1?.blue);
    fmt('派西信任回合', t.percivalTrustRound);
    fmt('梅林差距（越低越像）', t.merlinRateGap);
  }

  const sections = [
    `請幫我調整阿瓦隆百科「統一 AI騎士」的第 2 層設定（adjust JSON），讓它更像我的打法。`,
    ``,
    `## 我的資訊`,
    `- 玩家 ID：${knight.playerId}`,
    `- 騎士名稱：${knight.displayName}`,
    `- 我想要的調整方向：${userGoal.trim() || '（請根據下面的資料與開關表提出保守、具體的調整建議）'}`,
    ...(gameLink.trim() ? [`- 參考公開牌局連結：${gameLink.trim()}`] : []),
    ``,
    `## 目前第 1 層（牌譜擬合 profile）`,
    '```json',
    JSON.stringify(knight.layer1 ?? { fit: 'none', note: '尚無牌譜，使用預設百科AI 引擎' }, null, 2),
    '```',
    ``,
    `## 目前第 2 層（adjust）`,
    '```json',
    JSON.stringify(knight.adjust, null, 2),
    '```',
    ...(fidelityLines.length > 0 ? ['', '## 逐動作精準度（時間切分測試）', ...fidelityLines] : []),
    ``,
    `## 允許使用的白名單開關（只能用這些 key）`,
    ...knobLines,
    ``,
    `## 可選 residualOff 動作（停用殘差層、改純照第 1+2 層開關）`,
    `- 可填陣列元素：team, vote, quest, lakeTarget, lakeClaim, assassinate`,
    ``,
    `## 嚴格規則`,
    `1. 只能輸出白名單內的開關與允許範圍內的數值／布林值，不可新增其他欄位。`,
    `2. 不要寫任何程式碼，不要在 note 裡放網址或 @ 標記，也不要放入任何其他玩家的資料。`,
    `3. 請先用 2~4 句白話說明你調整了什麼、為什麼這樣調，再給我一個可直接貼回網站的 JSON 區塊：`,
    '```json',
    JSON.stringify({
      schema: 1,
      note: '簡短白話說明這次調整（最多 300 字）',
      overrides: {},
      sides: { good: {}, evil: {} },
      roles: {},
      residualOff: [],
    }, null, 2),
    '```',
  ];

  return sections.join('\n');
}
