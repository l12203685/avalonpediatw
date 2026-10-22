/**
 * featureStudies 的 L141「湖中宣告可信度」（generate_cache.wilson_interval、_claim_cell、_cell_text、
 * compute_lake_claim_feature、refresh_feature_studies 逐行移植；Edward 2026-10-14 複合篩選：網站「湖中女神」
 * 分頁的宣告可信度表在篩選後的局上重算，不篩選時與快取逐欄相同，中英文字串也一字不差）。
 *
 * 來源是文字記錄的湖行（資料集 `claims`：前三條「持湖>目標 x/o」，x = 宣告紅、o = 宣告藍、沒寫 = 沒宣告），
 * 不是 首湖 / 二湖 / 三湖 欄。持湖者、目標的陣營看配置：座位查不到角色（例如 "?"）時當忠臣 → 藍方（Python 同）。
 * 結果欄不用：沒有結果的局的湖行也算。
 *
 * 字串裡的百分比用 pyFormatFixed（Python 的 f"{x:.1f}" / f"{x:.0f}"：剛好一半時取偶數，toFixed 是往大的方向）。
 */
import { RED_ROLES } from './constants';
import type { Game, GamesDatasetConfig } from './dataset';
import { pyFormatFixed, rate, rnd1 } from './pyround';

/** generate_cache.LAKE_LABELS：文字記錄第 1 / 2 / 3 條湖行。 */
export const LAKE_LABELS: ReadonlyArray<readonly [zh: string, en: string]> = [
  ['首湖', 'Lake 1'],
  ['二湖', 'Lake 2'],
  ['三湖', 'Lake 3'],
];

/** wilson_interval 預設的 z（95%）。 */
export const WILSON_Z_95 = 1.959964;

export interface ClaimCell {
  n: number;
  hits: number;
  hitRate: number;
  /** Wilson 95% 區間下界、上界（%，一位小數）。 */
  ciLow: number;
  ciHigh: number;
  /** n < lakeClaimMinSample。 */
  lowSample: boolean;
}

export interface LakeClaimRow extends ClaimCell {
  lake: string;
  lakeEn: string;
  declared: '紅' | '藍';
  declaredEn: 'evil' | 'good';
}

export interface LakeClaimHolderRow extends ClaimCell {
  holder: '紅' | '藍';
  holderEn: 'evil' | 'good';
  declared: '紅' | '藍';
  declaredEn: 'evil' | 'good';
}

/** featureStudies.features 中 loopId = L141 的那筆（鍵與順序同快取）。 */
export interface LakeClaimFeature {
  loopId: 'L141';
  title: string;
  titleEn: string;
  oneLineHook: string;
  oneLineHookEn: string;
  sampleSize: { games: number; links: number };
  visualType: 'lakeClaim';
  data: {
    minSample: number;
    rows: LakeClaimRow[];
    holderRows: LakeClaimHolderRow[];
    /** 有湖行但沒有 x / o 宣告的條數（不在 rows 裡）。 */
    undeclared: number;
  };
  takeaway: string;
  takeawayEn: string;
  sourceReport: string;
  computedAt: string;
}

/** featureStudies 區塊（L141 之外的研究是站長電腦沿用的，引擎不重算，原樣帶過去）。 */
export interface FeatureStudiesSection {
  generatedAt: string;
  sampleSize: { games: number; lakeLinks: number } & Record<string, unknown>;
  features: Array<LakeClaimFeature | ({ loopId: string } & Record<string, unknown>)>;
  [key: string]: unknown;
}

type Side = '紅' | '藍';
const SIDES: readonly Side[] = ['紅', '藍'];
const HOLDER_SIDES: readonly Side[] = ['藍', '紅'];
const SIDE_EN: Readonly<Record<Side, 'evil' | 'good'>> = { 紅: 'evil', 藍: 'good' };

/** generate_cache.wilson_interval：hits / n 的 Wilson 區間（%，一位小數）；運算順序照抄。 */
export function wilsonInterval(hits: number, n: number, z: number = WILSON_Z_95): [number, number] {
  if (n <= 0) return [0, 0];
  const p = hits / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  // Python 的 max(0.0, x) / min(1.0, x)：相等時取第一個（數值相同）。
  const low = centre - half > 0 ? centre - half : 0;
  const high = centre + half < 1 ? centre + half : 1;
  return [rnd1(low * 100), rnd1(high * 100)];
}

/** generate_cache._claim_cell。 */
export function claimCell(hits: number, n: number, minSample: number): ClaimCell {
  const [ciLow, ciHigh] = wilsonInterval(hits, n);
  return { n, hits, hitRate: rate(hits, n), ciLow, ciHigh, lowSample: n < minSample };
}

