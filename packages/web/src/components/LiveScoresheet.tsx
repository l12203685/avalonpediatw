import { useMemo } from 'react';
import { Room, Player, VoteRecord, QuestRecord, LadyOfTheLakeRecord } from '@avalon/shared';

interface LiveScoresheetProps {
  room: Room;
  currentPlayer: Player;
}

/**
 * Row types for the scoresheet grid:
 * - nomination: a team proposal vote row
 * - quest: quest result row (yellow bg)
 * - lady: Lady of the Lake inspection row (blue bg)
 */
type ScoresheetRow =
  | { type: 'nomination'; round: number; attempt: number; record: VoteRecord }
  | { type: 'quest'; round: number; record: QuestRecord }
  | { type: 'lady'; round: number; record: LadyOfTheLakeRecord };

/** Build a shorthand notation string for a nomination row, e.g. "170" */
function nominationShorthand(
  leaderSeat: number,
  teamSeats: number[],
): string {
  return `${leaderSeat}${teamSeats.sort((a, b) => a - b).join('')}`;
}

export default function LiveScoresheet({ room, currentPlayer }: LiveScoresheetProps): JSX.Element {
  const playerIds = useMemo(() => Object.keys(room.players), [room.players]);
  const playerCount = playerIds.length;

  // Seat index lookup: playerId -> seat number (0-based)
  const seatMap = useMemo(() => {
    const map = new Map<string, number>();
    playerIds.forEach((id, i) => map.set(id, i));
    return map;
  }, [playerIds]);

  const getName = (id: string): string => room.players[id]?.name ?? id;

  // Build ordered rows from history
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

    // Determine how many rounds we have data for
    const maxRound = Math.max(
      ...voteHistory.map(v => v.round),
      ...questHistory.map(q => q.round),
      ...(ladyOfTheLakeHistory ?? []).map(l => l.round),
      0,
    );

    for (let r = 1; r <= maxRound; r++) {
      // Nomination rows for this round
      const votes = votesByRound.get(r) ?? [];
      for (const v of votes) {
        result.push({ type: 'nomination', round: r, attempt: v.attempt, record: v });
      }

      // Quest result row
      const quest = questHistory.find(q => q.round === r);
      if (quest) {
        result.push({ type: 'quest', round: r, record: quest });
      }

      // Lady of the Lake row (happens after quest)
      const lady = (ladyOfTheLakeHistory ?? []).find(l => l.round === r);
      if (lady) {
        result.push({ type: 'lady', round: r, record: lady });
      }
    }

    // If current round has no history yet but game is active, show nothing extra
    return result;
  }, [room.voteHistory, room.questHistory, room.ladyOfTheLakeHistory]);

  // Seat header labels: just the seat numbers
  const seatHeaders = playerIds.map((_id, i) => i);

  return (
    <div className="overflow-x-auto -mx-4 px-4">
      <table className="w-full text-xs border-collapse min-w-[320px]">
        <thead>
          <tr className="border-b border-gray-700">
            {/* Leader column */}
            <th className="px-1.5 py-2 text-gray-500 font-semibold text-left sticky left-0 bg-avalon-dark z-10 w-8">
              L
            </th>
            {/* Seat columns */}
            {seatHeaders.map((seat, i) => {
              const pid = playerIds[i];
              const isMe = pid === currentPlayer.id;
              return (
                <th
                  key={seat}
                  className={`px-1 py-2 text-center font-semibold w-7 ${
                    isMe ? 'text-yellow-400' : 'text-gray-500'
                  }`}
                  title={getName(pid)}
                >
                  {seat}
                </th>
              );
            })}
            {/* Result column */}
            <th className="px-1.5 py-2 text-gray-500 font-semibold text-center w-8">R</th>
            {/* Shorthand column */}
            <th className="px-1.5 py-2 text-gray-500 font-semibold text-left">memo</th>
          </tr>
          {/* Player names sub-header */}
          <tr className="border-b border-gray-700/50">
            <td className="sticky left-0 bg-avalon-dark z-10"></td>
            {playerIds.map((pid, i) => {
              const isMe = pid === currentPlayer.id;
              const name = getName(pid);
              return (
                <td
                  key={i}
                  className={`px-0.5 py-1 text-center truncate max-w-[28px] ${
                    isMe ? 'text-yellow-300 font-bold' : 'text-gray-600'
                  }`}
                  title={name}
                >
                  {name.slice(0, 2)}
                </td>
              );
            })}
            <td></td>
            <td></td>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={playerCount + 3} className="text-center text-gray-600 py-4">
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
                  getName={getName}
                  currentPlayerId={currentPlayer.id}
                />
              );
            }
            return null;
          })}
        </tbody>
      </table>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-3 text-[10px] text-gray-600">
        <span><span className="inline-block w-3 h-3 rounded bg-blue-600/40 align-middle mr-1"></span>team</span>
        <span><span className="inline-block w-3 h-3 rounded bg-green-700/60 align-middle mr-1"></span>approve</span>
        <span><span className="inline-block w-3 h-3 rounded bg-red-700/60 align-middle mr-1"></span>reject</span>
        <span><span className="inline-block w-3 h-3 rounded bg-yellow-700/40 align-middle mr-1"></span>quest</span>
        <span><span className="inline-block w-3 h-3 rounded bg-cyan-700/40 align-middle mr-1"></span>lady</span>
      </div>
    </div>
  );
}

