import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Advanced, MeterBar, Takeaway, type GlanceTone } from './ui';
import { sentenceText } from './core/glanceView';
import type { BoardGlance } from './core/glance';

/**
 * 戰績排行「一眼看懂」的零件（站長 2026-11-25：數據分析要更直觀、一目瞭然；第三批）。
 *  - BoardLead：榜最上面的一句話（前三名是誰、多少；對照的全體多少）＋「誰上榜」一行白話。桌機、手機都有。
 *  - BoardCards：手機版的榜＝一位玩家一張小卡（名次、名字、一條長條＋大數字、一行小字），先列前 N 名，
 *    按「看全部」才展開；對照組（散客、全體、前後段：不排名的基準列）收在下面的收合區。桌機照舊用表格。
 * 數字都由呼叫端從跟表格同一份資料給（這裡不算），百分比寫整數。
 */

const G = 'analytics.glance.board';

export function BoardLead({ glance, who, children }: {
  glance: BoardGlance;
  /** 這個榜的上榜條件（一句白話；沒有就不寫）。 */
  who?: string | null;
  children?: ReactNode;
}): JSX.Element | null {
  const { t } = useTranslation('common');
  const lead = sentenceText(t, glance.sentence);
  if (!lead && !who) return null;
  return (
    <Takeaway>
      {lead && (
        <p className="text-sm font-semibold text-white sm:text-[15px]" data-testid="board-lead">
          {lead}
          {glance.baseSentence && <span className="font-normal text-zinc-300">{sentenceText(t, glance.baseSentence)}</span>}
        </p>
      )}
      {who && <p className="text-zinc-400" data-testid="board-who">{t(`${G}.who`, { who })}</p>}
      {children}
    </Takeaway>
  );
}

export interface BoardCardRow {
  key: string;
  /** 名次；對照組沒有名次（null）。 */
  rank: number | null;
  name: ReactNode;
  /** 長條的長度（0–max）；null = 不畫長條（沒有數字，或這個數字不適合畫成從 0 開始的長條），大數字改寫在名字右邊。 */
  value: number | null;
  /** 長條右邊的大數字（例：「60%」）。 */
  text: string;
  /** 下面一行小字（其他一兩個數字、場數）。 */
  details?: ReactNode[];
  /** 場數還不夠、只供參考：數字變淡並加一個小標。 */
  thin?: boolean;
  /** 無障礙名稱與滑鼠提示。 */
  label?: string;
  onClick?: () => void;
}

function rankClass(rank: number): string {
  if (rank === 1) return 'text-amber-300';
  if (rank === 2) return 'text-gray-200';
  if (rank === 3) return 'text-orange-300';
  return 'text-zinc-500';
}

function Card({ row, tone, refValue, max }: { row: BoardCardRow; tone: GlanceTone; refValue?: number | null; max: number }): JSX.Element {
  const { t } = useTranslation('common');
  const body = (
    <>
      <div className="flex items-baseline gap-2">
        {row.rank !== null && <span className={`w-5 shrink-0 text-right text-sm font-black tabular-nums ${rankClass(row.rank)}`}>{row.rank}</span>}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white">{row.name}</span>
        {row.thin && <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-200">{t(`${G}.thin`)}</span>}
        {/* 沒有長條的榜（Elo、有正有負的數字）：大數字寫在名字右邊 */}
        {row.value === null && <span className={`shrink-0 text-sm font-bold tabular-nums ${row.text === '—' ? 'text-zinc-500' : 'text-white'} ${row.thin ? 'opacity-60' : ''}`} title={row.label}>{row.text}</span>}
      </div>
      {row.value !== null && (
        <div className={`mt-1 ${row.thin ? 'opacity-60' : ''}`}>
          <MeterBar pct={row.value} text={row.text} tone={tone} refPct={refValue} max={max} label={row.label} />
        </div>
      )}
      {row.details && row.details.length > 0 && (
        <p className="mt-1 flex flex-wrap gap-x-3 text-[11px] leading-snug tabular-nums text-zinc-400">
          {row.details.map((d, i) => <span key={i} className="whitespace-nowrap">{d}</span>)}
        </p>
      )}
    </>
  );
  const cls = 'block w-full rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-left';
  return row.onClick
    ? <button type="button" onClick={row.onClick} className={`${cls} hover:border-zinc-600`} data-testid="board-card">{body}</button>
    : <div className={cls} data-testid="board-card">{body}</div>;
}

export function BoardCards({ rows, reference = [], referenceExtra, refValue, refNote, tone = 'rank', max = 100, topN = 10, table }: {
  rows: readonly BoardCardRow[];
  /** 對照組（不排名）：收在下面的收合區。 */
  reference?: readonly BoardCardRow[];
  /** 對照組收合區裡的額外控制（例：「顯示基準列」開關）。 */
  referenceExtra?: ReactNode;
  /** 長條上的白線（不算散客的全體）。 */
  refValue?: number | null;
  /** 白線是什麼（預設「不算散客的全體」；別的對照例如決定性票的全體正確率自己給）。 */
  refNote?: string;
  tone?: GlanceTone;
  /** 長條滿格代表多少（勝率 = 100）。 */
  max?: number;
  topN?: number;
  /** 完整表格（全部欄位）：收在最下面的「進階」。 */
  table?: () => ReactNode;
}): JSX.Element {
  const { t } = useTranslation('common');
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, topN);
  return (
    <div className="space-y-2" data-testid="board-cards">
      <ol className="space-y-1.5">
        {shown.map(row => <li key={row.key}><Card row={row} tone={tone} refValue={refValue} max={max} /></li>)}
      </ol>
      {rows.length > topN && (
        <button
          type="button"
          onClick={() => setAll(a => !a)}
          aria-expanded={all}
          className="flex w-full items-center justify-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-semibold text-zinc-200 hover:border-zinc-500"
          data-testid="board-show-all"
        >
          {all ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
          {all ? t(`${G}.showTop`, { n: topN }) : t(`${G}.showAll`, { n: rows.length })}
        </button>
      )}
      <p className="text-[11px] text-zinc-500">
        {refValue !== null && refValue !== undefined && (refNote ?? t(`${G}.refLine`))}
        {rows.some(r => r.onClick) && t(`${G}.tapHint`)}
      </p>
      {(reference.length > 0 || referenceExtra) && (
        <Advanced title={t(`${G}.reference`)} testId="board-reference">
          {() => (
            <div className="space-y-1.5">
              {referenceExtra}
              {reference.map(row => <Card key={row.key} row={row} tone={tone} refValue={refValue} max={max} />)}
            </div>
          )}
        </Advanced>
      )}
      {table && <Advanced title={t(`${G}.fullTable`)} testId="board-full-table">{table}</Advanced>}
    </div>
  );
}