/** generate_cache._cell_text：「70.4%（n=534）」。 */
function cellText(cell: ClaimCell): string {
  return `${pyFormatFixed(cell.hitRate, 1)}%（n=${cell.n}）`;
}

function cellTextEn(cell: ClaimCell): string {
  return `${pyFormatFixed(cell.hitRate, 1)}% (n=${cell.n})`;
}

const pct1 = (x: number): string => pyFormatFixed(x, 1);

/** 湖行的陣營：配置查得到的紅方角色 = 紅，其餘（含查不到 → 忠臣）= 藍。 */
function sideOf(g: Game, seat: string): Side {
  return RED_ROLES.has(g.seatRoles.get(seat) ?? '忠臣') ? '紅' : '藍';
}

/**
 * generate_cache.compute_lake_claim_feature：持湖者宣告目標紅 / 藍時，目標真的是那一方的比例，依湖序
 * （rows：首湖 / 二湖 / 三湖 × 宣告紅 / 藍）與持湖者陣營（holderRows：藍 / 紅 × 宣告紅 / 藍）。
 * `asOf` = computedAt（篩選時是有效 as-of）。
 */
export function computeLakeClaimFeature(games: readonly Game[], config: GamesDatasetConfig, asOf: string): LakeClaimFeature {
  const minSample = config.lakeClaimMinSample;
  // [n, hits]
  const byLake = new Map<string, [number, number]>();
  for (let i = 0; i < LAKE_LABELS.length; i += 1) for (const c of SIDES) byLake.set(`${i}|${c}`, [0, 0]);
  const byHolder = new Map<string, [number, number]>();
  for (const h of HOLDER_SIDES) for (const c of SIDES) byHolder.set(`${h}|${c}`, [0, 0]);
  let links = 0;
  let undeclared = 0;
  for (const g of games) {
    g.claims.forEach((line, i) => {
      links += 1;
      const claim = line.claim;
      if (!claim) {
        undeclared += 1;
        return;
      }
      const hit = sideOf(g, line.target) === claim ? 1 : 0;
      const holder = sideOf(g, line.holder);
      for (const cell of [byLake.get(`${i}|${claim}`), byHolder.get(`${holder}|${claim}`)]) {
        // 資料集最多三條湖行（parse_lake_claims(文字記錄)[:3]）；第四條以後 Python 會 KeyError，這裡不會發生。
        if (!cell) continue;
        cell[0] += 1;
        cell[1] += hit;
      }
    });
  }

  const cellOf = (map: Map<string, [number, number]>, key: string): ClaimCell => {
    const [n, hits] = map.get(key) as [number, number];
    return claimCell(hits, n, minSample);
  };
  const rows: LakeClaimRow[] = [];
  LAKE_LABELS.forEach(([lake, lakeEn], i) => {
    for (const declared of SIDES) {
      rows.push({ lake, lakeEn, declared, declaredEn: SIDE_EN[declared], ...cellOf(byLake, `${i}|${declared}`) });
    }
  });
  const holderRows: LakeClaimHolderRow[] = [];
  for (const holder of HOLDER_SIDES) {
    for (const declared of SIDES) {
      holderRows.push({
        holder, holderEn: SIDE_EN[holder], declared, declaredEn: SIDE_EN[declared],
        ...cellOf(byHolder, `${holder}|${declared}`),
      });
    }
  }
  const cell = (lake: string, declared: Side): LakeClaimRow =>
    rows.find((r) => r.lake === lake && r.declared === declared) as LakeClaimRow;
  const hcell = (holder: Side, declared: Side): LakeClaimHolderRow =>
    holderRows.find((r) => r.holder === holder && r.declared === declared) as LakeClaimHolderRow;
  const redTotal = claimCell(
    hcell('紅', '紅').hits + hcell('紅', '藍').hits,
    hcell('紅', '紅').n + hcell('紅', '藍').n,
    minSample,
  );
  const anyLow = rows.some((r) => r.lowSample);
  // Python 的提示字串寫死 30（不跟 LAKE_CLAIM_MIN_SAMPLE），照抄。
  const lowNote = anyLow ? '；n < 30 的格子樣本不足' : '';
  const lowNoteEn = anyLow ? '; cells with n < 30 are small samples' : '';
  const lakes = LAKE_LABELS.map(([zh]) => zh);
  const hook = '持湖者說紅時，目標真的是紅方：' + lakes.map((lk) => `${lk} ${cellText(cell(lk, '紅'))}`).join('、')
    + '；說藍時目標真的是藍方：' + lakes.map((lk) => `${lk} ${cellText(cell(lk, '藍'))}`).join('、') + lowNote;
  const hookEn = 'When the lake holder says evil, the target really is evil: '
    + LAKE_LABELS.map(([lk, en]) => `${en} ${cellTextEn(cell(lk, '紅'))}`).join(', ')
    + '; when they say good, the target really is good: '
    + LAKE_LABELS.map(([lk, en]) => `${en} ${cellTextEn(cell(lk, '藍'))}`).join(', ') + lowNoteEn;
  const takeaway = `藍方持湖幾乎不說謊（說紅 ${pct1(hcell('藍', '紅').hitRate)}%、說藍 ${pct1(hcell('藍', '藍').hitRate)}% 屬實），`
    + '所以看到湖中宣告先判斷持湖者的陣營，再決定信不信；'
    + `紅方持湖宣告的可信度只有約 ${pyFormatFixed(redTotal.hitRate, 0)}%`
    + `（說紅 ${pct1(hcell('紅', '紅').hitRate)}%、說藍 ${pct1(hcell('紅', '藍').hitRate)}% 屬實，n=${redTotal.n}），`
    + '紅方說「紅」多半是在誣陷藍方。';
  const takeawayEn = `A good lake holder almost never lies (${pct1(hcell('藍', '紅').hitRate)}% of their evil calls and `
    + `${pct1(hcell('藍', '藍').hitRate)}% of their good calls are true), so judge the holder's side first; `
    + `an evil holder's claim is right only about ${pyFormatFixed(redTotal.hitRate, 0)}% of the time `
    + `(${pct1(hcell('紅', '紅').hitRate)}% of evil calls, ${pct1(hcell('紅', '藍').hitRate)}% of good calls, n=${redTotal.n}): `
    + 'an evil holder calling someone evil is usually framing a good player.';
  return {
    loopId: 'L141',
    title: '湖中宣告可信度',
    titleEn: 'Lake claim reliability',
    oneLineHook: hook,
    oneLineHookEn: hookEn,
    sampleSize: { games: games.length, links },
    visualType: 'lakeClaim',
    data: { minSample, rows, holderRows, undeclared },
    takeaway,
    takeawayEn,
    sourceReport: 'generate_cache.py',
    computedAt: asOf,
  };
}

