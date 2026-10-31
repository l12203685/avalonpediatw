import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ArrowLeft, Check, Copy, ExternalLink, MessageSquare, Paperclip } from 'lucide-react';
import { QuestFailMark, QuestSuccessMark, ShieldIcon } from '../ScoresheetIcons';
import { useGameStore } from '../../store/gameStore';
import { fetchRecordsReplies, type RecordRepliesData, type RecordReply } from '../../services/api';
import { useRecordsPrefs } from './recordsPrefs';
import { LineupSummary } from './RecordsLineup';
import {
  RECORDS_SEATS,
  RESULT_TAGS,
  approveCount,
  discordThreadUrl,
  isForcedProposal,
  lakeClaimLabel,
  missionFails,
  missionIsRed,
  outcomeOf,
  recordsText,
  proposalVotes,
  resultSentence,
  roleOfSeat,
  seatLabel,
  deriveLeaders,
  lakeLine,
  proposalLine,
  winnerOf,
  type RecordDisplayPrefs,
  type RecordGame,
  type RecordLineup,
  type RecordOutcome,
  type RecordPost,
} from '../../utils/records';

/**
 * 牌譜紀錄的一局（Edward 2026-10-31：「牌譜我希望呈現在一個頁面內呈現，不需要往下拉」「角色跟玩家名稱可以選擇是否展示」）。
 *
 * - 寬度 ≥1024px：整局放在一個畫面，頁面不捲動。左欄投票矩陣（同對局畫面 LiveScoresheet 的畫法：白格贊成、黑格反對、
 *   盾牌 = 上隊、黃列任務、青列湖），列高依可用高度自動壓縮（14–28px，非正方形格子）。欄位照 Edward 的試算表牌譜
 *   （10/31：「文字牌譜直接顯示在視覺牌譜旁邊」）：隊長｜1～0｜結果｜隊長｜文字紀錄——每一列右邊就是那一列的 DC 牌譜文字，
 *   隊長由輪替推算（utils/records deriveLeaders，推算不出來時第一欄顯示第幾輪第幾次）；右欄標題、到 DC 討論、結果、
 *   任務、開關、DC 格式文字（預設收合）、討論串回覆（面板內捲動）。
 * - 手機：同樣順序排成一欄，矩陣用固定 20px 的列高；DC 文字與回覆在矩陣下面（頁面會捲動）。
 * - 「顯示角色」「顯示名稱」預設都關（recordsPrefs）。角色與暱稱顯示在矩陣表頭 1～0 正上方（Edward 10/31：「就顯示在 1~0
 *   正上方」，所以不再另列座位區）；結果說明與湖列也跟著開關。關掉時哪裡都不出現，只看座位號。DC 格式文字與回覆是原文，不受影響。
 */

export const OUTCOME_STYLE: Readonly<Record<RecordOutcome, string>> = {
  三紅: 'bg-red-500/20 text-red-200 border-red-500/50',
  三藍死: 'bg-amber-500/20 text-amber-200 border-amber-500/50',
  三藍活: 'bg-blue-500/20 text-blue-200 border-blue-500/50',
};

const TAIPEI_DATE = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

export function formatTaipei(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : TAIPEI_DATE.format(d);
}

const DESKTOP_QUERY = '(min-width: 1024px)';
const MOBILE_ROW_PX = 20;
const MIN_ROW_PX = 14;
const MAX_ROW_PX = 28;

/** ≥1024px 時把整局的高度定成「視窗底部 − 元素頂端」，頁面就不用捲動；手機回傳 null（照內容長）。 */
function useFitToViewport(ref: RefObject<HTMLElement>): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const update = (): void => {
      const el = ref.current;
      if (!mq.matches || !el) {
        setHeight(null);
        return;
      }
      const top = el.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(400, Math.floor(window.innerHeight - top - 10)));
    };
    update();
    window.addEventListener('resize', update);
    mq.addEventListener('change', update);
    return (): void => {
      window.removeEventListener('resize', update);
      mq.removeEventListener('change', update);
    };
  }, [ref]);
  return height;
}

/** 寬度 ≥640px：矩陣右邊多放「結果」與第二個「隊長」欄（手機只留文字紀錄）。 */
function useWide(): boolean {
  const query = '(min-width: 640px)';
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = (): void => setWide(mq.matches);
    mq.addEventListener('change', update);
    return (): void => mq.removeEventListener('change', update);
  }, []);
  return wide;
}

