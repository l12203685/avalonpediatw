/**
 * 測試用：用幾行描述組出一份 games_cache.json 形狀的資料集（名字都是虛構的）。
 * 預設值：配置 123456（1 刺客、2 莫甘娜、3 莫德雷德、4 奧伯倫、5 派西維爾、6 梅林，7..0 忠臣）、三紅、線瓦。
 */
import { GAMES_DATASET_FIELDS, GAMES_DATASET_VERSION, type GamesDataset, type GameTuple, type VotingProposal } from '@avalon/shared/stats';

export const TEST_LEADERBOARD_CONFIG = {
  theoryMinCellGames: 3, activeDays: 90, topN: 10, mainGames: 100, roleWindowGames: 10, loyalWindowGames: 40,
  overallMinGames: 250, theoryMinGames: 0, requireRoleWindows: 1, assassinAttempts: 20, assassinMinAttempts: 10,
  newcomerDays: 90, newcomerMinGames: 10,
  roleTitleGames: 20, roleTitleFallbackGames: 20, loyalTitleGames: 20, loyalTitleFallbackGames: 20,
};

export const NOTE_TAGS = [
  'season:S1', 'season:S2', 'season:S3', 'season:S5', 'venue:古亭', 'venue:九號', 'venue:台中', 'venue:東門', 'venue:小巨蛋',
  'venue:Discopia星球', 'venue:台中家', 'venue:學餐', 'venue:新竹謎寶', 'venue:不鳥谷', 'venue:政大', 'flag:spectated',
  'flag:notRecorderGame', 'flag:review', 'flag:badGame', 'flag:lakeCorrected', 'flag:substitution', 'flag:incident',
];

const CATEGORIES = ['線瓦', '面瓦', '娛樂', '', '其他'];
const OUTCOMES = ['三紅', '三藍死', '三藍活', '', '其他'];

export interface GameSpec {
  id?: string;
  src?: 0 | 1;
  date?: string;
  cat?: string;
  slot?: number;
  note?: string[];
  config?: string;
  outcome?: string;
  kill?: string;
  /** 座位 1..9、10 的名字（null = 沒寫）。 */
  names?: Array<string | null>;
  missions?: string;
  rounds?: string;
  state?: string;
  firstTeam?: string;
  lakes?: string;
  claims?: string;
  captains?: string;
  votes?: VotingProposal[];
}

export const TEN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'].map((c) => `虛構${c}`);

export function makeDataset(specs: GameSpec[]): GamesDataset {
  const players: string[] = [];
  const states: string[] = [];
  const games: GameTuple[] = specs.map((s, i) => {
    const names = s.names ?? TEN;
    const seats = names.map((n) => {
      if (!n) return -1;
      if (!players.includes(n)) players.push(n);
      return players.indexOf(n);
    });
    const state = s.state ?? '';
    if (state && !states.includes(state)) states.push(state);
    return [
      s.id ?? String(i + 1), s.src ?? 0, s.date ?? '', CATEGORIES.indexOf(s.cat ?? '線瓦'), s.slot ?? 0,
      (s.note ?? []).map((t) => NOTE_TAGS.indexOf(t)), s.config ?? '123456', OUTCOMES.indexOf(s.outcome ?? '三紅'),
      s.kill ?? '', seats, s.missions ?? 'ooo|oxo|ooo||', s.rounds ?? 'BRB--', state ? states.indexOf(state) : -1,
      s.firstTeam ?? '157', s.lakes ?? '71----', s.claims ?? '', s.captains ?? '', s.votes ?? [],
    ] as GameTuple;
  });
  return {
    format: 'avalon-games',
    version: GAMES_DATASET_VERSION,
    key: 'testkey000000000',
    cacheSchemaVersion: 4,
    config: { leaderboard: { ...TEST_LEADERBOARD_CONFIG }, theoryWindows: [100], minGamesThreshold: 30, excessShrinkK: 20, lakeClaimMinSample: 30 },
    constants: {
      allRoles: ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林', '忠臣'],
      configRoleOrder: ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林'],
      redRoles: ['刺客', '莫甘娜', '莫德雷德', '奧伯倫'],
      seats: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
      roleDealTenths: { 刺客: 1, 莫甘娜: 1, 莫德雷德: 1, 奧伯倫: 1, 派西維爾: 1, 梅林: 1, 忠臣: 4 },
    },
    counts: { games: games.length, fromSheet: games.length, fromDiscord: 0, players: players.length, dated: 0, undated: 0 },
    vocab: { category: CATEGORIES, outcome: OUTCOMES, state: [...states, '?'], noteTags: NOTE_TAGS },
    players,
    aliases: {},
    fields: [...GAMES_DATASET_FIELDS],
    games,
  };
}
