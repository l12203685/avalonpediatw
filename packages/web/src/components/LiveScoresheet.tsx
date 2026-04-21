import { useMemo } from 'react';
import { Room, Player, VoteRecord, QuestRecord, LadyOfTheLakeRecord } from '@avalon/shared';
import {
  ShieldIcon,
  ApproveMark,
  RejectMark,
  QuestSuccessMark,
  QuestFailMark,
} from './ScoresheetIcons';

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
 * Shorthand memo for a nomination row.
 * e.g. "169" = leader 1, team members 6 and 9 (1-based display).
 * Uses 1-based seat numbers to match the paper scoresheet convention.
 */
function nominationShorthand(leaderSeat: number, teamSeats: number[]): string {
  return `${leaderSeat}${[...teamSeats].sort((a, b) => a - b).join('')}`;
}

export default function LiveScoresheet({ room, currentPlayer }: LiveScoresheetProps): JSX.Element {
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

  // 1-based seat display numbers (paper scoresheet convention)
  const seatDisplay = (i: number): number => i + 1;

  return (
    <div className="w-full">
      {/*
        Mobile portrait must fit 10 players + 3 meta cols (L / R / memo) = 13 cols at ~320-340px wide.
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
            {/* Result col */}
            <col className="w-[22px] sm:w-[34px]" />
            {/* Memo col — slim on mobile, readable on desktop */}
            <col className="w-[34px] sm:w-[56px]" />
          </colgroup>

          <thead>
            <tr className="border-b border-gray-700">
              {/* Leader column header */}
              <th
                scope="col"
                className="px-0.5 py-1 text-gray-500 font-semibold text-center bg-avalon-dark"
                title="隊長座位 (Leader seat)"
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
                    className={`px-0 py-1 text-center font-semibold ${
                      isMe ? 'text-yellow-400' : 'text-gray-500'
                    }`}
                    title={getName(pid)}
                  >
                    {seatDisplay(i)}
                  </th>
                );
              })}
              {/* Result column */}
              <th
                scope="col"
                className="px-0.5 py-1 text-gray-500 font-semibold text-center"
                title="結果 (Result)"
              >
                R
              </th>
              {/* Shorthand memo */}
              <th
                scope="col"
                className="px-0.5 py-1 text-gray-500 font-semibold text-center"
                title="簡碼 (Memo)"
              >
                備
              </th>
            </tr>
          </thead>

          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={playerCount + 3}
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
                  />
                );
              }
              return null;
            })}
          </tbody>
        </table>
      </div>

      {/* Legend — 中文 (2026-04-21 recolor: 黃盾/白勾/黑方/藍圓/紅圓) */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3 text-[10px] sm:text-xs text-gray-400">
        <LegendItem>
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 text-yellow-400">
            <ShieldIcon className="w-3.5 h-3.5" />
          </span>
          組隊
        </LegendItem>
        <LegendItem>
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded bg-yellow-500/40 text-white">
            <ApproveMark className="w-3 h-3" />
          </span>
          同意
        </LegendItem>
        <LegendItem>
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 text-black">
            <RejectMark className="w-3.5 h-3.5" />
          </span>
          否決
        </LegendItem>
        <LegendItem>
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 text-blue-500">
            <QuestSuccessMark className="w-3 h-3" />
          </span>
          任務成功
        </LegendItem>
        <LegendItem>
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 text-red-500">
            <QuestFailMark className="w-3 h-3" />
          </span>
          任務失敗
        </LegendItem>
        <LegendItem>
          <span className="inline-block w-3.5 h-3.5 rounded bg-cyan-600/50" />
          湖中女神
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
  const approveCount = Object.values(record.votes).filter(Boolean).length;
  const totalVotes = Object.values(record.votes).length;

  // 1-based display for shorthand (matches paper scoresheet "169" convention)
  const shorthand = nominationShorthand(
    leaderSeat + 1,
    teamSeats.map(s => s + 1),
  );

  return (
    <tr className={`border-b border-gray-800/50 ${record.approved ? '' : 'opacity-80'}`}>
      {/* Leader seat label */}
      <td className="px-0 py-1 text-center text-yellow-400 font-bold bg-avalon-dark">
        {leaderSeat + 1}
      </td>

      {/* Seat cells — each cell = shield (if on team) + overlay (approve white / reject black) */}
      {playerIds.map((pid, i) => {
        const isOnTeam = teamSeatSet.has(i);
        const vote = record.votes[pid];
        const hasVoted = vote !== undefined;
        const isMe = pid === currentPlayerId;

        return (
          <td
            key={`nom-cell-${i}`}
            className={`relative p-0 align-middle ${
              isMe ? 'ring-1 ring-inset ring-yellow-500/30' : ''
            }`}
          >
            {/*
              Cell layout: square aspect — shield fills cell when on team,
              overlay (approve white / reject black) stacks on top of shield.
            */}
            <div className="relative w-full aspect-square flex items-center justify-center">
              {isOnTeam && (
                <ShieldIcon className="absolute inset-0 w-full h-full text-yellow-400" />
              )}
              {hasVoted && vote && (
                // Approve: white checkmark overlay
                <ApproveMark className="relative w-[75%] h-[75%] text-white drop-shadow-[0_0_1px_rgba(0,0,0,0.6)]" />
              )}
              {hasVoted && !vote && (
                // Reject: black square overlay (covers shield entirely)
                <RejectMark className="absolute inset-[10%] w-[80%] h-[80%] text-black" />
              )}
            </div>
          </td>
        );
      })}

      {/* Result cell — Y/N + vote count */}
      <td
        className={`px-0.5 py-1 text-center font-bold leading-tight ${
          record.approved ? 'text-blue-300' : 'text-gray-300'
        }`}
      >
        <div className="text-[10px] sm:text-xs">{record.approved ? 'Y' : 'N'}</div>
        <div className="text-gray-500 text-[8px] sm:text-[10px]">
          {approveCount}/{totalVotes}
        </div>
      </td>

      {/* Memo (shorthand) */}
      <td className="px-0.5 py-1 text-center text-gray-300 font-mono text-[9px] sm:text-[11px]">
        {shorthand}
      </td>
    </tr>
  );
}