function seatName(game: RecordGame, seat: string): string {
  return game.names[RECORDS_SEATS.indexOf(seat as (typeof RECORDS_SEATS)[number])] ?? '';
}

function roleClass(game: RecordGame, seat: string): string {
  const role = roleOfSeat(game.config, seat);
  return role.red ? 'text-red-400' : role.name === '忠臣' ? 'text-sky-300' : 'text-blue-300';
}

function Toggles({ prefs, onChange }: { prefs: RecordDisplayPrefs; onChange: (key: keyof RecordDisplayPrefs, on: boolean) => void }): JSX.Element {
  const items: { key: keyof RecordDisplayPrefs; label: string }[] = [
    { key: 'roles', label: '顯示角色' },
    { key: 'names', label: '顯示名稱' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="records-toggles">
      {items.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          role="switch"
          aria-checked={prefs[key]}
          data-testid={`records-toggle-${key}`}
          onClick={() => onChange(key, !prefs[key])}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors ${
            prefs[key] ? 'border-amber-400 bg-amber-400/15 text-amber-200' : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <span className={`relative inline-block h-3 w-5 rounded-full transition-colors ${prefs[key] ? 'bg-amber-400' : 'bg-zinc-600'}`}>
            <span className={`absolute top-0.5 h-2 w-2 rounded-full bg-black transition-all ${prefs[key] ? 'left-2.5' : 'left-0.5'}`} />
          </span>
          {label}
        </button>
      ))}
    </div>
  );
}

function ResultBanner({ post, game, prefs }: { post: RecordPost; game: RecordGame; prefs: RecordDisplayPrefs }): JSX.Element {
  const winner = winnerOf(game.outcome);
  return (
    <div className={`rounded-lg border px-3 py-1.5 ${OUTCOME_STYLE[game.outcome]}`} data-testid="records-result">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-base font-bold">{RESULT_TAGS[game.outcome]}</span>
        <span className={`text-sm font-semibold ${winner === 'red' ? 'text-red-300' : 'text-blue-300'}`}>
          {winner === 'red' ? '紅方勝' : '藍方勝'}
        </span>
        {game.category && <span className="text-xs text-zinc-300">· {game.category}</span>}
        {post.tags.includes('已收錄') && <span className="text-xs text-zinc-400">· 已收錄</span>}
      </div>
      <p className="text-xs text-zinc-200">{resultSentence(game, prefs)}</p>
    </div>
  );
}

function MissionTrack({ game }: { game: RecordGame }): JSX.Element {
  return (
    <div className="grid grid-cols-5 gap-1" aria-label="任務結果">
      {[0, 1, 2, 3, 4].map((i) => {
        const round = game.rounds[i];
        const red = round ? missionIsRed(round.mission, i) : null;
        return (
          <div
            key={i}
            className={`flex flex-col items-center rounded-md border px-1 py-0.5 leading-tight ${
              red === null ? 'border-zinc-700 text-zinc-500' : red ? 'border-red-500/60 bg-red-500/15 text-red-200' : 'border-blue-500/60 bg-blue-500/15 text-blue-200'
            }`}
          >
            <span className="text-[10px] text-zinc-400">第 {i + 1} 輪</span>
            <span className="font-mono text-sm font-bold tracking-wider">{round ? round.mission : '—'}</span>
          </div>
        );
      })}
    </div>
  );
}

