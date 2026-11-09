/**
 * 網站「百科AI 對局」頁的型別與純函式（Edward 2026-11-05：「只要有百科AI參與的牌局就自動記錄在網站&DC上 我們可以直接針對AI的動作作反饋」）。
 *
 * 資料：伺服器 GET /api/ai-games（DC 論壇 #牌譜紀錄與覆盤 裡百科AI 對局的討論串）、GET /api/ai-games/:id（那篇附的 trace.json）。
 * 型別是 packages/server/src/services/aiGameTrace.ts 的結構複本（網站版的 seats 沒有真人暱稱）。
 * 純函式放這裡，packages/server/src/__tests__/WebAiGames.test.ts 測（web 沒有測試執行器）。
 */

export type AiDecisionKind = 'team' | 'vote' | 'mission' | 'lake' | 'declare' | 'assassinate';
export const AI_DECISION_KINDS: readonly AiDecisionKind[] = ['team', 'vote', 'mission', 'lake', 'declare', 'assassinate'];
export const AI_DECISION_KIND_LABEL: Readonly<Record<AiDecisionKind, string>> = {
  team: '派隊', vote: '投票', mission: '任務', lake: '湖', declare: '湖的宣告', assassinate: '刺殺',
};

export type Camp = 'good' | 'evil';

export interface AiGameSeat { seat: number; name: string; role: string; team: Camp | null; ai: boolean }
export interface AiGameProposal {
  round: number; attempt: number; leader: number; team: number[]; approve: number[]; reject: number[]; approved: boolean; forced: boolean;
}
export interface AiGameMission { round: number; team: number[]; fails: number; result: 'success' | 'fail' }
export interface AiGameLake { round: number; holder: number; target: number; claim: Camp | null }
export interface AiDecision {
  id: number; at: number; round: number; attempt: number; kind: AiDecisionKind; seat: number; nick: string; role: string; team: Camp;
  action: string;
  detail: { team?: number[]; vote?: boolean; card?: 'success' | 'fail'; target?: number; claim?: Camp | null; actual?: Camp };
  reason: string; rule?: string; suspectsLabel?: string; suspects?: { seat: number; score: number }[]; suspectsNote?: string; knowledge?: string;
  source: 'agent' | 'fallback';
}
export interface AiGameTrace {
  format: string; version: number; source: string; room: string; title: string; startedAt: string; endedAt: string;
  winner: Camp | null; seats: AiGameSeat[]; proposals: AiGameProposal[]; missions: AiGameMission[]; lakes: AiGameLake[];
  assassination: { target: number | null; hit: boolean | null } | null; decisions: AiDecision[]; notes: string[];
}
export interface AiGameListItem { id: string; name: string; createdAt: string; archived: boolean }

const ROLE_ZH: Readonly<Record<string, string>> = {
  merlin: '梅林', percival: '派西維爾', loyal: '忠臣', assassin: '刺客', morgana: '莫甘娜', mordred: '莫德雷德', oberon: '奧伯倫', minion: '爪牙',
};
export const roleZh = (role: string): string => ROLE_ZH[role] ?? role;
/** 座位 10 寫成 0家。 */
export const seatText = (seat: number): string => `${seat === 10 ? '0' : String(seat)}家`;
export function seatsText(seats: readonly number[]): string {
  if (!seats.length) return '無';
  return `${[...seats].sort((a, b) => a - b).map((s) => (s === 10 ? '0' : String(s))).join('、')}家`;
}

// ── 網址 ──────────────────────────────────────────────────────────────────────────────

