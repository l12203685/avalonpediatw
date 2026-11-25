/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 74 回合：派西的拇指題（每日一題題庫的全部派西題）逐題的局面欄位，給情境分析用。
 * 每一題一列 JSON：兩根拇指各自出過哪些任務、第一次被失敗任務沾到的那一局怎麼發生的（誰派的、是不是強制局、這根拇指投什麼、
 * 派西自己在不在上面）、沾到之後這根拇指和另一根拇指的提議、真人派西當時帶了哪一根、擬合讀法（percivalRead39）怎麼說。
 * 只有題號、座位、角色，沒有玩家名字。
 *
 *   cd packages/server && npx tsx scripts/thumbStudy74.ts > thumb.jsonl
 */
import path from 'path';
import { percivalRead39 } from '../src/ai/BlueRound39Percival';
import { seatId } from '../src/ai/benchmark/replayObservation';
import { EVIL_ROLES } from '../src/ai/benchmark/sheetsReplay';
import { buildSimBank, readSimBankFile } from '../src/bots/simulation/bank';
import { bankScenarios } from '../src/ai/scenarios/bankScenarios';
import { observationOf } from '../src/ai/scenarios/scenarioSuite';

const root = path.resolve(__dirname, '..');
const bankFile = readSimBankFile([path.join(root, 'sim_bank.json')]);
if (!bankFile) throw new Error('sim_bank.json 讀不到');
const list = bankScenarios(buildSimBank(bankFile), new Set(['thumb']));

for (const s of list) {
  const g = s.game;
  if (s.point.kind !== 'team_select') continue;
  const until = s.point.proposal;
  const me = s.seat;
  const merlin = g.seatRoles.indexOf('merlin') + 1;
  const morgana = g.seatRoles.indexOf('morgana') + 1;
  const mordred = g.seatRoles.indexOf('mordred') + 1;
  const cur = g.proposals[until];
  const quests = g.quests.filter((q) => q.round < cur.round);
  const props = g.proposals.slice(0, until);
  const isRed = (x: number): boolean => EVIL_ROLES.has(g.seatRoles[x - 1]);
  const thumb = (t: number, o: number): Record<string, number | boolean | null> => {
    const on = quests.filter((q) => q.teamSeats.includes(t));
    const failed = on.filter((q) => q.failed);
    const first = failed[0];
    const out: Record<string, number | boolean | null> = {
      onSucc: on.length - failed.length,
      onFail: failed.length,
      onFailMulti: failed.filter((q) => q.failCount >= 2).length,
      ledFail: quests.filter((q) => q.failed && props.some((p) => p.round === q.round && p.wentOnMission && p.leaderSeat === t)).length,
      ledSucc: quests.filter((q) => !q.failed && props.some((p) => p.round === q.round && p.wentOnMission && p.leaderSeat === t)).length,
      proposals: props.filter((p) => p.leaderSeat === t).length,
      proposedOther: props.filter((p) => p.leaderSeat === t && p.teamSeats.includes(o)).length,
      proposedMe: props.filter((p) => p.leaderSeat === t && p.teamSeats.includes(me)).length,
      innerBlack: props.filter((p) => !p.forced && p.minusSeats.includes(t)).length,
      outerWhite: props.filter((p) => !p.forced && p.plusSeats.includes(t)).length,
    };
    if (first) {
      const mp = props.find((p) => p.round === first.round && p.wentOnMission);
      const co = first.teamSeats.filter((x) => x !== t);
      const after = props.filter((p) => p.round > first.round);
      const mine = after.filter((p) => p.leaderSeat === t);
      const theirs = after.filter((p) => p.leaderSeat === o);
      Object.assign(out, {
        stainRound: first.round,
        stainFails: first.failCount,
        stainSize: first.teamSeats.length,
        stainForced: mp ? mp.forced : null,
        stainLedBy: mp ? (mp.leaderSeat === t ? 1 : mp.leaderSeat === o ? 2 : mp.leaderSeat === me ? 3 : 0) : null,
        stainLeaderRed: mp ? isRed(mp.leaderSeat) : null,
        stainSelfRejected: mp && !mp.forced ? mp.minusSeats.includes(t) : null,
        stainMeOn: first.teamSeats.includes(me),
        stainOtherApproved: mp && !mp.forced ? mp.votes[o - 1] : null,
        stainMeApproved: mp && !mp.forced ? mp.votes[me - 1] : null,
        stainCoReds: co.filter(isRed).length,
        stainCoMordred: co.includes(mordred),
        // 沾到之後：這根拇指自己的提議有幾次、帶了幾次同一個失敗任務的隊友；另一根拇指的提議帶了這根幾次。
        afterOwn: mine.length,
        afterOwnWithCo: mine.filter((p) => p.teamSeats.some((x) => co.includes(x))).length,
        afterOwnAllCo: mine.filter((p) => co.every((x) => p.teamSeats.includes(x))).length,
        afterOther: theirs.length,
        afterOtherWithMe: theirs.filter((p) => p.teamSeats.includes(t)).length,
        // 沾到之後這根拇指對「有那個失敗任務隊友的隊」投贊成幾次（不在隊上、非強制）。
        afterApproveCo: after.filter((p) => !p.forced && !p.teamSeats.includes(t) && p.teamSeats.some((x) => co.includes(x)) && p.votes[t - 1]).length,
        afterRejectOwnTeamCo: after.filter((p) => !p.forced && p.teamSeats.includes(t) && p.teamSeats.some((x) => co.includes(x)) && !p.votes[t - 1]).length,
      });
    }
    return out;
  };
  const obs = observationOf(s);
  const read = percivalRead39(obs);
  const pReadMerlin = read ? (read.thumbs[0] === seatId(merlin) ? read.pFirst : 1 - read.pFirst) : null;
  console.log(JSON.stringify({
    id: s.fixture.id,
    game: g.id,
    round: cur.round,
    attempt: cur.attempt,
    reds: quests.filter((q) => q.failed).length,
    humanHasMerlin: cur.teamSeats.includes(merlin),
    humanHasMorgana: cur.teamSeats.includes(morgana),
    humanReds: cur.teamSeats.filter(isRed).length,
    need: cur.round === 4 ? 2 : 1,
    win: g.winner === 'good',
    threeBlue: g.quests.filter((q) => !q.failed).length >= 3,
    pReadMerlin,
    M: thumb(merlin, morgana),
    G: thumb(morgana, merlin),
  }));
}