function Scoresheet({ game, prefs, fit, lineup }: {
  game: RecordGame; prefs: RecordDisplayPrefs; fit: boolean; lineup?: RecordLineup;
}): JSX.Element {
  const openPlayerStats = useGameStore((s) => s.openPlayerStats);
  const boxRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLTableSectionElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const lakes = new Map(game.lakes.map((l) => [l.after, l]));
  const rowCount = game.rounds.reduce((n, r, i) => n + r.proposals.length + 1 + (lakes.has(i + 1) ? 1 : 0), 0);
  const [fitRowPx, setRowPx] = useState(MOBILE_ROW_PX);
  const rowPx = fit ? fitRowPx : MOBILE_ROW_PX;

  // 桌面：可用高度 ÷ 列數 = 列高（14–28px），整張表不用捲動；手機固定 20px。
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!fit || !box) return undefined;
    const update = (): void => {
      const free = box.clientHeight - (headRef.current?.offsetHeight ?? 0) - (legendRef.current?.offsetHeight ?? 0) - 6;
      setRowPx(Math.max(MIN_ROW_PX, Math.min(MAX_ROW_PX, Math.floor(free / Math.max(rowCount, 1)))));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    return (): void => observer.disconnect();
  }, [fit, rowCount, prefs.names, prefs.roles, lineup]);

  const wide = useWide();
  const leaders = useMemo(() => deriveLeaders(game), [game]);
  // 試算表牌譜的第二個「隊長」欄（在文字紀錄前面）：寬螢幕、而且推算得出隊長時才放
  const lead2 = wide && leaders !== null;
  const rowStyle = { height: rowPx };
  const shield = Math.max(8, rowPx - 3);
  const text = rowPx < 18 ? 'text-[9px] sm:text-[10px]' : 'text-[9px] sm:text-[11px]';
  const rows: JSX.Element[] = [];
  game.rounds.forEach((round, r) => {
    const last = round.proposals.length - 1;
    round.proposals.forEach((p, a) => {
      const votes = proposalVotes(p, a);
      const forced = isForcedProposal(a, p);
      const approves = approveCount(p, a);
      rows.push(
        <tr key={`p-${r}-${a}`} style={rowStyle} className="border-b border-zinc-800/60">
          <td
            title={`第 ${r + 1} 輪第 ${a + 1} 次提議`}
            className={`bg-zinc-950 p-0 text-center font-mono leading-none ${leaders ? 'font-bold text-yellow-400' : 'text-zinc-400'}`}
          >
            {leaders ? leaders[r][a] : `${r + 1}-${a + 1}`}
          </td>
          {RECORDS_SEATS.map((seat) => {
            const vote = votes?.[seat];
            return (
              <td key={seat} className={`relative p-0 ${vote === 'approve' ? 'bg-white' : vote === 'reject' ? 'bg-black' : 'bg-zinc-900/60'}`}>
                {p.team.includes(seat) && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <span style={{ height: shield, width: shield }} className="block">
                      <ShieldIcon className="h-full w-full text-yellow-400 drop-shadow-[0_0_1px_rgba(0,0,0,0.85)]" />
                    </span>
                  </div>
                )}
              </td>
            );
          })}
          {wide && (
            <td className={`whitespace-nowrap px-1 py-0 text-center leading-none ${forced ? 'text-amber-300' : a === last ? 'text-emerald-300' : 'text-zinc-500'}`}>
              {forced ? '強制' : `${approves}票${a === last ? '過' : ''}`}
            </td>
          )}
          {lead2 && <td className="p-0 text-center font-mono font-bold leading-none text-yellow-400">{leaders?.[r][a]}</td>}
          <td className="max-w-0 truncate px-1 py-0 font-mono leading-none text-zinc-100" title={proposalLine(p, a)} data-testid="records-text-line">
            {proposalLine(p, a)}
          </td>
        </tr>,
      );
    });
    const red = missionIsRed(round.mission, r);
    const fails = missionFails(round.mission);
    rows.push(
      <tr key={`m-${r}`} style={rowStyle} className="border-b border-yellow-900/50 bg-yellow-800/25">
        <td title={`第 ${r + 1} 輪任務`} className="bg-yellow-900/60 p-0 text-center font-bold leading-none text-yellow-200">任務</td>
        <td colSpan={RECORDS_SEATS.length} className="px-1 py-0">
          <div className="flex items-center justify-center gap-1.5 whitespace-nowrap leading-none text-yellow-100">
            <span className="font-bold">第 {r + 1} 輪任務</span>
            <span className="flex items-center gap-[2px]">
              {[...round.mission].map((c, i) => (c === 'x'
                ? <QuestFailMark key={i} className="h-2 w-2 text-red-500 sm:h-2.5 sm:w-2.5" />
                : <QuestSuccessMark key={i} className="h-2 w-2 text-blue-500 sm:h-2.5 sm:w-2.5" />))}
            </span>
            <span className={`font-bold ${red ? 'text-red-300' : 'text-blue-300'}`}>
              {red ? `失敗（${fails} 張）` : fails ? `成功（${fails} 張失敗）` : '成功'}
            </span>
          </div>
        </td>
        {wide && (
          <td className={`p-0 text-center font-mono font-bold leading-none text-white ${red ? 'bg-red-600/80' : 'bg-blue-600/80'}`}>
            {round.mission}
          </td>
        )}
        {lead2 && <td className="p-0" />}
        <td className={`px-1 py-0 font-mono font-bold leading-none ${red ? 'text-red-300' : 'text-blue-300'}`} data-testid="records-text-line">
          {round.mission}
        </td>
      </tr>,
    );
    const lake = lakes.get(r + 1);
    if (lake) {
      rows.push(
        <tr key={`l-${r}`} style={rowStyle} className="border-b border-cyan-900/50 bg-cyan-800/25">
          <td className="bg-cyan-900/60 p-0 text-center font-bold leading-none text-cyan-200">湖中</td>
          <td colSpan={RECORDS_SEATS.length} className="max-w-0 px-1 py-0">
            <div className="truncate text-center leading-none text-cyan-50" data-testid="records-lake">
              {seatLabel(game, lake.holder, prefs)} 驗 {seatLabel(game, lake.target, prefs)} →{' '}
              <span className={lake.claim === 'o' ? 'font-bold text-blue-200' : lake.claim === 'x' ? 'font-bold text-red-300' : 'text-zinc-300'}>
                {lakeClaimLabel(lake.claim)}
              </span>
            </div>
          </td>
          {wide && <td className="bg-cyan-600/70 p-0 text-center font-mono font-bold leading-none text-white">{lakeLine(lake)}</td>}
          {lead2 && <td className="p-0" />}
          <td className="px-1 py-0 font-mono leading-none text-cyan-100" data-testid="records-text-line">{lakeLine(lake)}</td>
        </tr>,
      );
    }
  });

  return (
    <div ref={boxRef} className="flex min-h-0 w-full flex-col lg:h-full" data-testid="records-scoresheet">
      <div className={fit ? 'min-h-0 flex-1 overflow-auto' : ''}>
        <table className={`w-full table-fixed border-collapse ${text}`}>
          <colgroup>
            <col className="w-[24px] sm:w-[34px]" />
            {RECORDS_SEATS.map((seat) => <col key={seat} className="w-auto" />)}
            {wide && <col className="w-[52px] lg:w-[60px]" />}
            {lead2 && <col className="w-[30px]" />}
            <col className="w-[78px] sm:w-[104px] xl:w-[120px]" />
          </colgroup>
          <thead ref={headRef} className="sticky top-0 z-10 bg-zinc-950">
            <tr className="border-b border-zinc-700">
              <th
                scope="col"
                title={leaders ? '隊長（牌譜沒寫，依輪替推算）' : '第幾輪第幾次提議'}
                className="bg-zinc-950 px-0 py-0.5 text-center font-semibold text-zinc-500"
              >
                {leaders ? '隊長' : '次'}
              </th>
              {RECORDS_SEATS.map((seat) => (
                <th
                  key={seat}
                  scope="col"
                  title={prefs.names ? seatName(game, seat) : undefined}
                  className="max-w-0 bg-zinc-950 px-0 py-0.5 text-center font-semibold leading-tight text-zinc-300"
                >
                  <div>{seat}</div>
                  {lineup && ((): JSX.Element => {
                    const i = RECORDS_SEATS.indexOf(seat);
                    const pr = lineup.prs[i];
                    const prov = lineup.prov.includes(seat);
                    return (
                      <div
                        title={`開打前 PR ${pr}${prov ? '（暫定或對不到人，最高算 50）' : ''}`}
                        data-testid="records-seat-pr"
                        className={`font-mono text-[8px] font-normal leading-tight sm:text-[9px] ${prov ? 'text-zinc-500' : pr >= 70 ? 'text-amber-300' : 'text-zinc-400'}`}
                      >
                        {pr}{prov ? '*' : ''}
                      </div>
                    );
                  })()}
                  {prefs.roles && <div className={`text-[9px] sm:text-[10px] ${roleClass(game, seat)}`}>{roleOfSeat(game.config, seat).short}</div>}
                  {prefs.names && (
                    <button
                      type="button"
                      onClick={() => openPlayerStats(seatName(game, seat))}
                      title={`${seatName(game, seat)}：看這位玩家的戰績`}
                      className="block w-full truncate px-px text-[8px] font-normal text-zinc-300 hover:text-amber-300 sm:text-[10px]"
                    >
                      {seatName(game, seat)}
                    </button>
                  )}
                </th>
              ))}
              {wide && <th scope="col" className="bg-zinc-950 px-0 py-0.5 text-center font-semibold text-zinc-500">結果</th>}
              {lead2 && <th scope="col" className="bg-zinc-950 px-0 py-0.5 text-center font-semibold text-zinc-500">隊長</th>}
              <th scope="col" className="bg-zinc-950 px-1 py-0.5 text-left font-semibold text-zinc-500">文字紀錄</th>
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
      <div ref={legendRef} className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-zinc-400 sm:text-[11px]">
        <span className="inline-flex items-center gap-1"><ShieldIcon className="h-3 w-3 text-yellow-400" />上隊</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 border border-zinc-500 bg-white" />贊成</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 border border-zinc-500 bg-black" />反對</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 border border-zinc-700 bg-zinc-900" />強制局（不投票）</span>
        <span>{leaders ? '隊長依輪替推算（DC 牌譜沒寫隊長）' : '「次」= 第幾輪第幾次提議（隊長推算不出來）'}</span>
        {lineup && <span>座位號下的數字 = 開打前 PR（* 暫定）</span>}
      </div>
    </div>
  );
}

