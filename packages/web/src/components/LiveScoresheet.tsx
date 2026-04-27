import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Room, Player, VoteRecord, QuestRecord, LadyOfTheLakeRecord } from '@avalon/shared';
import {
  ShieldIcon,
  QuestSuccessMark,
  QuestFailMark,
} from './ScoresheetIcons';
import { displaySeatNumber, sortSeatsForDisplay } from '../utils/seatDisplay';

interface LiveScoresheetProps {
  room: Room;
  currentPlayer: Player;
}

/**
 * Row types for the scoresheet grid:
 * - nomination: team proposal + vote row
 * - quest: quest result row (yellow bg)
 * - lady: Lady of the Lake inspection row (cyan bg)
 */
type ScoresheetRow =
  | { type: 'nomination'; round: number; attempt: number; record: VoteRecord }
  | { type: 'quest'; round: number; record: QuestRecord }
  | { type: 'lady'; round: number; record: LadyOfTheLakeRecord };

/**
 * Shorthand memo for a nomination row — Google Sheet convention.
 *
 * Renders ONLY the team seats in canonical ascending order; the leader is
 * already shown in the L column on the same row, so prefixing it here is
 * redundant (Edward 2026-04-25).
 *
 * e.g. team [1, 3, 4] → "134"; team [4, 5, 6, 10] → "4560"
 * Uses 1-based seat numbers and renders seat 10 as "0" (paper convention).
 * Edward 2026-04-27: canonical seat sort centralised in `sortSeatsForDisplay`.
 */
function nominationShorthand(teamSeats: number[]): string {
  return sortSeatsForDisplay(teamSeats).map(displaySeatNumber).join('');
}

