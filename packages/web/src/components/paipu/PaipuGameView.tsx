import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, Copy, ExternalLink, MessageSquare, Paperclip } from 'lucide-react';
import { QuestFailMark, QuestSuccessMark, ShieldIcon } from '../ScoresheetIcons';
import { useGameStore } from '../../store/gameStore';
import { fetchPaipuReplies, type PaipuRepliesData, type PaipuReply } from '../../services/api';
import {
  PAIPU_SEATS,
  RESULT_TAGS,
  approveCount,
  discordThreadUrl,
  isForcedProposal,
  lakeClaimLabel,
  missionFails,
  missionIsRed,
  outcomeOf,
  paipuText,
  proposalVotes,
  roleOfSeat,
  sortedTeam,
  winnerOf,
  type PaipuGame,
  type PaipuOutcome,
  type PaipuPost,
} from '../../utils/paipu';

/**
 * 牌譜紀錄的一局：結果、投票矩陣（同對局畫面 LiveScoresheet 的畫法：白格贊成、黑格反對、盾牌 = 上隊、
 * 黃列任務、青列湖）、刺殺、DC 格式的文字、座位與角色（放最下方），以及討論串的回覆（伺服器即時讀 DC，機器人訊息不顯示）。
 */

export const OUTCOME_STYLE: Readonly<Record<PaipuOutcome, string>> = {
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

function seatName(game: PaipuGame, seat: string): string {
  return game.names[PAIPU_SEATS.indexOf(seat as (typeof PAIPU_SEATS)[number])] ?? '';
}

function RoleBadge({ game, seat, compact = false }: { game: PaipuGame; seat: string; compact?: boolean }): JSX.Element {
  const role = roleOfSeat(game.config, seat);
  return (
    <span className={`font-bold ${role.red ? 'text-red-400' : role.name === '忠臣' ? 'text-sky-300' : 'text-blue-300'}`}>
      {compact ? role.short : role.name}
    </span>
  );
}

function ResultBanner({ post, game }: { post: PaipuPost; game: PaipuGame }): JSX.Element {
  const outcome = game.outcome;
  const winner = winnerOf(outcome);
  const assassin = game.config[0];
  const merlin = game.config[5];
  let detail: string;
  if (outcome === '三紅') {
    detail = '紅方拿下三次任務';
  } else if (game.assassination) {
    const target = game.assassination;
    const hit = target === merlin;
    detail = `藍方拿下三次任務；刺客 ${assassin} 號 ${seatName(game, assassin)} 刺殺 ${target} 號 ${seatName(game, target)}`
      + `（${roleOfSeat(game.config, target).name}）${hit ? '，刺中梅林' : '，沒刺中'}`;
  } else {
    detail = outcome === '三藍死' ? '藍方拿下三次任務；梅林被刺中' : '藍方拿下三次任務；刺客沒刺中梅林';
  }
  return (
    <div className={`rounded-lg border px-3 py-2 ${OUTCOME_STYLE[outcome]}`} data-testid="paipu-result">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-base font-bold">{RESULT_TAGS[outcome]}</span>
        <span className={`text-sm font-semibold ${winner === 'red' ? 'text-red-300' : 'text-blue-300'}`}>
          {winner === 'red' ? '紅方勝' : '藍方勝'}
        </span>
        {game.category && <span className="text-xs text-zinc-300">· {game.category}</span>}
        {post.tags.includes('已收錄') && <span className="text-xs text-zinc-400">· 已收錄</span>}
      </div>
      <p className="mt-0.5 text-xs text-zinc-200">{detail}</p>
    </div>
  );
}

function MissionTrack({ game }: { game: PaipuGame }): JSX.Element {
  return (
    <div className="grid grid-cols-5 gap-1.5" aria-label="任務結果">
      {[0, 1, 2, 3, 4].map((i) => {
        const round = game.rounds[i];
        const red = round ? missionIsRed(round.mission, i) : null;
        return (
          <div
            key={i}
            className={`flex flex-col items-center rounded-lg border px-1 py-1.5 ${
              red === null ? 'border-zinc-700 text-zinc-500' : red ? 'border-red-500/60 bg-red-500/15 text-red-200' : 'border-blue-500/60 bg-blue-500/15 text-blue-200'
            }`}
          >
            <span className="text-[10px] text-zinc-400">第 {i + 1} 輪</span>
            <span className="font-mono text-sm font-bold tracking-wider">{round ? round.mission : '—'}</span>
            {round && (
              <span className="text-[10px]">{red ? `${missionFails(round.mission)} 張失敗` : '成功'}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Roster({ game }: { game: PaipuGame }): JSX.Element {
  const openPlayerStats = useGameStore((s) => s.openPlayerStats);
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5" data-testid="paipu-roster">
      {PAIPU_SEATS.map((seat, i) => {
        const role = roleOfSeat(game.config, seat);
        return (
          <div
            key={seat}
            className={`flex min-w-0 items-center gap-1.5 rounded-lg border px-2 py-1.5 ${
              role.red ? 'border-red-500/40 bg-red-950/40' : 'border-blue-500/30 bg-blue-950/30'
            }`}
          >
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs font-bold text-zinc-200">
              {seat}
            </span>
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => openPlayerStats(game.names[i])}
                title="看這位玩家的戰績"
                className="block w-full truncate text-left text-sm font-semibold text-white hover:text-amber-300 hover:underline"
              >
                {game.names[i]}
              </button>
              <div className="text-[11px] leading-tight"><RoleBadge game={game} seat={seat} /></div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Scoresheet({ game }: { game: PaipuGame }): JSX.Element {
  const lakes = new Map(game.lakes.map((l) => [l.after, l]));
  const rows: JSX.Element[] = [];
  game.rounds.forEach((round, r) => {
    const last = round.proposals.length - 1;
    round.proposals.forEach((p, a) => {
      const votes = proposalVotes(p, a);
      const forced = isForcedProposal(a, p);
      const approves = approveCount(p, a);
      rows.push(
        <tr key={`p-${r}-${a}`} className="border-b border-zinc-800/60">
          <td className="bg-zinc-950 px-0 py-1 text-center font-mono text-[9px] text-zinc-400 sm:text-[11px]">{r + 1}-{a + 1}</td>
          {PAIPU_SEATS.map((seat) => {
            const vote = votes?.[seat];
            return (
              <td key={seat} className={`relative p-0 align-middle ${vote === 'approve' ? 'bg-white' : vote === 'reject' ? 'bg-black' : 'bg-zinc-900/60'}`}>
                <div className="relative aspect-square w-full">
                  {p.team.includes(seat) && (
                    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                      <ShieldIcon className="h-[70%] w-[70%] text-yellow-400 drop-shadow-[0_0_1px_rgba(0,0,0,0.85)]" />
                    </div>
                  )}
                </div>
              </td>
            );
          })}
          <td className="whitespace-nowrap px-1 py-1 text-left font-mono text-[9px] leading-tight sm:text-[11px]">
            <span className="block text-zinc-200 sm:inline">{sortedTeam(p.team)}</span>{' '}
            <span className={forced ? 'text-amber-300' : a === last ? 'text-emerald-300' : 'text-zinc-500'}>
              {forced ? '強制' : `${approves}票${a === last ? '過' : ''}`}
            </span>
          </td>
        </tr>,
      );
    });
    const red = missionIsRed(round.mission, r);
    const fails = missionFails(round.mission);
    rows.push(
      <tr key={`m-${r}`} className="border-b border-yellow-900/50 bg-yellow-800/25">
        <td className="bg-yellow-900/60 px-0 py-1 text-center text-[9px] font-bold text-yellow-200 sm:text-[11px]">{r + 1}</td>
        <td colSpan={PAIPU_SEATS.length} className="px-1 py-1">
          <div className="flex items-center justify-center gap-1.5 text-yellow-100">
            <span className="text-[10px] font-bold sm:text-xs">第 {r + 1} 輪任務</span>
            <span className="flex items-center gap-[2px]">
              {[...round.mission].map((c, i) => (c === 'x'
                ? <QuestFailMark key={i} className="h-2 w-2 text-red-500 sm:h-2.5 sm:w-2.5" />
                : <QuestSuccessMark key={i} className="h-2 w-2 text-blue-500 sm:h-2.5 sm:w-2.5" />))}
            </span>
            <span className={`text-[10px] font-bold sm:text-xs ${red ? 'text-red-300' : 'text-blue-300'}`}>
              {red ? `失敗（${fails} 張）` : fails ? `成功（${fails} 張失敗）` : '成功'}
            </span>
          </div>
        </td>
        <td className="whitespace-nowrap px-1 py-1 font-mono text-[9px] text-yellow-100/80 sm:text-[11px]">{round.mission}</td>
      </tr>,
    );
    const lake = lakes.get(r + 1);
    if (lake) {
      rows.push(
        <tr key={`l-${r}`} className="border-b border-cyan-900/50 bg-cyan-800/25">
          <td className="bg-cyan-900/60 px-0 py-1 text-center text-[9px] font-bold text-cyan-200 sm:text-[11px]">湖</td>
          <td colSpan={PAIPU_SEATS.length} className="px-1 py-1 text-center text-[10px] text-cyan-50 sm:text-xs">
            <span className="font-bold">{lake.holder}</span> 號 {seatName(game, lake.holder)}{' '}
            驗 <span className="font-bold">{lake.target}</span> 號 {seatName(game, lake.target)} →{' '}
            <span className={lake.claim === 'o' ? 'font-bold text-blue-200' : lake.claim === 'x' ? 'font-bold text-red-300' : 'text-zinc-300'}>
              {lakeClaimLabel(lake.claim)}
            </span>
          </td>
          <td className="whitespace-nowrap px-1 py-1 font-mono text-[9px] text-cyan-100/80 sm:text-[11px]">
            {lake.holder}&gt;{lake.target} {lake.claim || '-'}
          </td>
        </tr>,
      );
    }
  });

  return (
    <div className="mx-auto w-full max-w-2xl" data-testid="paipu-scoresheet">
      <table className="w-full table-fixed border-collapse text-[9px] sm:text-[11px]">
        <colgroup>
          <col className="w-[24px] sm:w-[36px]" />
          {PAIPU_SEATS.map((seat) => <col key={seat} className="w-auto" />)}
          <col className="w-[52px] sm:w-[84px]" />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-zinc-950">
          <tr className="border-b border-zinc-700">
            <th scope="col" className="bg-zinc-950 px-0 py-1 text-center font-semibold text-zinc-500">次</th>
            {PAIPU_SEATS.map((seat) => (
              <th key={seat} scope="col" title={seatName(game, seat)} className="bg-zinc-950 px-0 py-1 text-center font-semibold text-zinc-300">
                <div>{seat}</div>
              </th>
            ))}
            <th scope="col" className="bg-zinc-950 px-1 py-1 text-left font-semibold text-zinc-500">隊伍</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-400 sm:text-xs">
        <span className="inline-flex items-center gap-1"><ShieldIcon className="h-3.5 w-3.5 text-yellow-400" />上隊</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3.5 w-3.5 border border-zinc-500 bg-white" />贊成</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3.5 w-3.5 border border-zinc-500 bg-black" />反對</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3.5 w-3.5 border border-zinc-700 bg-zinc-900" />強制局（不投票）</span>
        <span>「次」= 第幾輪第幾次提議</span>
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

function ReplyItem({ reply, byId }: { reply: PaipuReply; byId: Map<string, PaipuReply> }): JSX.Element {
  const parent = reply.replyTo ? byId.get(reply.replyTo) : undefined;
  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2" data-testid="paipu-reply">
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

type RepliesState = { status: 'loading' } | { status: 'error' } | { status: 'ok'; data: PaipuRepliesData };

function Replies({ id, url }: { id: string; url: string }): JSX.Element {
  const [state, setState] = useState<RepliesState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    fetchPaipuReplies(id)
      .then((data) => { if (!cancelled) setState({ status: 'ok', data }); })
      .catch(() => { if (!cancelled) setState({ status: 'error' }); });
    return (): void => { cancelled = true; };
  }, [id]);
  const byId = useMemo(
    () => new Map(state.status === 'ok' ? state.data.replies.map((r) => [r.id, r]) : []),
    [state],
  );
  return (
    <section className="space-y-2" data-testid="paipu-replies">
      <h3 className="flex items-center gap-1.5 text-sm font-bold text-zinc-200">
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
        <ol className="space-y-1.5">
          {state.data.replies.map((r) => <ReplyItem key={r.id} reply={r} byId={byId} />)}
        </ol>
      )}
      <p className="text-[11px] text-zinc-500">
        回覆即時取自 DC 討論串（不含機器人訊息）{state.status === 'ok' && state.data.stale ? '；DC 暫時讀不到，顯示的是稍早的內容' : ''}。要留言請到 DC 討論。
      </p>
    </section>
  );
}

export default function PaipuGameView({ post, guildId, onBack }: { post: PaipuPost; guildId: string; onBack: () => void }): JSX.Element {
  const url = discordThreadUrl(post.id, guildId);
  const game = post.game;
  const outcome = outcomeOf(post);
  return (
    <article className="space-y-3" data-testid="paipu-game">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onBack}
          data-testid="paipu-back"
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white"
        >
          <ArrowLeft size={16} />牌譜列表
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="paipu-discord"
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-bold text-white transition-colors hover:bg-indigo-400"
        >
          <MessageSquare size={15} />到 DC 討論<ExternalLink size={13} />
        </a>
      </div>

      <header>
        <h2 className="break-words text-lg font-bold text-white">{post.title || '（沒有標題）'}</h2>
        <p className="text-xs text-zinc-400">
          牌譜日期 {post.date} · 發文 {formatTaipei(post.created)}
          {post.tags.length > 0 && <> · {post.tags.join('、')}</>}
        </p>
      </header>

      {game ? (
        <>
          <ResultBanner post={post} game={game} />
          <MissionTrack game={game} />
          <section className="space-y-1.5">
            <h3 className="text-sm font-bold text-zinc-200">提議與投票</h3>
            <div className="rounded-lg border border-zinc-800 bg-black/50 p-1 sm:p-2">
              <Scoresheet game={game} />
            </div>
          </section>
          <details className="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2">
            <summary className="cursor-pointer text-sm font-semibold text-zinc-300">DC 牌譜格式（文字）</summary>
            <div className="mt-2 flex justify-end"><CopyText text={paipuText(game)} /></div>
            <pre className="mt-1 overflow-x-auto whitespace-pre font-mono text-xs leading-5 text-zinc-200">{paipuText(game)}</pre>
          </details>
          {/* Edward 10/31：角色與對應座位放在最下方（同 DC 牌譜：刺殺、配置、名單在最後） */}
          <section className="space-y-1.5" data-testid="paipu-roster">
            <h3 className="text-sm font-bold text-zinc-200">座位與角色</h3>
            <Roster game={game} />
          </section>
        </>
      ) : (
        <div className="rounded-lg border border-zinc-700 bg-zinc-900/70 px-3 py-3 text-sm text-zinc-200" data-testid="paipu-unreadable">
          {outcome && <p className="mb-1 font-bold">{RESULT_TAGS[outcome]}</p>}
          <p>
            這篇的牌譜格式目前讀不懂
            {post.problem ? `（${post.problemLine ? `第 ${post.problemLine} 行：` : ''}${post.problem}）` : ''}
            ，請到 DC 看原文。修好後隔天就會出現在這裡。
          </p>
        </div>
      )}

      <Replies key={post.id} id={post.id} url={url} />
    </article>
  );
}