function CopyText({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }).catch(() => undefined);
      }}
      className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white"
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? '已複製' : '複製'}
    </button>
  );
}

const URL_RE = /(https?:\/\/[^\s<>]+)/g;

function Linkified({ text }: { text: string }): JSX.Element {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1
        ? <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-sky-300 underline">{part}</a>
        : <span key={i}>{part}</span>))}
    </>
  );
}

function ReplyItem({ reply, byId }: { reply: RecordReply; byId: Map<string, RecordReply> }): JSX.Element {
  const parent = reply.replyTo ? byId.get(reply.replyTo) : undefined;
  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2" data-testid="records-reply">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-bold text-zinc-100">{reply.author}</span>
        <span className="text-[11px] text-zinc-500">{formatTaipei(reply.time)}{reply.edited ? '（已編輯）' : ''}</span>
      </div>
      {parent && <div className="mt-0.5 truncate text-[11px] text-zinc-500">↪ 回覆 {parent.author}：{parent.text}</div>}
      {reply.text && (
        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-200"><Linkified text={reply.text} /></p>
      )}
      {reply.attachments.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-2">
          {reply.attachments.map((a) => (a.image ? (
            <a key={a.url} href={a.url} target="_blank" rel="noopener noreferrer">
              <img src={a.url} alt={a.name} loading="lazy" className="max-h-48 max-w-full rounded border border-zinc-700" />
            </a>
          ) : (
            <a key={a.url} href={a.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-sky-300 underline">
              <Paperclip size={12} />{a.name}
            </a>
          )))}
        </div>
      )}
    </li>
  );
}