export default function LiveScoresheet({ room, currentPlayer }: LiveScoresheetProps): JSX.Element {
  const { t } = useTranslation(['game']);
  const playerIds = useMemo(() => Object.keys(room.players), [room.players]);
  const playerCount = playerIds.length;

  // Seat index lookup: playerId -> seat number (0-based internally)
  const seatMap = useMemo(() => {
    const map = new Map<string, number>();
    playerIds.forEach((id, i) => map.set(id, i));
    return map;
  }, [playerIds]);

  const getName = (id: string): string => room.players[id]?.name ?? id;

  // Build ordered rows from history: for each round, [noms...] [quest] [lady?]
  const rows = useMemo<ScoresheetRow[]>(() => {
    const result: ScoresheetRow[] = [];
    const { voteHistory, questHistory, ladyOfTheLakeHistory } = room;

    // Group votes by round
    const votesByRound = new Map<number, VoteRecord[]>();
    for (const v of voteHistory) {
      const list = votesByRound.get(v.round) ?? [];
      list.push(v);
      votesByRound.set(v.round, list);
    }

    const maxRound = Math.max(
      ...voteHistory.map(v => v.round),
      ...questHistory.map(q => q.round),
      ...(ladyOfTheLakeHistory ?? []).map(l => l.round),
      0,
    );

    for (let r = 1; r <= maxRound; r++) {
      const votes = (votesByRound.get(r) ?? []).sort((a, b) => a.attempt - b.attempt);
      for (const v of votes) {
        result.push({ type: 'nomination', round: r, attempt: v.attempt, record: v });
      }

      const quest = questHistory.find(q => q.round === r);
      if (quest) result.push({ type: 'quest', round: r, record: quest });

      const lady = (ladyOfTheLakeHistory ?? []).find(l => l.round === r);
      if (lady) result.push({ type: 'lady', round: r, record: lady });
    }

    return result;
  }, [room.voteHistory, room.questHistory, room.ladyOfTheLakeHistory]);

  // 1-based seat display numbers, with seat 10 rendered as "0" (paper convention)
  const seatDisplay = (i: number): string => displaySeatNumber(i + 1);

  return (
    <div className="w-full">
      {/*
        Mobile portrait must fit 10 players + 2 meta cols (L / M) = 12 cols at ~320-340px wide
        (R column dropped per Edward 2026-04-26 spec 14).
        We use tight cell widths + small font to achieve that without horizontal scroll.
        Desktop (sm+) relaxes cell sizes.
      */}
      <div className="w-full overflow-y-auto max-h-[65vh]">
        <table className="w-full text-[9px] sm:text-[11px] border-collapse table-fixed">
          <colgroup>
            {/* Leader col — slim on mobile */}
            <col className="w-[18px] sm:w-[28px]" />
            {/* Seat cols — even split for n players */}
            {playerIds.map((_id, i) => (
              <col key={`col-seat-${i}`} className="w-auto" />
            ))}
            {/* Memo col — slim on mobile, readable on desktop.
                2026-04-26 Edward spec 14: R column dropped — Y/N + count was
                redundant with M (memo) which already conveys round result via
                shorthand (oxx / 'Y 4/5' was double-bookkeeping). */}
            <col className="w-[34px] sm:w-[56px]" />
          </colgroup>

          {/*
            2026-04-26 Edward spec 15: sticky thead so column headers (seat
            numbers, L, M) stay pinned when the matrix scrolls vertically —
            the wrapper above sets `max-h-[65vh] overflow-y-auto` so long
            replays no longer lose context. `bg-avalon-dark` on every <th> so
            sticky headers don't appear transparent over scrolled rows.
          */}
          <thead className="sticky top-0 z-10 bg-avalon-dark">
            <tr className="border-b border-gray-700">
              {/* Leader column header */}
              <th
                scope="col"
                className="px-0.5 py-1 text-gray-500 font-semibold text-center bg-avalon-dark"
                title={t('game:scoresheet.leaderSeat')}
              >
                L
              </th>
              {/* Seat columns */}
              {playerIds.map((pid, i) => {
                const isMe = pid === currentPlayer.id;
                return (
                  <th
                    key={`head-${i}`}
                    scope="col"
                    className={`px-0 py-1 text-center font-semibold bg-avalon-dark ${
                      isMe ? 'text-yellow-400' : 'text-gray-500'
                    }`}
                    title={getName(pid)}
                  >
                    {seatDisplay(i)}
                  </th>
                );
              })}
              {/* Shorthand memo — left-aligned (Edward spec 16) */}
              <th
                scope="col"
                className="px-0.5 py-1 text-gray-500 font-semibold text-left bg-avalon-dark"
                title={t('game:scoresheet.memoTooltip')}
              >
                M
              </th>
            </tr>
          </thead>

          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={playerCount + 2}
                  className="text-center text-gray-600 py-6"
                >
                  --
                </td>
              </tr>
            )}

            {rows.map((row, idx) => {
              if (row.type === 'nomination') {
                return (
                  <NominationRow
                    key={`nom-${idx}`}
                    row={row}
                    playerIds={playerIds}
                    seatMap={seatMap}
                    currentPlayerId={currentPlayer.id}
                  />
                );
              }
              if (row.type === 'quest') {
                return (
                  <QuestRow
                    key={`quest-${idx}`}
                    row={row}
                    playerCount={playerCount}
                    questLabel={t('game:scoresheet.questLabel')}
                  />
                );
              }
              if (row.type === 'lady') {
                return (
                  <LadyRow
                    key={`lady-${idx}`}
                    row={row}
                    playerCount={playerCount}
                    seatMap={seatMap}
                    currentPlayerId={currentPlayer.id}
                    ladyColLabel={t('game:scoresheet.ladyLabel')}
                    ladyRowLabel={t('game:scoresheet.ladyRowLabel')}
                  />
                );
              }
              return null;
            })}
          </tbody>
        </table>
      </div>

      {/* Legend — i18n aware. 2026-04-26 Edward spec 17 update: approve / reject
          legend swatches now mirror the new "whole-cell background" treatment
          (flat white / flat black square, no inline glyph). */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3 text-[10px] sm:text-xs text-gray-400">
        <LegendItem>
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 text-yellow-400">
            <ShieldIcon className="w-3.5 h-3.5" />
          </span>
          {t('game:scoresheet.legendTeam')}
        </LegendItem>
        <LegendItem>
          <span className="inline-block w-3.5 h-3.5 bg-white border border-gray-500" />
          {t('game:scoresheet.legendApprove')}
        </LegendItem>
        <LegendItem>
          <span className="inline-block w-3.5 h-3.5 bg-black border border-gray-500" />
          {t('game:scoresheet.legendReject')}
        </LegendItem>
        <LegendItem>
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 text-blue-500">
            <QuestSuccessMark className="w-3 h-3" />
          </span>
          {t('game:scoresheet.legendQuestSuccess')}
        </LegendItem>
        <LegendItem>
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 text-red-500">
            <QuestFailMark className="w-3 h-3" />
          </span>
          {t('game:scoresheet.legendQuestFail')}
        </LegendItem>
        <LegendItem>
          <span className="inline-block w-3.5 h-3.5 rounded bg-cyan-600/50" />
          {t('game:scoresheet.legendLady')}
        </LegendItem>
      </div>
    </div>
  );
}

function LegendItem({ children }: { children: React.ReactNode }): JSX.Element {
  return <span className="inline-flex items-center gap-1">{children}</span>;
}

