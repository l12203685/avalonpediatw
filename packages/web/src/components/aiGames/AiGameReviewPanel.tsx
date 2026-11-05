/**
 * 百科AI 對局的回顧（Edward 2026-11-05），照「與機器人練習」的賽後回顧（practice/PracticeReviewPanel.tsx）做：
 * 開牌後每一家的角色、依局分段的公開紀錄（提議、投票、任務、湖、刺殺），每一個百科AI 的決定附理由，
 * 可以依百科AI 座位、決定種類篩選；每一步有「這步怪怪的」按鈕，寫原因（暱稱選填）送出 → 伺服器貼成那篇 DC 討論串的回覆。
 * 網站上不顯示真人暱稱（只有座位與角色）。
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Check, ExternalLink, Flag, Loader2 } from 'lucide-react';
import {
  AI_DECISION_KINDS, AI_DECISION_KIND_LABEL, decisionWhere, resultText, reviewSections, roleZh, seatText,
  type AiDecision, type AiDecisionKind, type AiGameSeat, type AiGameTrace,
} from '../../utils/aiGames';
import { aiGamesErrorText, flagAiDecision } from '../../services/aiGames';

const NAME_KEY = 'avalon.aiGames.name';
const NOTE_MAX = 500;
const NAME_MAX = 32;

function readName(): string {
  try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; }
}
function saveName(name: string): void {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* 無痕／封鎖儲存：只是不記住 */ }
}

function teamTone(team: 'good' | 'evil' | null | undefined): string {
  if (team === 'good') return 'border-sky-600/70 bg-sky-950/50 text-sky-100';
  if (team === 'evil') return 'border-rose-600/70 bg-rose-950/50 text-rose-100';
  return 'border-zinc-700 bg-zinc-900 text-zinc-200';
}

interface Props {
  threadId: string;
  trace: AiGameTrace;
  discordUrl?: string;
}