type RepliesState = { status: 'loading' } | { status: 'error' } | { status: 'ok'; data: RecordRepliesData };

function Replies({ id, url, fit }: { id: string; url: string; fit: boolean }): JSX.Element {
  const [state, setState] = useState<RepliesState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    fetchRecordsReplies(id)
      .then((data) => { if (!cancelled) setState({ status: 'ok', data }); })
      .catch(() => { if (!cancelled) setState({ status: 'error' }); });
    return (): void => { cancelled = true; };
  }, [id]);
  const byId = useMemo(
    () => new Map(state.status === 'ok' ? state.data.replies.map((r) => [r.id, r]) : []),
    [state],
  );
  return (
    <section
      className={`flex flex-col gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 ${fit ? 'min-h-[7rem] flex-1' : ''}`}
      data-testid="records-replies"
    >
      <h3 className="flex flex-shrink-0 items-center gap-1.5 text-sm font-bold text-zinc-200">
        <MessageSquare size={15} />
        討論串回覆{state.status === 'ok' ? `（${state.data.replies.length}）` : ''}
      </h3>
      {state.status === 'loading' && <p className="text-xs text-zinc-500">載入回覆中…</p>}
      {state.status === 'error' && (
        <p className="text-xs text-zinc-400">
          討論串回覆暫時無法載入，請
          <a href={url} target="_blank" rel="noopener noreferrer" className="mx-1 text-indigo-300 underline">到 DC 查看</a>。
        </p>
      )}
      {state.status === 'ok' && state.data.replies.length === 0 && (
        <p className="text-xs text-zinc-500">還沒有人回覆。</p>
      )}
      {state.status === 'ok' && state.data.replies.length > 0 && (
        <ol className={`space-y-1.5 ${fit ? 'min-h-0 flex-1 overflow-y-auto pr-1' : ''}`} data-testid="records-reply-list">
          {state.data.replies.map((r) => <ReplyItem key={r.id} reply={r} byId={byId} />)}
        </ol>
      )}
      <p className="flex-shrink-0 text-[10px] text-zinc-500">
        回覆即時取自 DC 討論串（不含機器人訊息）{state.status === 'ok' && state.data.stale ? '；DC 暫時讀不到，顯示的是稍早的內容' : ''}。要留言請到 DC 討論。
      </p>
    </section>
  );
}

