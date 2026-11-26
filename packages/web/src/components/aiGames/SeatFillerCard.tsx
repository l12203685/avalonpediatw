import { useState, type FormEvent } from 'react';
import { CheckCircle2, AlertTriangle, Loader2, UserPlus } from 'lucide-react';
import { PLAY_PLATFORM_URL } from '@avalon/shared';
import { requestSeatFiller } from '../../services/seatFiller';
import { SEAT_FILLER_BOT_OPTIONS, SEAT_FILLER_LIMITS_LINE, type SeatFillerReply } from '../../utils/seatFiller';

/**
 * 「叫百科AI 補位」（站長 2026-11-19：「如果想補百科AI 只能從 line/dc 補嗎? 有沒有辦法讓不在群組內的人補」）。
 * 放在「百科AI 對局」頁最上面（#ai-games，也接受 #seat-filler）；跟 LINE /補位、DC /機器人補位 同一個補位機器人、同一份限制。
 */
export default function SeatFillerCard(): JSX.Element {
  const [room, setRoom] = useState('');
  const [bots, setBots] = useState('1');
  const [password, setPassword] = useState('');
  const [sending, setSending] = useState(false);
  const [reply, setReply] = useState<SeatFillerReply | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (sending) return;
    if (!room.trim()) {
      setReply({ ok: false, text: '請填房號或房間描述。' });
      return;
    }
    setSending(true);
    setReply(null);
    const r = await requestSeatFiller({ room, bots, password });
    setReply(r);
    setSending(false);
  };

  const field = 'w-full rounded-lg border border-zinc-700 bg-black/70 px-2.5 py-1.5 text-sm text-white placeholder-zinc-500 focus:border-zinc-400 focus:outline-none';

  return (
    <section id="seat-filler" data-testid="seat-filler-card" className="space-y-2 rounded-lg border border-amber-400/30 bg-zinc-900/80 p-3">
      <h2 className="flex items-center gap-2 text-sm font-bold text-amber-200"><UserPlus size={16} />叫AI騎士 補位</h2>
      <p className="text-xs leading-relaxed text-zinc-300">
        在
        <a href={PLAY_PLATFORM_URL} target="_blank" rel="noopener noreferrer" className="mx-1 text-emerald-300 underline underline-offset-2">signage-cloud</a>
        開了房但缺人？不用進 LINE／DC 群組，在這裡叫AI騎士 進房，約 1–2 分鐘後坐下。局數不限，要它走就在房內聊天室打「離開」。
      </p>
      <form onSubmit={(e) => { void submit(e); }} className="space-y-2">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_6.5rem_8rem]">
          <label className="block space-y-1 text-[11px] text-zinc-400">
            <span>房號或房間描述</span>
            <input
              data-testid="seat-filler-room"
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              maxLength={40}
              placeholder="1460 或 房間描述裡的一段字"
              className={field}
            />
          </label>
          <label className="block space-y-1 text-[11px] text-zinc-400">
            <span>人數</span>
            <select data-testid="seat-filler-bots" value={bots} onChange={(e) => setBots(e.target.value)} className={field}>
              {SEAT_FILLER_BOT_OPTIONS.map((o) => (
                <option key={o} value={o}>{o === '補滿' ? '補滿（到 10 人）' : `${o} 個`}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-[11px] text-zinc-400">
            <span>密碼（私房才填）</span>
            <input
              data-testid="seat-filler-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={32}
              autoComplete="off"
              placeholder="選填"
              className={field}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            data-testid="seat-filler-submit"
            disabled={sending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-black transition-colors hover:bg-zinc-200 disabled:opacity-60"
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
            {sending ? '送出中…' : '叫AI騎士'}
          </button>
          <span className="text-[11px] text-zinc-500">{SEAT_FILLER_LIMITS_LINE}</span>
        </div>
      </form>
      {reply && (
        <p
          data-testid="seat-filler-reply"
          role="status"
          className={`flex items-start gap-1.5 text-xs leading-relaxed ${reply.ok ? 'text-emerald-300' : 'text-rose-300'}`}
        >
          {reply.ok ? <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" /> : <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />}
          <span>{reply.text}</span>
        </p>
      )}
    </section>
  );
}
