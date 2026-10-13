/**
 * 網站「與機器人練習」— post-game review: every role revealed, every bot
 * decision grouped by round with its reason, filters by bot / decision type,
 * and a 「這步怪怪的」 report button on each decision.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Flag, Check, ChevronDown, ChevronUp, Loader2, RotateCcw } from 'lucide-react';
import '../../i18n/practice';
import { PRACTICE_NS } from '../../i18n/practice';
import { usePracticeStore } from '../../store/practiceStore';
import {
  fetchPracticeTrace,
  flagPracticeDecision,
  type PracticeDecisionKind,
  type PracticeSeatInfo,
  type PracticeTraceEntry,
  type PracticeTracePayload,
} from '../../services/practice';

interface Props {
  roomId: string;
  currentPlayerId: string;
}

const KINDS: PracticeDecisionKind[] = ['team_propose', 'team_vote', 'quest_card', 'lake_target', 'lake_declare', 'assassinate'];

function seatText(seat: number): string {
  return `${seat === 10 ? '0' : String(seat)}家`;
}

function teamTone(team: 'good' | 'evil' | null | undefined): string {
  if (team === 'good') return 'border-sky-600/70 bg-sky-950/50 text-sky-100';
  if (team === 'evil') return 'border-rose-600/70 bg-rose-950/50 text-rose-100';
  return 'border-zinc-700 bg-zinc-900 text-zinc-200';
}

interface Block {
  key: string;
  title: string;
  entries: PracticeTraceEntry[];
  /** Vote blocks collapse into a summary while no bot filter is active. */
  isVotes: boolean;
}

interface Section {
  key: string;
  title: string;
  blocks: Block[];
}

export default function PracticeReviewPanel({ roomId, currentPlayerId }: Props): JSX.Element {
  const { t } = useTranslation(PRACTICE_NS);
  const trace = usePracticeStore((s) => s.traces[roomId]);
  const setTrace = usePracticeStore((s) => s.setTrace);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [botSeat, setBotSeat] = useState<number | null>(null);
  const [kind, setKind] = useState<PracticeDecisionKind | null>(null);
  const [openVotes, setOpenVotes] = useState<Record<string, boolean>>({});

  const load = (): void => {
    setLoadError(null);
    fetchPracticeTrace(roomId)
      .then((payload) => setTrace(payload))
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)));
  };

  // The trace is pushed at game end; pull it if the push was missed.
  useEffect(() => {
    if (trace) return;
    const id = window.setTimeout(() => { if (!usePracticeStore.getState().traces[roomId]) load(); }, 800);
    return (): void => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, trace]);

  if (!trace) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 text-sm text-zinc-300">
        {loadError ? (
          <>
            <p className="text-rose-300">{t('loadFailed', { error: loadError })}</p>
            <button type="button" onClick={load} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-zinc-600 hover:bg-zinc-800">
              <RotateCcw size={14} /> {t('retry')}
            </button>
          </>
        ) : (
          <p className="inline-flex items-center gap-2"><Loader2 size={16} className="animate-spin" />{t('loading')}</p>
        )}
      </div>
    );
  }

  return (
    <ReviewBody
      trace={trace}
      currentPlayerId={currentPlayerId}
      botSeat={botSeat}
      setBotSeat={setBotSeat}
      kind={kind}
      setKind={setKind}
      openVotes={openVotes}
      setOpenVotes={setOpenVotes}
    />
  );
}

