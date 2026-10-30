import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SlidersHorizontal, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react';
import type { GameFilter, LeaderboardOverrideKey, LeaderboardOverrides } from '@avalon/shared/stats';
import { useStatsFilter } from '../../stats/statsFilter';

/**
 * 上榜條件 (Edward 2026-10-28「數據排行部分 "上榜"條件也做成可調整可變可選」)：排行上方一列，摘要一行 + 「調整」
 * 展開一排下拉選單 (不藏在選單裡；手機兩欄)。改了就寫進篩選的 options.leaderboard (分享連結也帶著)，引擎蓋在資料集的
 * config.leaderboard 上重算排行；跟預設一樣的鍵不寫，全部拿掉 = 回到快取 (「恢復預設」)。
 *
 * 目前值讀這次排行的 leaderboard.config (= 合併後的設定)；預設值讀沒有覆寫時的 config (第一次看到就記住)，
 * 沒看過時用產生器的預設 (FALLBACK_DEFAULTS，只用來判斷「跟預設一樣」)。
 */

type Config = Record<string, unknown>;

const FALLBACK_DEFAULTS: Record<LeaderboardOverrideKey, number> = {
  activeDays: 90, mainGames: 100, roleWindowGames: 10, loyalWindowGames: 40, requireRoleWindows: 1, theoryMinGames: 0,
  overallMinGames: 250, roleTitleGames: 50, roleTitleFallbackGames: 25, loyalTitleGames: 200, loyalTitleFallbackGames: 100,
  assassinMinAttempts: 10,
};
const KEYS = Object.keys(FALLBACK_DEFAULTS) as LeaderboardOverrideKey[];
let seenDefaults: Record<LeaderboardOverrideKey, number> | null = null;
/** 展開與否：改一個條件後排行會重新掛載，記在模組裡才不會每改一次就收起來。 */
let rememberedOpen = false;

const ACTIVE_DAYS = [30, 60, 90, 180, 365, 0];
const MAIN_GAMES = [50, 100, 150, 200, 0];
const MIN_GAMES = [0, 50, 100, 200, 300, 500];
const ROLE_WINDOWS: Array<[number, number]> = [[5, 20], [10, 40], [15, 60], [20, 80]];
const OVERALL_MIN = [100, 250, 500, 1000];
/** 角色王：'auto' = 預設規則；其他 = 固定場數 (其他角色 / 忠臣)。 */
const TITLE_FIXED: Array<[number, number]> = [[25, 100], [50, 200], [20, 80], [10, 40]];
const ASSASSIN_MIN = [5, 10, 15, 20];

