/** 牌譜有效投票；百分率 0–100，未滿 10 票時 rate / pr 為 null。 */
export interface VotingRate {
  hits: number;
  votes: number;
  rate: number | null;
  pr: number | null;
  cohortPlayers: number;
}

export interface PlayerVoting {
  version: 1;
  minVotes: number;
  r3Reject: { loyal: VotingRate; red: VotingRate };
  teamComposition: Record<'all' | 'r3Plus', {
    evilTeamReject: VotingRate;
    goodTeamApprove: VotingRate;
  }>;
}
