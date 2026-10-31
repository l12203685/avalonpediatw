import { Filter, ScrollText } from 'lucide-react';
import { OUTCOME_COLORS } from '../ui';
import {
  hitRate, outcomeRate, type NextRoundFacts, type OutcomeMix, type Ratio, type StateNode,
} from './stateTree';

/** 0–1 → 「43%」；沒有資料「—」。 */
export function pct(x: number | null | undefined): string {
  return x === null || x === undefined || !Number.isFinite(x) ? '—' : `${Math.round(x * 100)}%`;
}

export function ratioPct(r: Ratio): string {
  return r.of ? pct(r.yes / r.of) : '—';
}

const OUTCOME_ROWS: Array<{ key: keyof OutcomeMix; label: string }> = [
  { key: '三紅', label: '三紅' },
  { key: '三藍死', label: '三藍被刀' },
  { key: '三藍活', label: '三藍躲刺' },
];

/** 三種結果的細長條（2px 間隔；顏色同分析頁的三種結果）。 */
export function OutcomeStrip({ outcomes, height = 6 }: { outcomes: OutcomeMix; height?: number }): JSX.Element {
  const n = outcomes.三紅 + outcomes.三藍死 + outcomes.三藍活;
  return (
    <div className="flex w-full gap-[2px] overflow-hidden rounded-sm" style={{ height }} aria-hidden>
      {OUTCOME_ROWS.map(({ key }) => (n && outcomes[key] ? (
        <div key={key} style={{ width: `${(outcomes[key] / n) * 100}%`, background: OUTCOME_COLORS[key] }} />
      ) : null))}
    </div>
  );
}

/** 路徑的文字：藍紅 → 湖1 說好 → 藍紅藍。 */
export function pathText(chain: StateNode[]): string {
  return chain.filter((n) => n.kind !== 'root').map((n) => n.label).join(' → ') || '全部局';
}

function NextFacts({ facts, lastBlue }: { facts: NextRoundFacts; lastBlue: boolean | null }): JSX.Element {
  const avgTries = facts.tries.of ? (facts.tries.sum / facts.tries.of).toFixed(1) : '—';
  return (
    <div className="space-y-1 text-xs text-zinc-300">
      <div className="font-semibold text-zinc-400">下一步：第 {facts.round} 局</div>
      <div>開藍 <b className="text-zinc-100">{ratioPct(facts.nextBlue)}</b> <span className="text-zinc-500">（{facts.nextBlue.of} 局）</span></div>
      {facts.tries.of > 0 && (
        <div>
          第一個提案就通過 <b className="text-zinc-100">{ratioPct(facts.firstPass)}</b>，平均提案 {avgTries} 次
        </div>
      )}
      {facts.reuse.of > 0 && (
        <div>
          {lastBlue
            ? <>下一位隊長照派上一個開藍的隊伍 <b className="text-zinc-100">{ratioPct(facts.reuse)}</b> <span className="text-zinc-500">（照派是慣例）</span></>
            : <>下一位隊長仍派上一個開紅的隊伍 <b className="text-zinc-100">{ratioPct(facts.reuse)}</b></>}
          <span className="text-zinc-500">（{facts.reuse.of} 局）</span>
        </div>
      )}
      {facts.reuseBlue.of >= 5 && facts.otherBlue.of >= 5 && (
        <div className="text-zinc-400">
          照派時開藍 {ratioPct(facts.reuseBlue)}（{facts.reuseBlue.of}）；不照派 {ratioPct(facts.otherBlue)}（{facts.otherBlue.of}）
        </div>
      )}
    </div>
  );
}

export interface NodeDetailProps {
  node: StateNode;
  chain: StateNode[];
  rootN: number;
  baseline: OutcomeMix;
  onApply: ((node: StateNode) => void) | null;
  /** 到牌譜紀錄看這條分支（null = 不能，例如根或「其他」）。 */
  onRecords?: ((node: StateNode) => void) | null;
  compact?: boolean;
}

