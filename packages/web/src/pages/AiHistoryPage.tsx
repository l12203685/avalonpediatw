import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Bot, LineChart, ListChecks, Users } from 'lucide-react';
import historyJson from '../data/aiHistory.json';
import { strengthReport } from '../stats/statsEngine';
import { useCohortCuts } from '../stats/cohortCuts';
import {
  ROLE_LABEL, chartGeometry, deltaTrend, filterMilestones, formatDelta, humanReferenceRows, roleSummary,
  type AiDelta, type AiHistoryData, type AiMilestone, type AiSeriesPoint, type HumanRefRow, type RoleFilter,
} from '../utils/aiHistory';

/**
 * 百科AI 優化歷程（#ai-history；站長 2026-11-20：「百科網站上可以彙整公布一下目前優化的進程歷史嗎 主要的改動 精簡 一目了然就好
 * 做了什麼策略/動作/思考優化 導致 任務勝率&最終勝率 提升 (分角色)」）。不用登入。
 * 資料：data/aiHistory.json（scripts/build_ai_history.ts 從 docs/ai/optimization_loop.md 與 docs/ai/ai_history.curated.json 產生）；
 * 純函式在 utils/aiHistory.ts。從「百科AI 對局」頁的連結進來。
 * 真人局／高端桌的對照不寫死（站長 2026-11-20「整個系統要完全同步同來源」）：用數據分析「陣容強度」同一份報告
 * （stats/statsEngine strengthReport：/api/analysis/games、百科AI 局不算、沒有篩選），高端桌的 S 切點跟著數據分析的分組切點。
 */

const DATA = historyJson as unknown as AiHistoryData;

type HumanState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; rows: HumanRefRow[] };

/** 數據分析「陣容強度」的報告（全部局、不套篩選；和數據分析頁共用統計 Worker 與快取）→ 真人對照列。 */
function useHumanRefs(): HumanState {
  const sHi = useCohortCuts((st) => st.cuts.sHi);
  const [points, setPoints] = useState<Parameters<typeof humanReferenceRows>[0] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    strengthReport(null, '', { kind: 'tier' })
      .then((report) => { if (!cancelled) setPoints(report.points); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return (): void => { cancelled = true; };
  }, []);
  return useMemo<HumanState>(() => {
    if (points) return { status: 'ok', rows: humanReferenceRows(points, sHi) };
    if (error) return { status: 'error', message: error };
    return { status: 'loading' };
  }, [points, error, sHi]);
}

const WIN_COLOR = '#3987e5';
const TASK_COLOR = '#d95926';

function pct(n: number | null, digits = 1): string {
  return n === null ? '—' : `${n.toFixed(digits)}%`;
}

export default function AiHistoryPage(): JSX.Element {
  const human = useHumanRefs();
  return (
    <div className="relative z-10 mx-auto max-w-4xl space-y-6 overflow-x-hidden px-3 py-4 text-white sm:px-4">
      <header className="space-y-2">
        <h1 className="flex items-center gap-2 text-lg font-bold"><Bot size={20} className="text-amber-300" />AI騎士 優化歷程</h1>
        <p className="text-xs leading-relaxed text-zinc-300">
          AI騎士 從 10/28 起一回合改藍方、一回合改紅方，每個改法先在機器人互打裡量，勝率確定變好（或判斷更像真人強者）才改成預設。
          這頁只列<strong className="text-white">改成預設</strong>的改動：做了什麼、為什麼、讓勝率動了多少。
        </p>
      </header>
      <Headline human={human} />
      <TrendChart series={DATA.series} human={human.status === 'ok' ? human.rows.find((h) => h.key === 'all') ?? null : null} />
      <RoleSummary />
      <Timeline />
      <footer className="space-y-1 border-t border-zinc-800 pt-3 text-[11px] leading-relaxed text-zinc-500">
        <p>
          回合紀錄共 {DATA.stats.rounds} 回合（到第 {DATA.stats.latestRound} 回合），其中 {DATA.stats.adoptedRounds} 回合有改法改成預設、
          {DATA.stats.notAdoptedRounds} 回合量完沒有任何改法通過；有採用的回合裡也有很多候選量過沒有採用，這頁都不列。
        </p>
        <p>
          數字都是全機器人局（10 人局，藍紅雙方都是當時的預設），不是對真人的戰績；差值是「這個改法 − 當時的預設」，
          有 95% 區間的寫在方括號裡，只有各組種子點估計的寫成「+1.2／+0.8（2 組）」。資料：{DATA.source}；更新 {DATA.generatedAt}。
        </p>
      </footer>
    </div>
  );
}