/* ---- Row sub-components ---- */

function NominationRow({
  row,
  playerIds,
  seatMap,
  currentPlayerId,
}: {
  row: Extract<ScoresheetRow, { type: 'nomination' }>;
  playerIds: string[];
  seatMap: Map<string, number>;
  currentPlayerId: string;
}): JSX.Element {
  const { record } = row;
  const leaderSeat = seatMap.get(record.leader) ?? -1;
  const teamSeatSet = new Set(record.team.map(id => seatMap.get(id) ?? -1));
  const teamSeats = record.team.map(id => seatMap.get(id) ?? -1);

  // 1-based display for shorthand (Google Sheet convention — team only, no leader prefix).
  // 2026-04-26 Edward spec 23: drop「Y/N」+「approve count」from M — vote
  // result is already obvious from the cell backgrounds (white = approve,
  // black = reject), and approve count is just a re-encoding of those cells.
  // M now carries only the team seat shorthand for nomination rows.
  const memoText = nominationShorthand(teamSeats.map(s => s + 1));

  return (
    <tr className="border-b border-gray-800/50">
      {/* Leader seat label — seat 10 renders as "0" (paper scoresheet convention) */}
      <td className="px-0 py-1 text-center text-yellow-400 font-bold bg-avalon-dark">
        {displaySeatNumber(leaderSeat + 1)}
      </td>

      {/*
        2026-04-26 Edward spec 17: cell background carries the vote (white =
        approve / black = reject) and fills the WHOLE cell. Shield (if on
        team) overlays at the top-right corner with `z-10` so the chosen
        marker is never obscured by the vote color. Previous design used a
        small centered overlay tile which left awkward gaps between cells
        and could obscure the shield. New layout reads cleanly as a row of
        coloured cells with a small yellow shield badge in the corner of any
        seat that was picked for the team.
      */}
      {playerIds.map((pid, i) => {
        const isOnTeam = teamSeatSet.has(i);
        const vote = record.votes[pid];
        const hasVoted = vote !== undefined;
        const isMe = pid === currentPlayerId;

        const bgClass = !hasVoted
          ? ''
          : vote
            ? 'bg-white'
            : 'bg-black';

        return (
          <td
            key={`nom-cell-${i}`}
            className={`relative p-0 align-middle ${bgClass} ${
              isMe ? 'ring-1 ring-inset ring-yellow-500/30' : ''
            }`}
          >
            <div className="relative w-full aspect-square">
              {/*
                Per Edward spec 17 the cell BACKGROUND alone signals the vote
                (white = approve, black = reject) — no inline glyph needed.
                Edward spec 22 (2026-04-26 19:25 reversal of spec 17): shield
                moves from top-right corner BACK to dead-centre overlay so the
                "this seat was picked" marker reads as the dominant glyph in
                the cell. Sized large (~70% of the square) and absolutely
                centred via `inset-0 + flex` for tight packing on mobile.
                z-10 keeps it above the vote-colour cell background so the
                gold/silver shield stays legible on either white or black.
              */}
              {isOnTeam && (
                <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
                  <ShieldIcon className="w-[70%] h-[70%] text-yellow-400 drop-shadow-[0_0_1px_rgba(0,0,0,0.85)]" />
                </div>
              )}
            </div>
          </td>
        );
      })}

      {/* Memo — left-aligned per Edward spec 16; embeds round result (spec 14). */}
      <td className="px-0.5 py-1 text-left text-gray-300 font-mono text-[9px] sm:text-[11px] whitespace-nowrap">
        {memoText}
      </td>
    </tr>
  );
}