export default function RecordsGameView({ post, guildId, onBack }: { post: RecordPost; guildId: string; onBack: () => void }): JSX.Element {
  const url = discordThreadUrl(post.id, guildId);
  const game = post.game;
  const outcome = outcomeOf(post);
  const [prefs, setPref] = useRecordsPrefs();
  const rootRef = useRef<HTMLElement>(null);
  const fitHeight = useFitToViewport(rootRef);
  const fit = fitHeight !== null;
  const text = game ? recordsText(game) : '';

  const side = game ? 'lg:col-start-2' : 'lg:col-start-1';
  return (
    <article
      ref={rootRef}
      style={fit ? { height: fitHeight } : undefined}
      data-testid="records-game"
      className={`flex flex-col gap-2 lg:grid lg:gap-x-4 lg:gap-y-2 lg:overflow-hidden lg:grid-rows-[auto_minmax(0,1fr)] ${
        game ? 'lg:grid-cols-[minmax(0,1fr)_minmax(340px,400px)]' : 'lg:mx-auto lg:w-full lg:max-w-2xl lg:grid-cols-1'
      }`}
    >
      {/* 右欄上半（手機：最上面） */}
      <div className={`flex flex-col gap-2 ${side} lg:row-start-1`}>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onBack}
            data-testid="records-back"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white"
          >
            <ArrowLeft size={16} />牌譜列表
          </button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="records-discord"
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-500 px-3 py-1 text-sm font-bold text-white transition-colors hover:bg-indigo-400"
          >
            <MessageSquare size={15} />到 DC 討論<ExternalLink size={13} />
          </a>
        </div>
        <header>
          <h2 className="break-words text-lg font-bold leading-snug text-white">{post.title || '（沒有標題）'}</h2>
          <p className="text-[11px] text-zinc-400">
            牌譜日期 {post.date} · 發文 {formatTaipei(post.created)}
            {post.tags.length > 0 && <> · {post.tags.join('、')}</>}
          </p>
        </header>
        {game ? (
          <>
            <ResultBanner post={post} game={game} prefs={prefs} />
            <MissionTrack game={game} />
            <LineupSummary post={post} showRoles={prefs.roles} />
            <Toggles prefs={prefs} onChange={setPref} />
          </>
        ) : (
          <div className="rounded-lg border border-zinc-700 bg-zinc-900/70 px-3 py-3 text-sm text-zinc-200" data-testid="records-unreadable">
            {outcome && <p className="mb-1 font-bold">{RESULT_TAGS[outcome]}</p>}
            <p>
              這篇的牌譜格式目前讀不懂
              {post.problem ? `（${post.problemLine ? `第 ${post.problemLine} 行：` : ''}${post.problem}）` : ''}
              ，請到 DC 看原文。修好後隔天就會出現在這裡。
            </p>
          </div>
        )}
      </div>

      {/* 左欄：投票矩陣（手機：結果下面） */}
      {game && (
        <section className="min-h-0 rounded-lg border border-zinc-800 bg-black/50 p-1 sm:p-1.5 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <Scoresheet game={game} prefs={prefs} fit={fit} lineup={post.lineup} />
        </section>
      )}

      {/* 右欄下半：DC 文字（收合）、回覆（面板內捲動） */}
      <div className={`flex min-h-0 flex-col gap-2 ${side} lg:row-start-2`}>
        {game && (
          <details className="flex-shrink-0 rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-1.5">
            <summary className="cursor-pointer text-xs font-semibold text-zinc-300">DC 牌譜格式（文字）</summary>
            <div className="mt-1 flex justify-end"><CopyText text={text} /></div>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre font-mono text-xs leading-5 text-zinc-200">{text}</pre>
          </details>
        )}
        <Replies key={post.id} id={post.id} url={url} fit={fit} />
      </div>
    </article>
  );
}