/** 一個節點的細節：局數與佔比、三種結果、藍方勝率／刺中率、下一個任務的派隊、最常見的下一步。 */
export default function NodeDetail({ node, chain, rootN, baseline, onApply, onRecords = null, compact = false }: NodeDetailProps): JSX.Element {
  const parent = chain.length > 1 ? chain[chain.length - 2] : null;
  const n = node.n;
  const blueWin = outcomeRate(node.outcomes, '三藍活');
  const threeRed = outcomeRate(node.outcomes, '三紅');
  const hit = hitRate(node.outcomes);
  const threeBlue = node.outcomes.三藍死 + node.outcomes.三藍活;
  const lastMission = node.seq ? node.seq[node.seq.length - 1] : '';
  const kids = [...node.children].sort((a, b) => b.n - a.n);
  return (
    <div className={`space-y-3 ${compact ? 'text-xs' : 'text-sm'}`}>
      <div>
        {node.kind !== 'root' && <div className="text-[11px] text-zinc-500">{pathText(chain)}</div>}
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
          <span className="text-base font-bold text-zinc-100">{node.kind === 'root' ? '全部局' : node.label}</span>
          <span className="text-xs text-zinc-400">
            {n} 局{parent ? ` · 上一層的 ${pct(n / parent.n)}` : ''}{node.kind !== 'root' ? ` · 全部的 ${pct(n / rootN)}` : ''}
          </span>
        </div>
        {node.decided && <div className="mt-0.5 text-xs text-zinc-400">已分出勝負：{node.decided === '三紅' ? '三紅（紅方拿下 3 個任務）' : '三藍，進入刺殺'}</div>}
        {node.kind === 'other' && <div className="mt-0.5 text-xs text-zinc-400">{node.folded} 個不到門檻的分支合在一起，只看合計。</div>}
      </div>

      <div className="space-y-1.5">
        <OutcomeStrip outcomes={node.outcomes} height={8} />
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
          {OUTCOME_ROWS.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-1 whitespace-nowrap">
              <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ background: OUTCOME_COLORS[key] }} aria-hidden />
              <span className="text-zinc-400">{label}</span>
              <span className="font-semibold text-zinc-100">{pct(n ? node.outcomes[key] / n : null)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-lg border border-zinc-700/60 bg-zinc-900/40 p-2 text-center">
        <div>
          <div className="text-[10px] text-zinc-500">藍方最終勝率</div>
          <div className="font-bold text-zinc-100">{pct(blueWin)}</div>
          <div className="text-[10px] text-zinc-500">全體 {pct(outcomeRate(baseline, '三藍活'))}</div>
        </div>
        <div>
          <div className="text-[10px] text-zinc-500">三紅率</div>
          <div className="font-bold text-zinc-100">{pct(threeRed)}</div>
          <div className="text-[10px] text-zinc-500">全體 {pct(outcomeRate(baseline, '三紅'))}</div>
        </div>
        <div>
          <div className="text-[10px] text-zinc-500">三藍刺中率</div>
          <div className="font-bold text-zinc-100">{pct(hit)}</div>
          <div className="text-[10px] text-zinc-500">{threeBlue} 局三藍</div>
        </div>
      </div>

      {node.next && <NextFacts facts={node.next} lastBlue={lastMission ? lastMission === '藍' : null} />}

      {kids.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-semibold text-zinc-400">接下來最常見</div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] text-zinc-500">
                <th className="text-left font-normal">分支</th>
                <th className="text-right font-normal">局數</th>
                <th className="text-right font-normal">佔比</th>
                <th className="text-right font-normal">藍勝</th>
              </tr>
            </thead>
            <tbody>
              {kids.slice(0, 5).map((k) => (
                <tr key={k.id} className={k.kind === 'other' ? 'text-zinc-500' : 'text-zinc-200'}>
                  <td className="py-0.5">{k.kind === 'other' ? `其他（${k.folded}）` : k.label}</td>
                  <td className="text-right tabular-nums">{k.n}</td>
                  <td className="text-right tabular-nums">{pct(k.n / n)}</td>
                  <td className="text-right tabular-nums">{pct(outcomeRate(k.outcomes, '三藍活'))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {onApply && node.kind !== 'root' && (
        node.kind === 'other' ? (
          <p className="text-[11px] text-zinc-500">「其他」是好幾個分支的合計，不能直接當篩選；降低門檻可以看到個別分支。</p>
        ) : (
          <div className="space-y-1">
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => onApply(node)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500"
              >
                <Filter size={13} />只看這條分支的局
              </button>
              {onRecords && (
                <button
                  type="button"
                  onClick={() => onRecords(node)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-600 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-800"
                >
                  <ScrollText size={13} />看這條分支的牌譜
                </button>
              )}
            </div>
            <p className="text-[11px] leading-snug text-zinc-500">
              套用到上方篩選：其他分析分頁也只算這條分支（任務順序開頭＋湖的宣告條件），在篩選列可以移除。
              牌譜紀錄只有 Discord 牌譜頻道的局，局數會比較少。
            </p>
          </div>
        )
      )}
    </div>
  );
}