function num(cfg: Config | undefined, key: LeaderboardOverrideKey, fallback: number): number {
  const v = cfg?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function withOverrides(filter: GameFilter | null, next: LeaderboardOverrides): GameFilter | null {
  const base: GameFilter = filter ?? { v: 1, clauses: [] };
  const options = { ...(base.options ?? {}) };
  if (Object.keys(next).length) options.leaderboard = next;
  else delete options.leaderboard;
  const out: GameFilter = { ...base, options };
  if (!Object.keys(options).length) delete out.options;
  return out.clauses.length || out.options ? out : null;
}

export default function LeaderboardRules({ config }: { config: Config | undefined }): JSX.Element {
  const { t } = useTranslation('common');
  const filter = useStatsFilter((s) => s.filter);
  const setFilter = useStatsFilter((s) => s.setFilter);
  const overrides: LeaderboardOverrides = filter?.options?.leaderboard ?? {};
  const modified = Object.keys(overrides).length > 0;
  const [open, setOpenState] = useState(rememberedOpen);
  const setOpen = (next: (o: boolean) => boolean): void => setOpenState((o) => {
    rememberedOpen = next(o);
    return rememberedOpen;
  });

  if (!modified && config) {
    seenDefaults = Object.fromEntries(KEYS.map((k) => [k, num(config, k, FALLBACK_DEFAULTS[k])])) as Record<LeaderboardOverrideKey, number>;
  }
  const defaults = seenDefaults ?? FALLBACK_DEFAULTS;
  const cur = (k: LeaderboardOverrideKey): number => overrides[k] ?? num(config, k, defaults[k]);

  const apply = (patch: LeaderboardOverrides): void => {
    const next: LeaderboardOverrides = { ...overrides, ...patch };
    for (const k of KEYS) if (next[k] === defaults[k]) delete next[k];
    setFilter(withOverrides(useStatsFilter.getState().filter, next));
  };
  const reset = (): void => setFilter(withOverrides(useStatsFilter.getState().filter, {}));

  const r = 'analytics.boards.rules';
  const days = (d: number): string => (d > 0 ? t(`${r}.days`, { count: d }) : t(`${r}.anyTime`));
  const games = (n: number): string => (n > 0 ? t(`${r}.lastGames`, { count: n }) : t(`${r}.career`));
  const atLeast = (n: number): string => (n > 0 ? t(`${r}.atLeast`, { count: n }) : t(`${r}.noMin`));
  const titleAuto = cur('roleTitleGames') !== cur('roleTitleFallbackGames') || cur('loyalTitleGames') !== cur('loyalTitleFallbackGames');
  const titleValue = titleAuto ? 'auto' : `${cur('roleTitleGames')}/${cur('loyalTitleGames')}`;
  const titleLabel = titleAuto
    ? t(`${r}.titleAuto`, { full: cur('roleTitleGames'), fallback: cur('roleTitleFallbackGames'), loyal: cur('loyalTitleGames'), loyalFallback: cur('loyalTitleFallbackGames') })
    : t(`${r}.titleFixed`, { other: cur('roleTitleGames'), loyal: cur('loyalTitleGames') });
  const rw = `${cur('roleWindowGames')}/${cur('loyalWindowGames')}`;

  /** 選項清單；目前值不在清單裡時加在最前面。 */
  const opts = (values: number[], current: number, text: (n: number) => string): Array<[string, string]> => {
    const list = values.includes(current) ? values : [current, ...values];
    return list.map((v) => [String(v), text(v)]);
  };

  const summary = [
    days(cur('activeDays')),
    games(cur('mainGames')),
    cur('theoryMinGames') > 0 ? t(`${r}.minGamesShort`, { count: cur('theoryMinGames') }) : null,
    cur('requireRoleWindows') ? t(`${r}.roleWindowsShort`, { k: cur('roleWindowGames'), kl: cur('loyalWindowGames') }) : t(`${r}.roleWindowsOffShort`),
    t(`${r}.overallShort`, { count: cur('overallMinGames') }),
    titleAuto ? t(`${r}.titleAutoShort`) : t(`${r}.titleFixedShort`, { other: cur('roleTitleGames'), loyal: cur('loyalTitleGames') }),
    t(`${r}.assassinShort`, { count: cur('assassinMinAttempts') }),
  ].filter(Boolean).join(' · ');

  const select = (
    label: string, value: string, options: Array<[string, string]>, onChange: (v: string) => void, testId: string,
  ): JSX.Element => (
    <label className="flex min-w-0 flex-col gap-0.5 text-[11px] text-zinc-500">
      <span className="truncate">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-200"
        data-testid={testId}
      >
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </label>
  );

  return (
    // 2026-10-30 Edward：「上榜條件應該更重要」— 比篩選的常用條件更醒目（黃框、標題放大）。
    <section className={`mb-3 rounded-lg border px-3 py-2 ${modified ? 'border-amber-500/70 bg-amber-950/40' : 'border-amber-700/50 bg-zinc-950/70'}`} data-testid="leaderboard-rules" aria-label={t(`${r}.title`)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1 text-sm font-bold text-amber-200">
          <SlidersHorizontal size={14} />
          {t(`${r}.title`)}
        </span>
        <span className={`min-w-0 ${modified ? 'text-amber-200' : 'text-zinc-400'}`}>{summary}</span>
        <span className="ml-auto inline-flex items-center gap-1">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="inline-flex items-center gap-0.5 rounded-md border border-zinc-600 px-2 py-0.5 text-zinc-200 hover:border-white"
            data-testid="leaderboard-rules-toggle"
          >
            {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {t(`${r}.adjust`)}
          </button>
          {modified && (
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center gap-0.5 rounded-md px-2 py-0.5 text-amber-300 hover:text-white"
              data-testid="leaderboard-rules-reset"
            >
              <RotateCcw size={11} />
              {t(`${r}.reset`)}
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1.5 sm:grid-cols-4 lg:grid-cols-8">
          {select(t(`${r}.activeDays`), String(cur('activeDays')), opts(ACTIVE_DAYS, cur('activeDays'), days),
            (v) => apply({ activeDays: Number(v) }), 'rule-activeDays')}
          {select(t(`${r}.mainGames`), String(cur('mainGames')), opts(MAIN_GAMES, cur('mainGames'), games),
            (v) => apply({ mainGames: Number(v) }), 'rule-mainGames')}
          {select(t(`${r}.theoryMinGames`), String(cur('theoryMinGames')), opts(MIN_GAMES, cur('theoryMinGames'), atLeast),
            (v) => apply({ theoryMinGames: Number(v) }), 'rule-theoryMinGames')}
          {select(t(`${r}.roleWindows`), rw,
            (ROLE_WINDOWS.some(([k, kl]) => `${k}/${kl}` === rw) ? ROLE_WINDOWS : [[cur('roleWindowGames'), cur('loyalWindowGames')] as [number, number], ...ROLE_WINDOWS])
              .map(([k, kl]) => [`${k}/${kl}`, t(`${r}.roleWindowsOption`, { k, kl })]),
            (v) => {
              const [k, kl] = v.split('/').map(Number);
              apply({ roleWindowGames: k, loyalWindowGames: kl });
            }, 'rule-roleWindows')}
          {select(t(`${r}.requireRoleWindows`), String(cur('requireRoleWindows')),
            [['1', t(`${r}.requireOn`)], ['0', t(`${r}.requireOff`)]],
            (v) => apply({ requireRoleWindows: Number(v) }), 'rule-requireRoleWindows')}
          {select(t(`${r}.overallMinGames`), String(cur('overallMinGames')), opts(OVERALL_MIN, cur('overallMinGames'), (n) => t(`${r}.atLeast`, { count: n })),
            (v) => apply({ overallMinGames: Number(v) }), 'rule-overallMinGames')}
          {select(t(`${r}.roleTitles`), titleValue,
            [
              ['auto', titleAuto ? titleLabel : t(`${r}.titleAutoDefault`, { full: defaults.roleTitleGames, fallback: defaults.roleTitleFallbackGames, loyal: defaults.loyalTitleGames, loyalFallback: defaults.loyalTitleFallbackGames })],
              ...(TITLE_FIXED.some(([o, l]) => `${o}/${l}` === titleValue) || titleAuto ? [] : [[titleValue, titleLabel] as [string, string]]),
              ...TITLE_FIXED.map(([o, l]): [string, string] => [`${o}/${l}`, t(`${r}.titleFixed`, { other: o, loyal: l })]),
            ],
            (v) => {
              if (v === 'auto') {
                apply({
                  roleTitleGames: defaults.roleTitleGames, roleTitleFallbackGames: defaults.roleTitleFallbackGames,
                  loyalTitleGames: defaults.loyalTitleGames, loyalTitleFallbackGames: defaults.loyalTitleFallbackGames,
                });
                return;
              }
              const [o, l] = v.split('/').map(Number);
              apply({ roleTitleGames: o, roleTitleFallbackGames: o, loyalTitleGames: l, loyalTitleFallbackGames: l });
            }, 'rule-roleTitles')}
          {select(t(`${r}.assassinMinAttempts`), String(cur('assassinMinAttempts')), opts(ASSASSIN_MIN, cur('assassinMinAttempts'), (n) => t(`${r}.attempts`, { count: n })),
            (v) => apply({ assassinMinAttempts: Number(v) }), 'rule-assassinMinAttempts')}
        </div>
      )}
    </section>
  );
}
