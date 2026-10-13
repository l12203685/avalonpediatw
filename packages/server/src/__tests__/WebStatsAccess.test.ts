/**
 * Stats without a login (players' report 2026-10-13: some thought the stats
 * needed a login — the LINE / Discord buttons on the login screen failed — and
 * one could not reach the leaderboard).
 *
 * The web package has no test runner; its pure helpers are tested here:
 *  - packages/web/src/utils/statsLinks.ts: which pages render without a
 *    session, and the #stats / #player=<名字> links the bots now send
 *  - packages/web/src/utils/loginProviders.ts: only OAuth flows the server
 *    reports as ready (GET /auth/providers) get a button
 * plus the bot replies that link those pages. Made-up names.
 */
import { describe, expect, it } from 'vitest';
import { PUBLIC_STATS_STATES, parseStatsHash } from '../../../web/src/utils/statsLinks';
import { NO_OAUTH_PROVIDERS, parseLoginProviders } from '../../../web/src/utils/loginProviders';
import {
  STATS_PAGE_URL,
  STATS_SITE_URL,
  formatLeaderboard,
  formatPlayerCard,
  playerStatsUrl,
} from '../bots/stats/statsReplies';
import type { OverviewData, PlayerStats } from '../services/sheetsAnalysis';

describe('web: pages reachable without a session', () => {
  it('covers the leaderboard, the analysis (incl. 玩家雷達) and the wiki', () => {
    for (const s of ['analytics', 'analysis', 'leaderboard', 'wiki', 'help'] as const) {
      expect(PUBLIC_STATS_STATES.has(s)).toBe(true);
    }
  });

  it('keeps account pages behind a session', () => {
    for (const s of ['personalStats', 'profile', 'settings', 'friends', 'adminClaims', 'lobby'] as const) {
      expect(PUBLIC_STATS_STATES.has(s)).toBe(false);
    }
  });
});

describe('web: parseStatsHash', () => {
  it('opens the stats page for #stats and its aliases', () => {
    for (const h of ['#stats', '#STATS', '#analytics', '#leaderboard', '#rank', 'stats']) {
      expect(parseStatsHash(h)).toEqual({ kind: 'stats' });
    }
  });

  it('opens one player for #player=<encoded name>', () => {
    expect(parseStatsHash(`#player=${encodeURIComponent('小明明')}`)).toEqual({ kind: 'player', name: '小明明' });
    expect(parseStatsHash('#player=Quill%20Fen')).toEqual({ kind: 'player', name: 'Quill Fen' });
    expect(parseStatsHash('#player/Abc')).toEqual({ kind: 'player', name: 'Abc' });
    expect(parseStatsHash('#player=100%')).toEqual({ kind: 'player', name: '100%' }); // bad escape kept as typed
    expect(parseStatsHash('#player=')).toBeNull();
    expect(parseStatsHash('#player=%20')).toEqual({ kind: 'stats' });
  });

  it('ignores other hashes (practice, OAuth leftovers, empty)', () => {
    for (const h of ['', '#', '#practice', '#settings', '#playerx', undefined, null]) {
      expect(parseStatsHash(h)).toBeNull();
    }
  });

  it('round-trips the bot link for every kind of name', () => {
    for (const name of ['阿甲', 'Quill Fen', 'ＡＢＣ', 'x/y#z', '100%']) {
      const url = playerStatsUrl(name);
      expect(url.startsWith(`${STATS_SITE_URL}/#player=`)).toBe(true);
      expect(parseStatsHash(new URL(url).hash)).toEqual({ kind: 'player', name });
    }
    expect(parseStatsHash(new URL(STATS_PAGE_URL).hash)).toEqual({ kind: 'stats' });
  });
});

describe('web: parseLoginProviders', () => {
  it('shows only the flows the server reports as ready', () => {
    expect(parseLoginProviders({ discord: true, line: false, google: true }, true)).toEqual({ discord: true, line: false, google: true });
    expect(parseLoginProviders({ discord: false, line: true, google: false }, true)).toEqual({ discord: false, line: true, google: false });
  });

  it('needs the Firebase web config for Google', () => {
    expect(parseLoginProviders({ google: true }, false).google).toBe(false);
  });

  it('treats an old server / odd body as "nothing ready"', () => {
    for (const body of [null, undefined, 'x', [], {}, { discord: 'true', line: 1, google: 'yes' }]) {
      expect(parseLoginProviders(body, true)).toEqual(NO_OAUTH_PROVIDERS);
    }
  });
});

describe('bots link the stats pages (no login)', () => {
  const player = {
    name: '阿甲', totalGames: 12, winRate: 50, roleTheory: 50, positionTheory: 0,
    finalWinRate: 50, finalRedWinRate: 40, finalBlueWinRate: 60, missionWinRate: 50,
  } as unknown as PlayerStats;

  it('/戰績 ends with the player\'s own page', () => {
    const lines = formatPlayerCard({ player }).split('\n');
    expect(lines[lines.length - 1]).toContain(playerStatsUrl('阿甲'));
    expect(lines[lines.length - 1]).toContain('不用登入');
  });

  it('/排行 links #stats', () => {
    const overview = { totalGames: 10, totalPlayers: 3 } as unknown as OverviewData;
    const text = formatLeaderboard(overview, { title: '排行', rows: [], emptyNote: '—' });
    expect(text).toContain(STATS_PAGE_URL);
  });
});
