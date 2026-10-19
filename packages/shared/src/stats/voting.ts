/** voting_stats.compute_player_voting：同一組局重算票數與滿 10 票玩家的 PR。 */
import type { PlayerVoting, VotingRate } from '../derived/playerVoting';
import { ALL_ROLES, isOutcome, RED_ROLES, SEATS } from './constants';
import type { Game } from './dataset';
import { rate } from './pyround';

const MIN_VOTES = 10;
const cell = (): VotingRate => ({ hits: 0, votes: 0, rate: null, pr: null, cohortPlayers: 0 });
const composition = () => ({ evilTeamReject: cell(), goodTeamApprove: cell() });
const empty = (): PlayerVoting => ({
  version: 1, minVotes: MIN_VOTES, r3Reject: { loyal: cell(), red: cell() },
  teamComposition: { all: composition(), r3Plus: composition() },
});
const cellsOf = (row: PlayerVoting): VotingRate[] => [
  row.r3Reject.loyal, row.r3Reject.red,
  row.teamComposition.all.evilTeamReject, row.teamComposition.all.goodTeamApprove,
  row.teamComposition.r3Plus.evilTeamReject, row.teamComposition.r3Plus.goodTeamApprove,
];

export function computePlayerVoting(games: readonly Game[]): Map<string, PlayerVoting> {
  const rows = new Map<string, PlayerVoting>();
  for (const game of games) {
    if (!isOutcome(game.outcome)) continue;
    for (const name of game.seatPlayers) if (name !== null && !rows.has(name)) rows.set(name, empty());
    for (const [round, attempt, team, approved] of game.votingProposals) {
      if (attempt >= 5) continue;
      const roles = [...team].map((seat) => game.seatRoles.get(seat) ?? '');
      if (roles.some((role) => !(ALL_ROLES as readonly string[]).includes(role))) continue;
      const evilTeam = roles.some((role) => RED_ROLES.has(role));
      game.seatPlayers.forEach((name, i) => {
        if (name === null) return;
        const row = rows.get(name)!;
        const reject = !approved.includes(SEATS[i]);
        const role = game.seatRoles.get(SEATS[i]) ?? '';
        const perspective = RED_ROLES.has(role) ? 'red' : role === '忠臣' ? 'loyal' : null;
        const add = (target: VotingRate, hit: boolean) => { target.votes += 1; target.hits += Number(hit); };
        if (round >= 3 && perspective) add(row.r3Reject[perspective], reject);
        const metric = evilTeam ? 'evilTeamReject' : 'goodTeamApprove';
        add(row.teamComposition.all[metric], evilTeam ? reject : !reject);
        if (round >= 3) add(row.teamComposition.r3Plus[metric], evilTeam ? reject : !reject);
      });
    }
  }
  const cells = [...rows.values()].map(cellsOf);
  for (let i = 0; i < 6; i += 1) {
    const column = cells.map((row) => row[i]);
    for (const c of column) if (c.votes >= MIN_VOTES) c.rate = rate(c.hits, c.votes);
    const values = column.flatMap((c) => c.rate === null ? [] : [c.rate]);
    for (const c of column) {
      c.cohortPlayers = values.length;
      if (c.rate === null) continue;
      const less = values.filter((v) => v < c.rate!).length;
      const equal = values.filter((v) => v === c.rate).length;
      c.pr = rate(less + equal / 2, values.length);
    }
  }
  return rows;
}