/** #ai-games → { id: null }；#ai-games=<討論串 id> → { id }；其他 hash → null。也接受 #aigames、#ai-game。 */
export function parseAiGamesHash(hash: string | null | undefined): { id: string | null } | null {
  const raw = (hash ?? '').replace(/^#/, '').trim();
  if (/^ai-?games?$/i.test(raw)) return { id: null };
  const m = /^ai-?games?[=/]([0-9]{15,22})$/i.exec(raw);
  return m ? { id: m[1] } : null;
}

export function aiGamesHash(id?: string | null): string {
  return id ? `#ai-games=${id}` : '#ai-games';
}

// ── 清單 ──────────────────────────────────────────────────────────────────────────────

/** 討論串標題「百科AI對局 yyyymmdd_HHMM 房間描述／房號」→ 顯示用的時間與房間。讀不懂時 when 空字串、where＝標題。 */
export function parseAiGameName(name: string): { when: string; where: string } {
  const m = /^百科AI對局\s+(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})\s*(.*)$/.exec(name.trim());
  if (!m) return { when: '', where: name.replace(/^百科AI對局\s*/, '') };
  return { when: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`, where: m[6] || '' };
}

// ── 回顧 ──────────────────────────────────────────────────────────────────────────────

export interface ReviewBlock {
  key: string;
  title: string;
  /** 那一段的公開紀錄（例：「隊長 1家 → 1、3、4家\u3000贊成 …／反對 … → 通過」）。 */
  facts: string[];
  decisions: AiDecision[];
}
export interface ReviewSection { key: string; title: string; blocks: ReviewBlock[] }

function proposalFact(p: AiGameProposal): string {
  const head = `隊長 ${seatText(p.leader)} → ${seatsText(p.team)}`;
  if (p.forced) return `${head}（第 5 次強制出任務）`;
  return `${head}\u3000贊成 ${seatsText(p.approve)}／反對 ${seatsText(p.reject)} → ${p.approved ? '通過' : '否決'}`;
}

/**
 * 依局分段（同 DC 的後續訊息）：每一局＝每次提議（公開紀錄＋百科AI 的派隊、投票）、任務、湖；最後是刺殺。
 * `filter` 只留符合的決定（座位、種類）；沒有決定的段落還是留著公開紀錄，除非有篩選。
 */
export function reviewSections(t: AiGameTrace, filter: (d: AiDecision) => boolean = () => true, filtering = false): ReviewSection[] {
  const ds = t.decisions.filter(filter);
  const rounds = new Set<number>([
    ...t.proposals.map((p) => p.round), ...t.missions.map((m) => m.round), ...t.lakes.map((l) => l.round),
    ...t.decisions.filter((d) => d.kind !== 'assassinate').map((d) => d.round),
  ]);
  const out: ReviewSection[] = [];
  const keep = (b: ReviewBlock): boolean => b.decisions.length > 0 || (!filtering && b.facts.length > 0);
  for (const r of [...rounds].sort((a, b) => a - b)) {
    const blocks: ReviewBlock[] = [];
    const attempts = new Set<number>([
      ...t.proposals.filter((p) => p.round === r).map((p) => p.attempt),
      ...t.decisions.filter((d) => d.round === r && (d.kind === 'team' || d.kind === 'vote')).map((d) => d.attempt),
    ]);
    for (const a of [...attempts].sort((x, y) => x - y)) {
      const p = t.proposals.find((x) => x.round === r && x.attempt === a);
      blocks.push({
        key: `r${r}a${a}`, title: `第 ${a} 次提議`, facts: p ? [proposalFact(p)] : [],
        decisions: ds.filter((d) => d.round === r && d.attempt === a && (d.kind === 'team' || d.kind === 'vote')),
      });
    }
    const m = t.missions.find((x) => x.round === r);
    blocks.push({
      key: `r${r}m`, title: '任務',
      facts: m ? [`${seatsText(m.team)} → ${m.result === 'success' ? '成功' : '失敗'}（${m.fails} 張失敗）`] : [],
      decisions: ds.filter((d) => d.round === r && d.kind === 'mission'),
    });
    const l = t.lakes.find((x) => x.round === r);
    blocks.push({
      key: `r${r}l`, title: '湖',
      facts: l ? [`${seatText(l.holder)} 湖 ${seatText(l.target)}，${l.claim === 'good' ? '宣告好人' : l.claim === 'evil' ? '宣告壞人' : '沒有宣告'}`] : [],
      decisions: ds.filter((d) => d.round === r && (d.kind === 'lake' || d.kind === 'declare')),
    });
    const kept = blocks.filter(keep);
    if (kept.length) out.push({ key: `r${r}`, title: `第 ${r} 局`, blocks: kept });
  }
  const a = t.assassination;
  const kill: ReviewBlock = {
    key: 'kill', title: '刺殺',
    facts: a?.target ? [`刺客刺 ${seatText(a.target)}${a.hit === true ? '，刺中梅林' : a.hit === false ? '，沒中' : ''}`] : [],
    decisions: ds.filter((d) => d.kind === 'assassinate'),
  };
  if (keep(kill)) out.push({ key: 'kill', title: '刺殺', blocks: [kill] });
  return out;
}

/** 結果一句話（同 DC 摘要）。 */
export function resultText(t: Pick<AiGameTrace, 'winner' | 'missions' | 'assassination'>): string {
  const blue = t.missions.filter((m) => m.result === 'success').length;
  const red = t.missions.filter((m) => m.result === 'fail').length;
  const score = `任務 藍 ${blue}：紅 ${red}`;
  const a = t.assassination;
  const stab = a && a.target ? `刺客刺 ${seatText(a.target)}${a.hit === true ? ' 刺中梅林' : a.hit === false ? ' 沒中' : ''}` : '';
  if (t.winner === 'good') return `藍方勝（${[score, stab].filter(Boolean).join('，')}）`;
  if (t.winner === 'evil') return `紅方勝（${[score, red >= 3 ? '三紅' : stab].filter(Boolean).join('，')}）`;
  return `勝負不明（${score}）`;
}

/** 決定在哪一段：「第 2 局第 1 次」「第 2 局任務後」「刺殺」。 */
export function decisionWhere(d: Pick<AiDecision, 'kind' | 'round' | 'attempt'>): string {
  if (d.kind === 'assassinate') return '刺殺';
  if (d.kind === 'lake' || d.kind === 'declare') return `第 ${d.round} 局任務後`;
  if (d.kind === 'mission') return `第 ${d.round} 局${d.attempt ? `第 ${d.attempt} 次` : ''}任務`;
  return `第 ${d.round} 局第 ${d.attempt} 次`;
}
