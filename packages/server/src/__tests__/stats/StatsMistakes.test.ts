/**
 * 可證明的失誤：@avalon/shared detectMistakes 與 generate_cache.detect_mistakes 是同一套規則，這裡用 Python
 * MistakeTest 的同一批合成局（test_generate_cache.py）。配置 123456：刺 1、娜 2、德 3、奧 4、派 5、梅 6；7、8、9、0 忠臣。
 */
import { describe, expect, it } from 'vitest';
import {
  MISTAKE_BLUE_APPROVE, MISTAKE_BLUE_LEADER, MISTAKE_LAKE_CLAIM, MISTAKE_PROVEN_SENT, MISTAKE_RED_MATCH_POINT, MISTAKE_SERIOUS,
  SERIOUS_MISTAKES, decodeConfig, decodeGamesDataset, deriveLeaderSeats, detectMistakes, gameMistakes,
  type MistakeLake, type MistakeProposal,
} from '@avalon/shared/stats';
import { makeDataset } from './datasetBuilder';

const ROLES = decodeConfig('123456');
const detect = (p: MistakeProposal[], m: string[], l: MistakeLake[] = []) => detectMistakes(ROLES, p, m, l);

describe('detectMistakes (same cases as the Python MistakeTest)', () => {
  it('a team proven by the public record goes, and blues approve it', () => {
    expect(detect([[1, '157', '157890'], [2, '1570', '125670']], ['oox', 'ooox'])).toEqual([
      [MISTAKE_SERIOUS, 0, ''], [MISTAKE_BLUE_APPROVE, 2, '5670'], [MISTAKE_PROVEN_SENT, 2, '1570']]);
  });

  it('own knowledge: proven for the blue on the failed team only', () => {
    expect(detect([[1, '256', '256789'], [2, '2678', '25678'], [2, '7890', '789012']], ['oox', 'oooo']))
      .toEqual([[MISTAKE_BLUE_APPROVE, 2, '5']]);
  });

  it('round 4 needs two proven reds', () => {
    expect(detect([[1, '157', '157890'], [2, '5678', '567890'], [3, '5678', '567890'], [4, '15789', '157890']],
      ['oox', 'oooo', 'oooo', 'ooooo'])).toEqual([]);
    expect(detect([[1, '567', '567890'], [2, '1256', '125678'], [3, '5789', '578906'], [4, '12567', '125670']],
      ['ooo', 'ooxx', 'oooo', 'ooxxo'])).toEqual([
      [MISTAKE_SERIOUS, 0, ''], [MISTAKE_BLUE_APPROVE, 4, '5670'], [MISTAKE_PROVEN_SENT, 4, '12567']]);
  });

  it('unreliable votes and the forced proposal are not read', () => {
    expect(detect([[1, '157', '157890'], [2, '1570', '157089'], [2, '1578', null]], ['oox', ''])).toEqual([]);
  });

  it('the leader (derived from the rotation)', () => {
    const p: MistakeProposal[] = [[1, '136', '136'], [1, '246', '246'], [1, '348', '348'], [1, '456', '456'], [1, '125', null],
      [2, '1256', '1256'], [2, '7890', '789012']];
    expect(deriveLeaderSeats(p.map((x) => x[1]))).toEqual([...'1234567']);
    expect(detect(p, ['oox', 'oooo'])).toEqual([[MISTAKE_SERIOUS, 0, ''], [MISTAKE_BLUE_APPROVE, 2, '56'], [MISTAKE_BLUE_LEADER, 2, '6']]);
    expect(deriveLeaderSeats(['123', '456', '789'])).toBeNull();
  });

  it('lake: a loyal saying the opposite is 待查 and not serious; Merlin is not judged', () => {
    const p: MistakeProposal[] = [[1, '567', '567890'], [2, '5678', '567890'], [3, '1789', '178906']];
    expect(detect(p, ['ooo', 'oooo', 'oooo'], [[2, '0', '1', 'o'], [3, '1', '6', 'x']]))
      .toEqual([[MISTAKE_BLUE_APPROVE, 3, '0'], [MISTAKE_LAKE_CLAIM, 2, '0']]);
    expect(detect(p.slice(0, 2), ['ooo', 'oooo'], [[2, '6', '1', 'o']])).toEqual([]);
  });

  it('red at match point without a fail', () => {
    const found = detect([[1, '157', '157890'], [2, '2567', '256789'], [3, '1789', '178906']], ['oox', 'ooox', 'oooo']);
    expect(found[found.length - 1]).toEqual([MISTAKE_RED_MATCH_POINT, 3, '1']);
    expect(SERIOUS_MISTAKES.has(MISTAKE_RED_MATCH_POINT)).toBe(false);
  });

  it('gameMistakes reads a games_cache game (votes, missions, lake claims)', () => {
    const { games } = decodeGamesDataset(makeDataset([{
      config: '123456', missions: 'oox|ooox|||', votes: [[1, 1, '157', '157890'], [2, 1, '1570', '125670']],
      lakes: '01----', claims: '01o',
    }]));
    expect(gameMistakes(games[0])).toEqual([[MISTAKE_SERIOUS, 0, ''], [MISTAKE_BLUE_APPROVE, 2, '5670'],
      [MISTAKE_PROVEN_SENT, 2, '1570'], [MISTAKE_LAKE_CLAIM, 2, '0']]);
  });
});