export default function AiGameReviewPanel({ threadId, trace, discordUrl }: Props): JSX.Element {
  const [aiSeat, setAiSeat] = useState<number | null>(null);
  const [kind, setKind] = useState<AiDecisionKind | null>(null);
  const [name, setName] = useState(readName);
  const [flagged, setFlagged] = useState<Set<number>>(() => new Set());
  const aiSeats = trace.seats.filter((s) => s.ai);
  const filtering = aiSeat !== null || kind !== null;
  const sections = useMemo(
    () => reviewSections(trace, (d) => (aiSeat === null || d.seat === aiSeat) && (kind === null || d.kind === kind), filtering),
    [trace, aiSeat, kind, filtering],
  );
  const knowledge = aiSeats.map((s) => ({ seat: s, text: trace.decisions.find((d) => d.seat === s.seat && d.knowledge)?.knowledge }))
    .filter((k) => k.text);

  return (
    <div data-testid="ai-game-review" className="space-y-3 pb-6 text-left">
      <div className="rounded-lg border border-zinc-700 bg-zinc-900/80 p-3 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base sm:text-lg font-bold text-white">{[trace.title, trace.room].filter(Boolean).join('／')}</h2>
          <span className={`text-sm font-semibold ${trace.winner === 'evil' ? 'text-rose-300' : 'text-sky-300'}`}>{resultText(trace)}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {trace.seats.map((s) => <SeatChip key={s.seat} seat={s} />)}
        </div>
        {knowledge.length > 0 && (
          <div className="space-y-0.5 text-[11px] text-zinc-300">
            {knowledge.map((k) => <p key={k.seat.seat}><span className="text-zinc-400">{seatText(k.seat.seat)} 夜晚資訊：</span>{k.text}</p>)}
          </div>
        )}
        <p className="text-[11px] text-zinc-400">
          百科AI 決定 {trace.decisions.length} 個 · 理由和網站「與機器人練習」的賽後回顧是同一套說明
          {trace.notes.map((n) => <span key={n} className="block text-amber-300/90">註：{n}</span>)}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-300">
          <label htmlFor="ai-game-name" className="text-zinc-400">回饋暱稱（選填）</label>
          <input
            id="ai-game-name"
            value={name}
            maxLength={NAME_MAX}
            onChange={(e) => { setName(e.target.value.slice(0, NAME_MAX)); saveName(e.target.value.slice(0, NAME_MAX)); }}
            placeholder="不填＝匿名"
            className="w-32 rounded border border-zinc-700 bg-black/70 px-2 py-0.5 text-[12px] text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-400"
          />
          {discordUrl && (
            <a href={discordUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-emerald-300 hover:text-emerald-200">
              到 DC 討論串看回覆 <ExternalLink size={12} />
            </a>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex gap-1.5 overflow-x-auto pb-1" aria-label="依百科AI 座位篩選">
          <FilterChip active={aiSeat === null} onClick={() => setAiSeat(null)}>全部百科AI</FilterChip>
          {aiSeats.map((s) => (
            <FilterChip key={s.seat} active={aiSeat === s.seat} onClick={() => setAiSeat(aiSeat === s.seat ? null : s.seat)} team={s.team}>
              {seatText(s.seat)} {s.role}
            </FilterChip>
          ))}
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1" aria-label="依決定種類篩選">
          <FilterChip active={kind === null} onClick={() => setKind(null)}>全部動作</FilterChip>
          {AI_DECISION_KINDS.filter((k) => trace.decisions.some((d) => d.kind === k)).map((k) => (
            <FilterChip key={k} active={kind === k} onClick={() => setKind(kind === k ? null : k)}>{AI_DECISION_KIND_LABEL[k]}</FilterChip>
          ))}
        </div>
      </div>

      {sections.length === 0 && <p className="text-sm text-zinc-400 py-6 text-center">沒有符合的決定</p>}

      {sections.map((section) => (
        <section key={section.key} className="space-y-2">
          <h3 className="bg-black/60 py-1 text-sm font-bold text-amber-200 border-b border-zinc-800">{section.title}</h3>
          {section.blocks.map((block) => (
            <div key={block.key} className="space-y-1.5">
              <p className="text-[11px] font-semibold text-zinc-400">
                {block.title}
                {block.facts.map((f) => <span key={f} className="ml-1.5 font-normal text-zinc-300">{f}</span>)}
              </p>
              {block.decisions.map((d) => (
                <DecisionCard
                  key={d.id}
                  threadId={threadId}
                  decision={d}
                  name={name}
                  flagged={flagged.has(d.id)}
                  onFlagged={() => setFlagged((prev) => new Set(prev).add(d.id))}
                />
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function SeatChip({ seat }: { seat: AiGameSeat }): JSX.Element {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${teamTone(seat.team)} ${seat.ai ? 'ring-2 ring-amber-400' : ''}`}>
      <span className="font-mono font-bold">{seat.seat === 10 ? '0' : seat.seat}</span>
      <span>{seat.role || '?'}</span>
      {seat.ai && <span className="font-semibold text-amber-300">百科AI</span>}
    </span>
  );
}

function FilterChip({ active, onClick, children, team }: { active: boolean; onClick: () => void; children: ReactNode; team?: 'good' | 'evil' | null }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
        active ? 'bg-white text-black border-white' : team ? `${teamTone(team)} hover:brightness-125` : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  );
}

interface CardProps {
  threadId: string;
  decision: AiDecision;
  name: string;
  flagged: boolean;
  onFlagged: () => void;
}

function DecisionCard({ threadId, decision: d, name, flagged, onFlagged }: CardProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const send = async (): Promise<void> => {
    if (sending) return;
    setSending(true);
    setMessage(null);
    try {
      await flagAiDecision(threadId, d.id, note.trim(), name.trim());
      onFlagged();
      setOpen(false);
      setMessage({ ok: true, text: '已貼到 DC 討論串，謝謝！' });
    } catch (err) {
      setMessage({ ok: false, text: `沒送出：${aiGamesErrorText(err)}` });
    } finally {
      setSending(false);
    }
  };

  return (
    <article data-testid="ai-game-decision" className={`rounded-md border px-2.5 py-2 space-y-1 ${teamTone(d.team)}`}>
      <header className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="rounded bg-black/40 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-200">#{d.id} {AI_DECISION_KIND_LABEL[d.kind]}</span>
        <span className="font-bold">{seatText(d.seat)} {roleZh(d.role)}</span>
        <span className="text-white font-semibold">→ {d.action}</span>
        {d.source === 'fallback' && <span className="rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] text-amber-200">預設動作</span>}
        <span className="text-[10px] text-zinc-400">{decisionWhere(d)}</span>
      </header>
      <p className="text-[12px] leading-relaxed text-zinc-100">{d.reason}</p>
      <div className="space-y-0.5 text-[11px] leading-relaxed text-zinc-300/90">
        {d.rule && <p><span className="text-zinc-400">規則：</span>{d.rule}</p>}
        {d.suspects && d.suspects.length > 0 ? (
          <p>
            <span className="text-zinc-400">{d.suspectsLabel ?? '嫌疑'}：</span>
            {d.suspects.map((s) => `${seatText(s.seat)} ${s.score.toFixed(2)}`).join('、')}
            {d.suspectsNote && <span className="text-zinc-400">（{d.suspectsNote}）</span>}
          </p>
        ) : d.suspectsNote ? (
          <p><span className="text-zinc-400">{d.suspectsLabel ?? '嫌疑'}：</span>{d.suspectsNote}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {flagged ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300"><Check size={12} />已回饋</span>
        ) : (
          <button
            type="button"
            onClick={() => { setOpen((v) => !v); setMessage(null); }}
            data-testid="ai-game-flag-button"
            className="inline-flex items-center gap-1 rounded border border-amber-600/70 bg-amber-950/40 px-2 py-0.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-900/50"
          >
            <Flag size={12} />這步怪怪的
          </button>
        )}
        {message && <span className={`text-[11px] ${message.ok ? 'text-emerald-300' : 'text-rose-300'}`}>{message.text}</span>}
      </div>
      {open && !flagged && (
        <div className="space-y-1.5 pt-1">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
            maxLength={NOTE_MAX}
            rows={2}
            placeholder="為什麼怪？（例：隊上明明沒有可疑的人，不該反對）"
            className="w-full rounded border border-zinc-700 bg-black/70 px-2 py-1 text-[12px] text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-400"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={sending}
              onClick={() => { void send(); }}
              className="inline-flex items-center gap-1 rounded bg-amber-500 px-2.5 py-1 text-[11px] font-bold text-black hover:bg-amber-400 disabled:opacity-60"
            >
              {sending ? <Loader2 size={12} className="animate-spin" /> : <Flag size={12} />}
              {sending ? '送出中…' : '送出（貼到 DC 討論串）'}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded border border-zinc-600 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800">
              取消
            </button>
            <span className="text-[10px] text-zinc-500">以「{name.trim() || '匿名'}」送出；DC 群組的人都看得到</span>
          </div>
        </div>
      )}
    </article>
  );
}