// ── 1. 頂端數字 ─────────────────────────────────────────────────────────────────────

function Headline({ human }: { human: HumanState }): JSX.Element {
  const start = DATA.headline.find((h) => h.key === 'start');
  const now = DATA.headline.find((h) => h.key === 'now');
  return (
    <section aria-labelledby="ai-history-headline" className="space-y-3">
      <h2 id="ai-history-headline" className="sr-only">現在 vs 起點</h2>
      {start && now && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <BigStat label="藍方最終勝率（三藍活）" from={start.win} to={now.win} />
          <BigStat label="任務三藍率" from={start.task} to={now.task} />
          <BigStat label="紅方勝率" from={100 - start.win} to={100 - now.win} />
          <BigStat label="三藍後梅林被刺中" from={start.hit} to={now.hit} />
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/70">
        <table className="w-full min-w-[30rem] text-left text-xs">
          <thead className="text-zinc-400">
            <tr className="border-b border-zinc-800">
              <th className="px-3 py-2 font-medium">桌別</th>
              <th className="px-2 py-2 text-right font-medium">任務三藍</th>
              <th className="px-2 py-2 text-right font-medium">藍方勝（三藍活）</th>
              <th className="px-2 py-2 text-right font-medium">紅方勝</th>
              <th className="px-2 py-2 text-right font-medium">刺中率</th>
              <th className="px-3 py-2 font-medium">樣本</th>
            </tr>
          </thead>
          <tbody>
            {[...(start ? [start] : []), ...(now ? [now] : [])].map((h) => (
              <tr key={h.key} className={`border-b border-zinc-800/60 last:border-0 ${h.key === 'now' ? 'bg-zinc-800/40' : ''}`}>
                <td className="px-3 py-2 text-zinc-100">{h.label}</td>
                <td className="px-2 py-2 text-right font-mono tabular-nums">{pct(h.task)}</td>
                <td className="px-2 py-2 text-right font-mono tabular-nums">{pct(h.win)}</td>
                <td className="px-2 py-2 text-right font-mono tabular-nums">{pct(100 - h.win)}</td>
                <td className="px-2 py-2 text-right font-mono tabular-nums">{pct(h.hit)}</td>
                <td className="px-3 py-2 text-zinc-400">{h.sample}</td>
              </tr>
            ))}
            {human.status === 'ok' && human.rows.map((h) => (
              <tr key={h.key} className="border-b border-zinc-800/60 last:border-0" data-testid={`ai-history-human-${h.key}`}>
                <td className="px-3 py-2 text-zinc-100">{h.label} <span className="text-zinc-500">{h.range}</span></td>
                <td className="px-2 py-2 text-right font-mono tabular-nums">{pct(h.task)}</td>
                <td className="px-2 py-2 text-right font-mono tabular-nums">{pct(h.win)}</td>
                <td className="px-2 py-2 text-right font-mono tabular-nums">{pct(h.red)}</td>
                <td className="px-2 py-2 text-right font-mono tabular-nums">{pct(h.hit)}</td>
                <td className="px-3 py-2 text-zinc-400">真人 {h.n.toLocaleString('en-US')} 局</td>
              </tr>
            ))}
            {human.status !== 'ok' && (
              <tr><td colSpan={6} className="px-3 py-2 text-zinc-500">{human.status === 'loading' ? '讀取數據分析的真人局…（伺服器剛喚醒時要等 30–60 秒）' : `真人局讀不到：${human.message}`}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {now?.note && <p className="text-[11px] text-zinc-500">{now.note}。</p>}
      <p className="text-[11px] leading-relaxed text-zinc-500">
        機器人兩列是機器人互打。真人列和數據分析「陣容強度」同一份資料、同一個算法（AI騎士 局不算；只算有陣容強度 S 的局）：
        S = 桌上 10 人開打前 PR 的平均；高端桌的切點跟著數據分析「分組」的 S 上切點，高強度 = S ≥ 65。只當參考目標。
      </p>
    </section>
  );
}

function BigStat({ label, from, to }: { label: string; from: number | null; to: number | null }): JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2">
      <div className="text-[11px] text-zinc-400">{label}</div>
      <div className="mt-0.5 font-mono text-xl font-bold tabular-nums text-white">{pct(to)}</div>
      <div className="text-[11px] text-zinc-500">起點 {pct(from)}</div>
    </div>
  );
}

// ── 2. 走勢圖 ──────────────────────────────────────────────────────────────────────

/** 圖畫在實際的像素寬度上（字固定 10px，手機上不會縮成看不見）。 */
function useWidth(fallback: number): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = (): void => { if (el.clientWidth > 0) setWidth(el.clientWidth); };
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return (): void => ro.disconnect();
  }, []);
  return [ref, width];
}