/* ---- Sub-components ---- */

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
  const shorthand = nominationShorthand(leaderSeat, teamSeats);

  return (
    <tr className={`border-b border-gray-800/50 ${record.approved ? '' : 'opacity-60'}`}>
      {/* Leader */}
      <td className="px-1.5 py-1.5 text-yellow-400 font-bold sticky left-0 bg-avalon-dark z-10">
        {leaderSeat}
      </td>
      {/* Seat cells */}
      {playerIds.map((pid, i) => {
        const isOnTeam = teamSeatSet.has(i);
        const vote = record.votes[pid];
        const hasVoted = vote !== undefined;
        const isMe = pid === currentPlayerId;

        // Cell coloring logic:
        // - On team: blue background
        // - Voted approve: green dot
        // - Voted reject: red dot
        let bgClass = '';
        let dotClass = '';

        if (isOnTeam) {
          bgClass = 'bg-blue-600/30';
        }

        if (hasVoted) {
          dotClass = vote ? 'text-green-400' : 'text-red-400';
        }

        return (
          <td
            key={i}
            className={`px-0.5 py-1.5 text-center ${bgClass} ${isMe ? 'ring-1 ring-inset ring-yellow-500/30' : ''}`}
          >
            {hasVoted && (
              <span className={`text-[10px] font-bold ${dotClass}`}>
                {vote ? 'O' : 'X'}
              </span>
            )}
            {isOnTeam && !hasVoted && (
              <span className="text-blue-400 text-[10px]">*</span>
            )}
          </td>
        );
      })}
      {/* Result */}
      <td className={`px-1.5 py-1.5 text-center font-bold ${record.approved ? 'text-green-400' : 'text-red-400'}`}>
        {record.approved ? 'Y' : 'N'}
        <span className="text-gray-600 text-[9px] ml-0.5">{approveCount}/{totalVotes}</span>
      </td>
      {/* Shorthand memo */}
      <td className="px-1.5 py-1.5 text-gray-400 font-mono">
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
  const resultSymbols = record.result === 'success'
    ? 'o'.repeat(record.team.length - record.failCount) + 'x'.repeat(record.failCount)
    : 'o'.repeat(record.team.length - record.failCount) + 'x'.repeat(record.failCount);

  return (
    <tr className="border-b border-yellow-800/40 bg-yellow-900/20">
      <td className="px-1.5 py-1.5 text-yellow-500 font-bold sticky left-0 bg-yellow-900/20 z-10">
        Q{round}
      </td>
      <td colSpan={playerCount} className="px-1.5 py-1.5 text-center">
        <span className={`font-bold ${record.result === 'success' ? 'text-blue-300' : 'text-red-300'}`}>
          {record.result === 'success' ? 'SUCCESS' : 'FAIL'}
        </span>
        {record.failCount > 0 && (
          <span className="text-red-400 ml-1.5 text-[10px]">({record.failCount} fail)</span>
        )}
      </td>
      <td className={`px-1.5 py-1.5 text-center font-bold ${record.result === 'success' ? 'text-blue-300' : 'text-red-300'}`}>
        {record.result === 'success' ? 'o' : 'x'}
      </td>
      <td className="px-1.5 py-1.5 text-yellow-400/70 font-mono text-[10px]">
        {resultSymbols}
      </td>
    </tr>
  );
}

function LadyRow({
  row,
  playerCount,
  seatMap,
  getName,
  currentPlayerId,
}: {
  row: Extract<ScoresheetRow, { type: 'lady' }>;
  playerCount: number;
  seatMap: Map<string, number>;
  getName: (id: string) => string;
  currentPlayerId: string;
}): JSX.Element {
  const { record } = row;
  const holderSeat = seatMap.get(record.holderId) ?? -1;
  const targetSeat = seatMap.get(record.targetId) ?? -1;
  const isHolder = record.holderId === currentPlayerId;
  // result may be undefined for non-holders (sanitized by server)
  const resultKnown = record.result !== undefined && record.result !== null;
  const resultLabel = resultKnown
    ? (record.result === 'good' ? 'o' : 'x')
    : '?';

  return (
    <tr className="border-b border-cyan-800/40 bg-cyan-900/15">
      <td className="px-1.5 py-1.5 text-cyan-400 font-bold sticky left-0 bg-cyan-900/15 z-10">
        L
      </td>
      <td colSpan={playerCount} className="px-1.5 py-1.5 text-center">
        <span className="text-cyan-300">
          {holderSeat}{'>'}{targetSeat}
        </span>
        <span className="text-gray-500 ml-1.5 text-[10px]">
          ({getName(record.holderId).slice(0, 4)}{'>'}{getName(record.targetId).slice(0, 4)})
        </span>
        {resultKnown && isHolder && (
          <span className={`ml-1.5 font-bold ${record.result === 'good' ? 'text-blue-300' : 'text-red-300'}`}>
            {record.result === 'good' ? 'Good' : 'Evil'}
          </span>
        )}
        {!isHolder && (
          <span className="ml-1.5 text-gray-600 text-[10px]">(hidden)</span>
        )}
      </td>
      <td className={`px-1.5 py-1.5 text-center font-bold ${
        resultKnown
          ? (record.result === 'good' ? 'text-blue-300' : 'text-red-300')
          : 'text-gray-600'
      }`}>
        {isHolder ? resultLabel : '?'}
      </td>
      <td className="px-1.5 py-1.5 text-cyan-400/70 font-mono text-[10px]">
        {holderSeat}{'>'}{targetSeat} {isHolder ? resultLabel : '?'}
      </td>
    </tr>
  );
}
