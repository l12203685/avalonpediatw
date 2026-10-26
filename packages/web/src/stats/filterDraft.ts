/**
 * 篩選面板編輯中的篩選 (純函式，好測)：面板的各個欄位各自「擁有」一種子句 (分類、日期…)，改欄位 = 換掉那種
 * 子句；面板沒有欄位的子句 (分享連結或進階 JSON 來的：任務、湖、角色座位…) 原樣保留。
 */
import type {
  CategoryValue, Clause, ExcludePlayersClause, GameFilter, MetricId, OutcomeValue, PlayerSelector, WithPlayerClause,
} from '@avalon/shared/stats';

export const EMPTY_FILTER: GameFilter = { v: 1, clauses: [] };

export const CATEGORY_VALUES: readonly CategoryValue[] = ['線瓦', '面瓦', '娛樂', '未分類', '其他'];
export const OUTCOME_VALUES: readonly OutcomeValue[] = ['三紅', '三藍死', '三藍活'];
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** 面板有欄位的子句種類 (一種一條；withPlayer、excludePlayers 可以多條)。 */
export const PANEL_KINDS = [
  'category', 'source', 'date', 'weekday', 'venue', 'season', 'outcome', 'namedSeats', 'withPlayer', 'excludePlayers',
] as const;
type PanelKind = (typeof PANEL_KINDS)[number];

type ClauseOf<K extends Clause['kind']> = Extract<Clause, { kind: K }>;

export function clausesOf<K extends Clause['kind']>(filter: GameFilter | null, kind: K): Array<ClauseOf<K>> {
  return (filter?.clauses ?? []).filter((c): c is ClauseOf<K> => c.kind === kind);
}

/** 換掉某種子句 (null / [] = 拿掉)；放在原本第一條的位置，沒有就放最後。 */
export function withClauses<K extends Clause['kind']>(
  filter: GameFilter | null,
  kind: K,
  next: ClauseOf<K> | Array<ClauseOf<K>> | null,
): GameFilter {
  const base = filter ?? EMPTY_FILTER;
  const list = next === null ? [] : Array.isArray(next) ? next : [next];
  const at = base.clauses.findIndex((c) => c.kind === kind);
  const rest = base.clauses.filter((c) => c.kind !== kind);
  const clauses = at < 0 ? [...rest, ...list] : [...rest.slice(0, at), ...list, ...rest.slice(at)];
  return { ...base, clauses };
}

/** 面板沒有欄位的子句 (列在「其他條件」，可以刪)。 */
export function otherClauses(filter: GameFilter | null): Clause[] {
  return (filter?.clauses ?? []).filter((c) => !(PANEL_KINDS as readonly string[]).includes(c.kind));
}

export function removeClauseAt(filter: GameFilter | null, index: number): GameFilter {
  const base = filter ?? EMPTY_FILTER;
  return { ...base, clauses: base.clauses.filter((_, i) => i !== index) };
}

/** 分類欄位：勾選的分類 (反轉的子句換算成勾選的補集)。沒有子句 = 全部勾選。 */
export function selectedCategories(filter: GameFilter | null): CategoryValue[] {
  const c = clausesOf(filter, 'category')[0];
  if (!c) return [...CATEGORY_VALUES];
  return c.not ? CATEGORY_VALUES.filter((v) => !c.in.includes(v)) : CATEGORY_VALUES.filter((v) => c.in.includes(v));
}

/** 勾選的分類 → 子句：全勾 = 沒有子句；沒勾的比較少時寫成「不是…」(排除娛樂局 = 預設集同一條)。 */
export function categoryClause(selected: readonly CategoryValue[]): ClauseOf<'category'> | null {
  const on = CATEGORY_VALUES.filter((v) => selected.includes(v));
  const off = CATEGORY_VALUES.filter((v) => !selected.includes(v));
  if (!off.length) return null;
  if (!on.length) return { kind: 'category', in: [] as CategoryValue[] };
  return off.length < on.length ? { kind: 'category', in: off, not: true } : { kind: 'category', in: on };
}

/** 多選欄位 (來源、星期、地點、賽季、結果)：全選或都沒選 = 沒有子句。 */
export function listClause<K extends 'source' | 'weekday' | 'venue' | 'season' | 'outcome'>(
  kind: K,
  selected: readonly (string | number)[],
  all: readonly (string | number)[],
): ClauseOf<K> | null {
  const on = all.filter((v) => selected.includes(v));
  if (!on.length || on.length === all.length) return null;
  return { kind, in: on } as unknown as ClauseOf<K>;
}