function TrendChart({ series, human }: { series: AiSeriesPoint[]; human: HumanRefRow | null }): JSX.Element {
  const [wrapRef, wrapWidth] = useWidth(640);
  const BOX = useMemo(() => ({ width: Math.max(280, wrapWidth), height: 220, left: 34, right: 12, top: 12, bottom: 28 }), [wrapWidth]);
  const geo = useMemo(() => chartGeometry(series, BOX), [series, BOX]);
  const labelEvery = Math.max(1, Math.ceil((series.length * 26) / (BOX.width - BOX.left - BOX.right)));
  const [hover, setHover] = useState<number | null>(null);
  const hp = hover === null ? null : geo.points[hover];
  const step = geo.points.length > 1 ? geo.points[1].x - geo.points[0].x : BOX.width;
  return (
    <section aria-labelledby="ai-history-chart" className="space-y-2">
      <h2 id="ai-history-chart" className="flex items-center gap-2 text-sm font-bold"><LineChart size={16} className="text-sky-300" />每回合之後的預設</h2>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-300">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded" style={{ background: WIN_COLOR }} />藍方最終勝率（三藍活）</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded" style={{ background: TASK_COLOR }} />任務三藍率（文件有數字的回合）</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 border-t border-dashed border-zinc-500" />真人局（全部，數據分析同一份資料）</span>
      </div>
      <div className="relative rounded-lg border border-zinc-800 bg-zinc-900/70 py-2">
        <div ref={wrapRef} className="w-full">
        <svg width={BOX.width} height={BOX.height} viewBox={`0 0 ${BOX.width} ${BOX.height}`} className="block h-auto max-w-full" role="img" aria-label="AI騎士 預設每回合之後的藍方最終勝率與任務三藍率">
          {geo.ticks.map((t) => (
            <g key={t}>
              <line x1={BOX.left} x2={BOX.width - BOX.right} y1={geo.yOf(t)} y2={geo.yOf(t)} stroke="#3f3f46" strokeWidth={t === 0 ? 1 : 0.5} />
              <text x={BOX.left - 6} y={geo.yOf(t) + 3} textAnchor="end" fontSize="10" fill="#a1a1aa">{t}%</text>
            </g>
          ))}
          {human && human.win !== null && (
            <g>
              <line x1={BOX.left} x2={BOX.width - BOX.right} y1={geo.yOf(human.win)} y2={geo.yOf(human.win)} stroke="#71717a" strokeDasharray="4 3" strokeWidth={1} />
              {human.task !== null && (
                <line x1={BOX.left} x2={BOX.width - BOX.right} y1={geo.yOf(human.task)} y2={geo.yOf(human.task)} stroke="#71717a" strokeDasharray="4 3" strokeWidth={1} />
              )}
            </g>
          )}
          {hp && <line x1={hp.x} x2={hp.x} y1={BOX.top} y2={BOX.height - BOX.bottom} stroke="#52525b" strokeWidth={1} />}
          <path d={geo.taskPath} fill="none" stroke={TASK_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <path d={geo.winPath} fill="none" stroke={WIN_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {geo.points.map((pt, i) => (
            <g key={pt.p.round}>
              {pt.yTask !== null && <circle cx={pt.x} cy={pt.yTask} r={hover === i ? 4.5 : 3} fill={TASK_COLOR} stroke="#18181b" strokeWidth={1.5} />}
              <circle cx={pt.x} cy={pt.yWin} r={hover === i ? 4.5 : 3} fill={WIN_COLOR} stroke="#18181b" strokeWidth={1.5} />
              {(i === geo.points.length - 1 || (i % labelEvery === 0 && i <= geo.points.length - 1 - labelEvery)) && (
                <text x={pt.x} y={BOX.height - 10} textAnchor="middle" fontSize="10" fill="#a1a1aa">{pt.p.round}</text>
              )}
              <rect
                x={pt.x - step / 2}
                y={BOX.top}
                width={step}
                height={BOX.height - BOX.top - BOX.bottom}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={() => setHover(hover === i ? null : i)}
              >
                <title>{`第 ${pt.p.round} 回合：藍方 ${pct(pt.p.win)}、任務三藍 ${pct(pt.p.task)}`}</title>
              </rect>
            </g>
          ))}
          <text x={BOX.width - BOX.right} y={BOX.height - 1} textAnchor="end" fontSize="9" fill="#71717a">回合</text>
        </svg>
        </div>
        {hp && (
          <div
            className="pointer-events-none absolute top-2 max-w-[calc(100%-3.5rem)] break-words rounded-md border border-zinc-700 bg-zinc-950/95 px-2 py-1 text-[11px] leading-snug text-zinc-200 shadow"
            style={hp.x / BOX.width > 0.6 ? { right: '0.75rem' } : { left: '3rem' }}
          >
            <div className="font-semibold text-white">第 {hp.p.round} 回合{hp.p.side ? `（改${hp.p.side === 'blue' ? '藍' : '紅'}方）` : ''}</div>
            <div>藍方最終勝率 {pct(hp.p.win)}</div>
            <div>任務三藍 {pct(hp.p.task)}</div>
            {hp.p.note && <div className="text-zinc-400">{hp.p.note}</div>}
          </div>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-zinc-400">
        改紅方的回合藍方勝率會下降，是紅方變強，不是藍方變弱。第 32、33 回合是刻意的取捨：讀人改照真人強者、投票照嚴格的貝氏準則，
        機器人互打的勝率先掉，換到判斷更準；之後從玩法上拿回來。第 26–30 回合的任務三藍偏高，是當時紅方還沒學會照強者比例藏牌。
        各回合的局數與種子不同，點和點之間差 1pp 以內多半是雜訊。
      </p>
      <details className="text-xs text-zinc-300">
        <summary className="cursor-pointer text-zinc-400 hover:text-white">看數字</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[20rem] text-left">
            <thead className="text-zinc-400">
              <tr><th className="py-1 pr-2 font-medium">回合</th><th className="py-1 pr-2 font-medium">改哪一方</th><th className="py-1 pr-2 text-right font-medium">藍方最終勝率</th><th className="py-1 text-right font-medium">任務三藍</th></tr>
            </thead>
            <tbody>
              {series.map((p) => (
                <tr key={p.round} className="border-t border-zinc-800/60">
                  <td className="py-1 pr-2">{p.round}</td>
                  <td className="py-1 pr-2 text-zinc-400">{p.side === null ? '起點' : p.side === 'blue' ? '藍方' : '紅方'}</td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums">{pct(p.win)}</td>
                  <td className="py-1 text-right font-mono tabular-nums">{pct(p.task)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

// ── 3. 分角色 ──────────────────────────────────────────────────────────────────────

function signedSum(n: number): string {
  const s = Math.abs(n).toFixed(1);
  return Number(s) === 0 ? '±0.0' : `${n > 0 ? '+' : '−'}${s}`;
}

function RoleSummary(): JSX.Element {
  const rows = useMemo(() => roleSummary(DATA.milestones), []);
  return (
    <section aria-labelledby="ai-history-roles" className="space-y-2">
      <h2 id="ai-history-roles" className="flex items-center gap-2 text-sm font-bold"><Users size={16} className="text-emerald-300" />分角色</h2>
      <p className="text-[11px] leading-relaxed text-zinc-400">
        每個改動只算進一格（一次改多個角色的算在「整包」）。加總是各改動當時對當時預設量的點估計相加，對手也一直在變，
        所以只看量級，不是精確的累計。紅方各格是紅方勝率。
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.role} className={`rounded-lg border bg-zinc-900/70 px-3 py-2 ${r.side === 'blue' ? 'border-sky-900/70' : 'border-rose-900/70'}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-semibold text-white">{ROLE_LABEL[r.role]}</span>
              <span className="text-[11px] text-zinc-400">{r.count} 項{r.touched > r.count ? `（另有 ${r.touched - r.count} 項整包也改到）` : ''}</span>
            </div>
            {r.count > 0 && (
              <div className="mt-0.5 text-xs text-zinc-300">
                {r.side === 'blue' ? '藍方' : '紅方'}勝率加總 <span className="font-mono tabular-nums text-white">{r.winCount > 0 ? `${signedSum(r.winSum)}pp` : '—'}</span>
                {r.taskCount > 0 && <> · 任務三藍 <span className="font-mono tabular-nums text-white">{signedSum(r.taskSum)}pp</span>（{r.taskCount} 項有數字）</>}
              </div>
            )}
            {r.items.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-[11px] leading-snug text-zinc-400">
                {r.items.slice(0, 4).map((m) => <li key={m.id}>· 第 {m.round} 回合：{m.what}</li>)}
                {r.items.length > 4 && <li>· 還有 {r.items.length - 4} 項（見下方歷程）</li>}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── 4. 歷程 ────────────────────────────────────────────────────────────────────────

const FILTERS: { key: RoleFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'blueSide', label: '藍方' },
  { key: 'reading', label: '讀法' },
  { key: 'loyal', label: '忠臣' },
  { key: 'merlin', label: '梅林' },
  { key: 'percival', label: '派西' },
  { key: 'redSide', label: '紅方' },
  { key: 'assassin', label: '刺客' },
  { key: 'morgana', label: '莫甘娜' },
  { key: 'mordred', label: '莫德雷德' },
  { key: 'oberon', label: '奧伯倫' },
];

function Timeline(): JSX.Element {
  const [role, setRole] = useState<RoleFilter>('all');
  const [highlightsOnly, setHighlightsOnly] = useState(true);
  const list = useMemo(() => filterMilestones(DATA.milestones, role, highlightsOnly), [role, highlightsOnly]);
  const total = DATA.milestones.length;
  return (
    <section aria-labelledby="ai-history-timeline" className="space-y-2">
      <h2 id="ai-history-timeline" className="flex items-center gap-2 text-sm font-bold"><ListChecks size={16} className="text-amber-300" />改成預設的改動（新的在前）</h2>
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="mr-1 inline-flex overflow-hidden rounded-lg border border-zinc-700 text-xs" role="group" aria-label="顯示範圍">
          <button type="button" aria-pressed={highlightsOnly} onClick={() => setHighlightsOnly(true)} className={`px-2.5 py-1 ${highlightsOnly ? 'bg-white text-black' : 'text-zinc-300 hover:bg-zinc-800'}`}>重點</button>
          <button type="button" aria-pressed={!highlightsOnly} onClick={() => setHighlightsOnly(false)} className={`px-2.5 py-1 ${!highlightsOnly ? 'bg-white text-black' : 'text-zinc-300 hover:bg-zinc-800'}`}>全部 {total} 項</button>
        </div>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={role === f.key}
            onClick={() => setRole(f.key)}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] ${role === f.key ? 'border-white bg-white text-black' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="py-4 text-xs text-zinc-400">這個篩選沒有{highlightsOnly ? '重點' : ''}項目{highlightsOnly ? '，切到「全部」看看' : ''}。</p>
      ) : (
        <ol className="space-y-2">
          {list.map((m) => <MilestoneCard key={m.id} m={m} />)}
        </ol>
      )}
    </section>
  );
}

const KIND_LABEL: Record<AiMilestone['kind'], string> = { strategy: '策略', reading: '讀法', fix: '邏輯修正' };

function DeltaChip({ label, d }: { label: string; d: AiDelta | null }): JSX.Element {
  const trend = deltaTrend(d);
  const tone = trend === 'up' ? 'text-emerald-300' : trend === 'down' ? 'text-rose-300' : 'text-zinc-300';
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-zinc-500">{label}</span>
      <span className={`font-mono tabular-nums ${d ? tone : 'text-zinc-500'}`}>{d ? `${formatDelta(d)}pp` : '沒有單獨量'}</span>
    </span>
  );
}

function MilestoneCard({ m }: { m: AiMilestone }): JSX.Element {
  const sideText = m.side === 'blue' ? '藍方' : '紅方';
  return (
    <li className={`rounded-lg border-l-2 bg-zinc-900/70 px-3 py-2 ${m.side === 'blue' ? 'border-sky-500' : 'border-rose-500'}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-400">
        <span className="font-mono">{m.date.slice(5).replace('-', '/')}</span>
        <span>第 {m.round} 回合</span>
        <span className={m.side === 'blue' ? 'text-sky-300' : 'text-rose-300'}>{sideText}</span>
        {m.roles.filter((r) => r !== 'blue' && r !== 'red').map((r) => (
          <span key={r} className="rounded border border-zinc-700 px-1.5 leading-4 text-zinc-300">{ROLE_LABEL[r].replace('（藍方全體）', '')}</span>
        ))}
        <span className="rounded bg-zinc-800 px-1.5 leading-4 text-zinc-300">{KIND_LABEL[m.kind]}</span>
      </div>
      <p className="mt-1 text-sm leading-snug text-white">{m.what}</p>
      <p className="mt-0.5 text-xs leading-snug text-zinc-400">為什麼：{m.why}</p>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px]">
        <DeltaChip label={`${sideText}最終勝率`} d={m.win} />
        <DeltaChip label="任務三藍" d={m.task} />
        <span className="text-zinc-500">{m.sample}</span>
      </div>
      {m.note && <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">{m.note}</p>}
    </li>
  );
}