function QuestRow({
  row,
  playerCount,
}: {
  row: Extract<ScoresheetRow, { type: 'quest' }>;
  playerCount: number;
}): JSX.Element {
  const { record, round } = row;
  const successCount = record.team.length - record.failCount;
  const symbols: Array<'o' | 'x'> = [
    ...Array(successCount).fill('o' as const),
    ...Array(record.failCount).fill('x' as const),
  ];

  // Shorthand string: oxx / ooo etc
  const shorthandStr = symbols.map(s => s).join('');

  return (
    <tr className="border-b border-yellow-900/50 bg-yellow-800/25">
      {/* Round label in leader col */}
      <td className="px-0 py-1 text-center text-yellow-200 font-bold bg-yellow-900/60">
        {round}
      </td>

      {/* Quest result spans all seat cols — "任務" label + oxx dots */}
      <td colSpan={playerCount} className="px-1 py-1">
        <div className="flex items-center justify-center gap-1 sm:gap-2 text-yellow-200">
          <span className="text-[9px] sm:text-[11px] font-bold tracking-wider">任務</span>
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

      {/* Result col — success/fail letter */}
      <td
        className={`px-0.5 py-1 text-center font-bold ${
          record.result === 'success' ? 'text-blue-300' : 'text-red-300'
        }`}
      >
        <div className="text-[10px] sm:text-xs">{record.result === 'success' ? '成' : '敗'}</div>
      </td>

      {/* Memo col — oxx shorthand */}
      <td className="px-0.5 py-1 text-center text-yellow-100/80 font-mono text-[9px] sm:text-[11px]">
        {shorthandStr}
      </td>
    </tr>
  );
}

function LadyRow({
  row,
  playerCount,
  seatMap,
  currentPlayerId,
}: {
  row: Extract<ScoresheetRow, { type: 'lady' }>;
  playerCount: number;
  seatMap: Map<string, number>;
  currentPlayerId: string;
}): JSX.Element {
  const { record } = row;
  const holderSeat = (seatMap.get(record.holderId) ?? -1) + 1; // 1-based
  const targetSeat = (seatMap.get(record.targetId) ?? -1) + 1; // 1-based
  const isHolder = record.holderId === currentPlayerId;
  const resultKnown = record.result !== undefined && record.result !== null;

  // Holder-only can see good/evil; others see '?'
  const resultChar: string = resultKnown
    ? record.result === 'good'
      ? 'o'
      : 'x'
    : '?';

  const memo = `${holderSeat}>${targetSeat}${isHolder ? resultChar : '?'}`;

  return (
    <tr className="border-b border-cyan-900/50 bg-cyan-800/25">
      {/* Lady label in leader col */}
      <td className="px-0 py-1 text-center text-cyan-200 font-bold bg-cyan-900/60 text-[9px] sm:text-[11px]">
        湖
      </td>

      {/* Center — holder>target arrow + result (if visible) */}
      <td colSpan={playerCount} className="px-1 py-1">
        <div className="flex items-center justify-center gap-1 sm:gap-2 text-cyan-100">
          <span className="text-[9px] sm:text-[11px] font-bold tracking-wider">湖中</span>
          <span className="font-mono text-[10px] sm:text-xs">
            {holderSeat}&gt;{targetSeat}
          </span>
          {isHolder && resultKnown ? (
            <span
              className={`font-bold text-[10px] sm:text-xs ${
                record.result === 'good' ? 'text-blue-200' : 'text-red-300'
              }`}
            >
              {record.result === 'good' ? 'o' : 'x'}
            </span>
          ) : (
            <span className="text-gray-400 text-[10px] sm:text-xs">?</span>
          )}
        </div>
      </td>

      {/* Result col */}
      <td className="px-0.5 py-1 text-center text-cyan-200 font-bold text-[10px] sm:text-xs">
        {isHolder ? resultChar : '?'}
      </td>

      {/* Memo col */}
      <td className="px-0.5 py-1 text-center text-cyan-100/80 font-mono text-[9px] sm:text-[11px]">
        {memo}
      </td>
    </tr>
  );
}