export function listSelection(filter: GameFilter | null, kind: 'source' | 'weekday' | 'venue' | 'season' | 'outcome'): Array<string | number> {
  const c = clausesOf(filter, kind)[0] as { in: Array<string | number>; not?: boolean } | undefined;
  return c && !c.not ? [...c.in] : [];
}

/** 指標的分組 (面板的下拉選單)。 */
export const METRIC_GROUPS: ReadonlyArray<{ id: string; metrics: readonly MetricId[] }> = [
  { id: 'theory', metrics: ['roleTheory', 'positionTheory', 'overallTheory'] },
  { id: 'winRate', metrics: ['finalWinRate', 'missionWinRate', 'excessWinRate', 'roleFinalWinRate', 'merlinSurvivalRate', 'assassinHitRate'] },
  { id: 'toughness', metrics: ['r3RejectLoyal', 'r3RejectRed', 'evilTeamReject', 'goodTeamApprove', 'evilTeamRejectR3', 'goodTeamApproveR3'] },
  { id: 'activity', metrics: ['games', 'roleGames', 'daysSinceLastPlayed', 'daysSinceFirstPlayed'] },
];

/** 新增一條「排除玩家」規則的預設：角色理論 PR > 90 的人，整局排除 (Edward 10/14 的例子)。 */
export function defaultExcludeRule(): ExcludePlayersClause {
  return { kind: 'excludePlayers', scope: 'dropGames', who: { by: 'metric', metric: 'roleTheory', op: 'gt', pr: 90 } };
}

export function defaultWithPlayer(name = ''): WithPlayerClause {
  return { kind: 'withPlayer', player: name };
}

/** 規則換成依名字 / 依指標時保留能保留的欄位。 */
export function switchSelector(rule: ExcludePlayersClause, by: PlayerSelector['by']): ExcludePlayersClause {
  if (rule.who.by === by) return rule;
  return by === 'names'
    ? { ...rule, who: { by: 'names', names: [] } }
    : { ...rule, who: defaultExcludeRule().who };
}

/** 名字欄 (逗號、頓號、換行分隔) → 名字。 */
export function splitNames(text: string): string[] {
  return [...new Set(text.split(/[,，、\n]+/).map((s) => s.trim()).filter(Boolean))];
}

/**
 * 篩選裡還不能送出的子句 (名字沒填等)；送出時拿掉，不讓 sanitizeFilter 把整條丟掉後使用者不知道為什麼。
 */
export function completeFilter(filter: GameFilter): GameFilter {
  const clauses = filter.clauses.filter((c) => {
    if (c.kind === 'withPlayer') return c.player.trim().length > 0;
    if (c.kind === 'excludePlayers' && c.who.by === 'names') return c.who.names.length > 0;
    if (c.kind === 'excludePlayers' && c.who.by === 'metric') {
      const t = typeof c.who.pr === 'number' ? c.who.pr : c.who.value;
      return typeof t === 'number' && Number.isFinite(t);
    }
    if ('in' in c && Array.isArray((c as { in: unknown[] }).in)) return (c as { in: unknown[] }).in.length > 0;
    return true;
  });
  return { ...filter, clauses };
}

/** 兩個篩選是不是同一個 (子句順序不計)。 */
export function sameClause(a: Clause, b: Clause): boolean {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return [...v.map(norm)].sort();
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined && (v as Record<string, unknown>)[k] !== false)
        .map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** 預設集是否在篩選裡 (它的每一條子句都在)。 */
export function hasPreset(filter: GameFilter | null, preset: GameFilter): boolean {
  return preset.clauses.every((p) => (filter?.clauses ?? []).some((c) => sameClause(c, p)));
}

/**
 * 切換預設集：已套用 = 拿掉它的子句；沒套用 = 換掉同種子句 (例：「只看線瓦」換掉原本的分類條件)。
 */
export function togglePreset(filter: GameFilter | null, preset: GameFilter): GameFilter {
  const base = filter ?? EMPTY_FILTER;
  if (hasPreset(base, preset)) {
    return { ...base, clauses: base.clauses.filter((c) => !preset.clauses.some((p) => sameClause(c, p))) };
  }
  const kinds = new Set(preset.clauses.map((c) => c.kind as PanelKind | Clause['kind']));
  return { ...base, clauses: [...base.clauses.filter((c) => !kinds.has(c.kind)), ...preset.clauses] };
}