function QuestRow({
  row,
  playerCount,
  questLabel,
}: {
  row: Extract<ScoresheetRow, { type: 'quest' }>;
  playerCount: number;
  questLabel: string;
}): JSX.Element {
  const { record, round } = row;
  const successCount = record.team.length - record.failCount;
  const symbols: Array<'o' | 'x'> = [
    ...Array(successCount).fill('o' as const),
    ...Array(record.failCount).fill('x' as const),
  ];

  // Shorthand string: oxx / ooo etc.
  // 2026-04-26 Edward spec 23: drop trailing「成」/「敗」verdict char from M —
  // 任務人數 + ooo/xx 已表達結果 (3 個 o = success, 含 x = fail), 加字重複.
  // 對齊「看投票結果就知道」精神 — M 只留 oxx 標記.
  const memoText = symbols.map(s => s).join('');

  return (
    <tr className="border-b border-yellow-900/50 bg-yellow-800/25">
      {/* Round label in leader col */}
      <td className="px-0 py-1 text-center text-yellow-200 font-bold bg-yellow-900/60">
        {round}
      </td>

      {/* Quest result spans all seat cols — quest label + oxx dots */}
      <td colSpan={playerCount} className="px-1 py-1">
        <div className="flex items-center justify-center gap-1 sm:gap-2 text-yellow-200">
          <span className="text-[9px] sm:text-[11px] font-bold tracking-wider">{questLabel}</span>
          <div className="flex items-center gap-[2px]">
            {symbols.map((sym, i) =>
              sym === 'o' ? (
                <QuestSuccessMark
                  key={i}
                  className="w-2 h-2 sm:w-2.5 sm:h-2.5 text-blue-500"
                />
              ) : (
                <QuestFailMark
                  key={i}
                  className="w-2 h-2 sm:w-2.5 sm:h-2.5 text-red-500"
                />
              ),
            )}
          </div>
        </div>
      </td>

      {/* Memo col — left-aligned per Edward spec 16; embeds verdict (spec 14). */}
      <td className="px-0.5 py-1 text-left text-yellow-100/80 font-mono text-[9px] sm:text-[11px] whitespace-nowrap">
        {memoText}
      </td>
    </tr>
  );
}

function LadyRow({
  row,
  playerCount,
  seatMap,
  currentPlayerId,
  ladyColLabel,
  ladyRowLabel,
}: {
  row: Extract<ScoresheetRow, { type: 'lady' }>;
  playerCount: number;
  seatMap: Map<string, number>;
  currentPlayerId: string;
  ladyColLabel: string;
  ladyRowLabel: string;
}): JSX.Element {
  const { record } = row;
  const holderSeat = (seatMap.get(record.holderId) ?? -1) + 1; // 1-based
  const targetSeat = (seatMap.get(record.targetId) ?? -1) + 1; // 1-based
  const isHolder = record.holderId === currentPlayerId;
  const resultKnown = record.result !== undefined && record.result !== null;

  /*
   * 2026-04-26 Edward spec 13 (regression fix): public Lake declarations
   * (`declared` + `declaredClaim`) must surface in the scoresheet for ALL
   * viewers, not just the holder — same convention as ChatPanel's "湖 H>T o"
   * system entry. Previously the row only consulted `record.result`, which
   * the server masks for non-holders, so a publicly-declared inspection
   * (e.g. holder seat 0 inspected seat 4 and announced 'good') still showed
   * up as "?" for everyone except the holder. Display priority:
   *   1. holder → real `result` (always known)
   *   2. anyone else, claim made → `declaredClaim` ('o' / 'x')
   *   3. otherwise → '?'
   */
  const declaredChar: string | null = record.declared && record.declaredClaim
    ? record.declaredClaim === 'good' ? 'o' : 'x'
    : null;

  const holderResultChar: string = resultKnown
    ? record.result === 'good' ? 'o' : 'x'
    : '?';

  const visibleChar: string = isHolder
    ? holderResultChar
    : declaredChar ?? '?';

  const memo = `${displaySeatNumber(holderSeat)}>${displaySeatNumber(targetSeat)}${visibleChar}`;

  return (
    <tr className="border-b border-cyan-900/50 bg-cyan-800/25">
      {/* Lady label in leader col */}
      <td className="px-0 py-1 text-center text-cyan-200 font-bold bg-cyan-900/60 text-[9px] sm:text-[11px]">
        {ladyColLabel}
      </td>

      {/* Center — holder>target arrow + result (if visible to viewer) */}
      <td colSpan={playerCount} className="px-1 py-1">
        <div className="flex items-center justify-center gap-1 sm:gap-2 text-cyan-100">
          <span className="text-[9px] sm:text-[11px] font-bold tracking-wider">{ladyRowLabel}</span>
          <span className="font-mono text-[10px] sm:text-xs">
            {displaySeatNumber(holderSeat)}&gt;{displaySeatNumber(targetSeat)}
          </span>
          {visibleChar !== '?' ? (
            <span
              className={`font-bold text-[10px] sm:text-xs ${
                visibleChar === 'o' ? 'text-blue-200' : 'text-red-300'
              }`}
            >
              {visibleChar}
            </span>
          ) : (
            <span className="text-gray-400 text-[10px] sm:text-xs">?</span>
          )}
        </div>
      </td>

      {/* Memo col — left-aligned per Edward spec 16; carries declaration char (spec 13). */}
      <td className="px-0.5 py-1 text-left text-cyan-100/80 font-mono text-[9px] sm:text-[11px] whitespace-nowrap">
        {memo}
      </td>
    </tr>
  );
}