/**
 * generate_cache.refresh_feature_studies：`previous`（快取 / API 的 featureStudies；其他研究的結論已由產生器改寫過，
 * annotate_feature_studies 是冪等的，這裡不再做）的 L141 換成 `feature`（沒有就插在最前面），generatedAt = asOf，
 * sampleSize 的 games / lakeLinks 換成這組局的。L136 / L139 / L142 / L143 原樣（不是從資料集算的，篩選時標
 * 「未套用篩選」）。sampleSize.games = feature.sampleSize.games（Python 的 len(games)）。
 */
export function refreshFeatureStudies(
  previous: Partial<FeatureStudiesSection> | null | undefined,
  feature: LakeClaimFeature,
  asOf: string,
): FeatureStudiesSection {
  const section: Record<string, unknown> = previous ? { ...previous } : {};
  const features = (Array.isArray(section.features) ? section.features : [])
    .filter((f): f is FeatureStudiesSection['features'][number] => Boolean(f) && typeof f === 'object' && !Array.isArray(f));
  const index = features.findIndex((f) => f.loopId === feature.loopId);
  if (index < 0) features.unshift(feature);
  else features[index] = feature;
  const sample = { ...((section.sampleSize as Record<string, unknown> | undefined) ?? {}) };
  sample.games = feature.sampleSize.games;
  sample.lakeLinks = feature.sampleSize.links;
  const rest = Object.fromEntries(
    Object.entries(section).filter(([k]) => k !== 'generatedAt' && k !== 'sampleSize' && k !== 'features'),
  );
  return {
    generatedAt: asOf,
    sampleSize: sample as FeatureStudiesSection['sampleSize'],
    ...rest,
    features,
  };
}

/** 篩選後的 featureStudies（`previous` = API 的區塊；沒有時只有 L141，與產生器沒有舊快取時相同）。 */
export function computeFeatureStudies(
  games: readonly Game[],
  config: GamesDatasetConfig,
  asOf: string,
  previous?: Partial<FeatureStudiesSection> | null,
): FeatureStudiesSection {
  return refreshFeatureStudies(previous, computeLakeClaimFeature(games, config, asOf), asOf);
}