interface BodyProps {
  trace: PracticeTracePayload;
  currentPlayerId: string;
  botSeat: number | null;
  setBotSeat: (s: number | null) => void;
  kind: PracticeDecisionKind | null;
  setKind: (k: PracticeDecisionKind | null) => void;
  openVotes: Record<string, boolean>;
  setOpenVotes: (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
}

function ReviewBody({ trace, currentPlayerId, botSeat, setBotSeat, kind, setKind, openVotes, setOpenVotes }: BodyProps): JSX.Element {
  const { t } = useTranslation(PRACTICE_NS);
  const seatsBySeat = useMemo(() => new Map(trace.seats.map((s) => [s.seat, s])), [trace.seats]);
  const bots = trace.seats.filter((s) => s.isBot);

  const filtered = useMemo(
    () => trace.entries.filter((e) => (botSeat === null || e.botSeat === botSeat) && (kind === null || e.kind === kind)),
    [trace.entries, botSeat, kind],
  );

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    const sectionOf = (key: string, title: string): Section => {
      let s = out.find((x) => x.key === key);
      if (!s) { s = { key, title, blocks: [] }; out.push(s); }
      return s;
    };
    const blockOf = (section: Section, key: string, title: string, isVotes: boolean): Block => {
      let b = section.blocks.find((x) => x.key === key);
      if (!b) { b = { key, title, entries: [], isVotes }; section.blocks.push(b); }
      return b;
    };
    for (const e of filtered) {
      if (e.kind === 'assassinate') {
        blockOf(sectionOf('assassin', t('assassination')), 'kill', t('assassination'), false).entries.push(e);
        continue;
      }
      const section = sectionOf(`r${e.round}`, t('round', { round: e.round }));
      if (e.kind === 'team_propose') blockOf(section, `a${e.attempt}`, t('attempt', { attempt: e.attempt }), false).entries.push(e);
      else if (e.kind === 'team_vote') blockOf(section, `a${e.attempt}-votes`, t('attempt', { attempt: e.attempt }), true).entries.push(e);
      else if (e.kind === 'quest_card') blockOf(section, 'quest', t('questCards'), false).entries.push(e);
      else blockOf(section, 'lake', t('lake'), false).entries.push(e);
    }
    return out;
  }, [filtered, t]);

  const me = trace.seats.find((s) => s.playerId === currentPlayerId);
  const winnerText = trace.winner === 'good' ? t('winnerGood') : trace.winner === 'evil' ? t('winnerEvil') : '';
  const reasonText = trace.endReason ? t(`endReason.${trace.endReason}`, { defaultValue: '' }) : '';

  return (
    <div data-testid="practice-review" className="space-y-3 pb-6 text-left">
      {/* Result + revealed roles */}
      <div className="rounded-lg border border-zinc-700 bg-zinc-900/80 p-3 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base sm:text-lg font-bold text-white">{t('reviewTitle')}</h2>
          <span className={`text-sm font-semibold ${trace.winner === 'evil' ? 'text-rose-300' : 'text-sky-300'}`}>
            {winnerText}{reasonText ? `（${reasonText}）` : ''}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {trace.seats.map((s) => (
            <SeatChip key={s.seat} seat={s} isMe={s.playerId === currentPlayerId} />
          ))}
        </div>
        <p className="text-[11px] text-zinc-400">
          {t('decisions', { count: trace.entries.length })}
          {me ? ` · ${t('you')}：${seatText(me.seat)} ${me.role ? t(`role.${me.role}`) : ''}` : ''}
          {trace.canFlag ? ` · ${t('flagsLeft', { count: trace.flagsLeft })}` : ''}
        </p>
        {!trace.canFlag && trace.flagUnavailableReason && (
          <p className="text-[11px] text-amber-300/90">{trace.flagUnavailableReason}</p>
        )}
      </div>

      {/* Filters */}
      <div className="space-y-1.5">
        <div className="flex gap-1.5 overflow-x-auto pb-1" aria-label={t('filterBots')}>
          <FilterChip active={botSeat === null} onClick={() => setBotSeat(null)}>{t('filterAll')}</FilterChip>
          {bots.map((s) => (
            <FilterChip key={s.seat} active={botSeat === s.seat} onClick={() => setBotSeat(botSeat === s.seat ? null : s.seat)} team={s.team}>
              {seatText(s.seat)} {s.role ? t(`role.${s.role}`) : ''}
            </FilterChip>
          ))}
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1" aria-label={t('filterKinds')}>
          <FilterChip active={kind === null} onClick={() => setKind(null)}>{t('filterAll')}</FilterChip>
          {KINDS.map((k) => (
            <FilterChip key={k} active={kind === k} onClick={() => setKind(kind === k ? null : k)}>{t(`kind.${k}`)}</FilterChip>
          ))}
        </div>
      </div>

      {sections.length === 0 && <p className="text-sm text-zinc-400 py-6 text-center">{t('empty')}</p>}

      {sections.map((section) => (
        <section key={section.key} className="space-y-2">
          <h3 className="sticky top-0 z-10 bg-black/90 py-1 text-sm font-bold text-amber-200 border-b border-zinc-800">{section.title}</h3>
          {section.blocks.map((block) => {
            const blockKey = `${section.key}-${block.key}`;
            const collapsed = block.isVotes && botSeat === null && !openVotes[blockKey];
            const yes = block.entries.filter((e) => e.detail.vote === true).map((e) => e.botSeat);
            const no = block.entries.filter((e) => e.detail.vote === false).map((e) => e.botSeat);
            return (
              <div key={blockKey} className="space-y-1.5">
                {block.isVotes ? (
                  <button
                    type="button"
                    onClick={() => setOpenVotes((prev) => ({ ...prev, [blockKey]: !prev[blockKey] }))}
                    className="w-full flex items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800/60"
                  >
                    <span>
                      <span className="font-semibold text-zinc-200">{block.title}</span>{' · '}
                      {t('votesSummary', {
                        yes: yes.length ? yes.sort((a, b) => a - b).map(seatText).join('、') : '—',
                        no: no.length ? no.sort((a, b) => a - b).map(seatText).join('、') : '—',
                      })}
                    </span>
                    {botSeat === null && (collapsed
                      ? <span className="inline-flex items-center gap-0.5 shrink-0 text-zinc-400">{t('showVotes')}<ChevronDown size={14} /></span>
                      : <span className="inline-flex items-center gap-0.5 shrink-0 text-zinc-400">{t('hideVotes')}<ChevronUp size={14} /></span>)}
                  </button>
                ) : (
                  <p className="text-[11px] font-semibold text-zinc-400">{block.title}</p>
                )}
                {!collapsed && block.entries.map((e) => (
                  <EntryCard key={e.id} entry={e} trace={trace} seat={seatsBySeat.get(e.botSeat)} />
                ))}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function SeatChip({ seat, isMe }: { seat: PracticeSeatInfo; isMe: boolean }): JSX.Element {
  const { t } = useTranslation(PRACTICE_NS);
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${teamTone(seat.team)} ${isMe ? 'ring-2 ring-amber-400' : ''}`}>
      <span className="font-mono font-bold">{seat.seat === 10 ? '0' : seat.seat}</span>
      <span>{seat.role ? t(`role.${seat.role}`) : '?'}</span>
      {isMe && <span className="font-semibold text-amber-300">{t('you')}</span>}
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

function EntryCard({ entry, trace, seat }: { entry: PracticeTraceEntry; trace: PracticeTracePayload; seat?: PracticeSeatInfo }): JSX.Element {
  const { t } = useTranslation(PRACTICE_NS);
  const flagged = usePracticeStore((s) => Boolean(s.flagged[`${trace.roomId}:${entry.id}`]));
  const markFlagged = usePracticeStore((s) => s.markFlagged);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const send = async (): Promise<void> => {
    if (sending) return;
    setSending(true);
    setMessage(null);
    try {
      const res = await flagPracticeDecision(trace.roomId, entry.id, note.trim());
      if (res.ok) {
        markFlagged(trace.roomId, entry.id, res.flagsLeft);
        setMessage({ ok: true, text: t('flagOk') });
        setOpen(false);
      } else {
        setMessage({ ok: false, text: t('flagFailed', { error: res.error ?? '' }) });
      }
    } catch (err) {
      setMessage({ ok: false, text: t('flagFailed', { error: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setSending(false);
    }
  };

  return (
    <article data-testid="practice-entry" className={`rounded-md border px-2.5 py-2 space-y-1 ${teamTone(entry.botTeam)}`}>
      <header className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="rounded bg-black/40 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-200">{t(`kind.${entry.kind}`)}</span>
        <span className="font-bold">{seatText(entry.botSeat)} {t(`role.${seat?.role ?? entry.botRole}`)}</span>
        <span className="text-white font-semibold">→ {entry.action}</span>
        {entry.source === 'fallback' && (
          <span className="rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] text-amber-200">{t('fallback')}</span>
        )}
      </header>
      <p className="text-[12px] leading-relaxed text-zinc-100">{entry.reason}</p>
      <div className="space-y-0.5 text-[11px] leading-relaxed text-zinc-300/90">
        {entry.rule && <p><span className="text-zinc-400">{t('rule')}：</span>{entry.rule}</p>}
        {entry.knowledge && <p><span className="text-zinc-400">{t('knowledge')}：</span>{entry.knowledge}</p>}
        {entry.suspects && entry.suspects.length > 0 ? (
          <p>
            <span className="text-zinc-400">{entry.suspectsLabel ?? ''}：</span>
            {entry.suspects.map((s) => `${seatText(s.seat)} ${s.score.toFixed(2)}`).join('、')}
            {entry.suspectsNote && <span className="text-zinc-400">（{entry.suspectsNote}）</span>}
          </p>
        ) : entry.suspectsNote ? (
          <p><span className="text-zinc-400">{entry.suspectsLabel ?? ''}：</span>{entry.suspectsNote}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {flagged ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300"><Check size={12} />{t('flagged')}</span>
        ) : (
          <button
            type="button"
            onClick={() => { setOpen((v) => !v); setMessage(null); }}
            data-testid="practice-flag-button"
            className="inline-flex items-center gap-1 rounded border border-amber-600/70 bg-amber-950/40 px-2 py-0.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-900/50"
          >
            <Flag size={12} />{t('flag')}
          </button>
        )}
        {message && <span className={`text-[11px] ${message.ok ? 'text-emerald-300' : 'text-rose-300'}`}>{message.text}</span>}
      </div>
      {open && !flagged && (
        trace.canFlag ? (
          <div className="space-y-1.5 pt-1">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 500))}
              maxLength={500}
              rows={2}
              placeholder={t('flagNotePlaceholder')}
              className="w-full rounded border border-zinc-700 bg-black/70 px-2 py-1 text-[12px] text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-400"
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={sending}
                onClick={() => { void send(); }}
                className="inline-flex items-center gap-1 rounded bg-amber-500 px-2.5 py-1 text-[11px] font-bold text-black hover:bg-amber-400 disabled:opacity-60"
              >
                {sending ? <Loader2 size={12} className="animate-spin" /> : <Flag size={12} />}
                {sending ? t('flagSending') : t('flagSend')}
              </button>
              <button type="button" onClick={() => setOpen(false)} className="rounded border border-zinc-600 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800">
                {t('flagCancel')}
              </button>
            </div>
          </div>
        ) : (
          <p className="pt-1 text-[11px] text-amber-300/90">{trace.flagUnavailableReason ?? t('flagUnavailable')}</p>
        )
      )}
    </article>
  );
}
