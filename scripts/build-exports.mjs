import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadGames } from './lib/load-games.mjs';

const ROOT = process.cwd();
const EXPORTS_DIR = path.join(ROOT, 'exports');
const CSV_PATH = path.join(EXPORTS_DIR, 'games.csv');
const STATS_PATH = path.join(ROOT, 'STATS.md');

const CSV_COLUMNS = [
  'gameId',
  'playedAtIso',
  'playedAtMs',
  'totalDurationMs',
  'winnerCamp',
  'hasAI',
  'casual',
  'missionCount',
  'ladyChainLength',
  ...Array.from({ length: 10 }, (_, i) => `seat${i + 1}`),
  'missionsJson',
  'ladyChainJson',
];

function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toRow(game) {
  const seats = Array.isArray(game.playerSeats) ? game.playerSeats : [];
  const values = {
    gameId: game.gameId ?? '',
    playedAtIso: game.playedAt ? new Date(game.playedAt).toISOString() : '',
    playedAtMs: game.playedAt ?? '',
    totalDurationMs: game.totalDurationMs ?? '',
    winnerCamp: game.finalResult?.winnerCamp ?? '',
    hasAI: game.hasAI ?? false,
    casual: game.casual ?? false,
    missionCount: Array.isArray(game.missions) ? game.missions.length : 0,
    ladyChainLength: Array.isArray(game.ladyChain) ? game.ladyChain.length : 0,
    missionsJson: JSON.stringify(game.missions ?? []),
    ladyChainJson: JSON.stringify(game.ladyChain ?? []),
  };
  for (let i = 0; i < 10; i++) values[`seat${i + 1}`] = seats[i] ?? '';
  return CSV_COLUMNS.map((col) => csvField(values[col])).join(',');
}

function buildCsv(games) {
  return [CSV_COLUMNS.join(','), ...games.map(toRow)].join('\n') + '\n';
}

function pct(n, total) {
  return total === 0 ? '—' : `${((n / total) * 100).toFixed(1)}%`;
}

function winCounts(list) {
  const good = list.filter((g) => g.finalResult?.winnerCamp === 'good').length;
  const evil = list.filter((g) => g.finalResult?.winnerCamp === 'evil').length;
  return { good, evil, total: list.length };
}

function buildStats(games) {
  const ranked = games.filter((g) => !g.casual && !g.hasAI);
  const overall = winCounts(games);
  const rankedCounts = winCounts(ranked);

  const seatCounts = new Map();
  for (const g of games) {
    for (const seat of g.playerSeats ?? []) {
      if (!seat) continue;
      seatCounts.set(seat, (seatCounts.get(seat) ?? 0) + 1);
    }
  }
  const topPlayers = [...seatCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  const recent = [...games].slice(-20).reverse();

  const lines = [];
  lines.push('# Avalon 對戰統計');
  lines.push('');
  lines.push('> 本檔案由 `scripts/build-exports.mjs` 從 `games/**/*.json` 自動產生，請勿手動編輯。');
  lines.push(`> 最後更新：${new Date().toISOString()}`);
  lines.push('');
  lines.push('## 總覽');
  lines.push('');
  lines.push(`- 總局數：**${overall.total}**`);
  lines.push(`- 好人陣營勝率（全部對局）：${overall.good} 勝 / ${overall.total} 局（${pct(overall.good, overall.total)}）`);
  lines.push(`- 壞人陣營勝率（全部對局）：${overall.evil} 勝 / ${overall.total} 局（${pct(overall.evil, overall.total)}）`);
  lines.push(
    `- 好人陣營勝率（排除 AI / 娛樂局，共 ${rankedCounts.total} 局）：${rankedCounts.good} 勝（${pct(rankedCounts.good, rankedCounts.total)}）`
  );
  lines.push(
    `- 壞人陣營勝率（排除 AI / 娛樂局，共 ${rankedCounts.total} 局）：${rankedCounts.evil} 勝（${pct(rankedCounts.evil, rankedCounts.total)}）`
  );
  lines.push('');
  lines.push('## 出場排行榜（依出場局數，前 20 名）');
  lines.push('');
  if (topPlayers.length === 0) {
    lines.push('_尚無資料。_');
  } else {
    lines.push('| 排名 | 玩家識別 | 出場局數 |');
    lines.push('|---|---|---|');
    topPlayers.forEach(([seat, count], i) => {
      lines.push(`| ${i + 1} | ${seat} | ${count} |`);
    });
  }
  lines.push('');
  lines.push('## 最近對局（最新 20 場）');
  lines.push('');
  if (recent.length === 0) {
    lines.push('_尚無資料。_');
  } else {
    lines.push('| 時間（UTC） | gameId | 勝方 | AI | 娛樂局 |');
    lines.push('|---|---|---|---|---|');
    for (const g of recent) {
      const date = g.playedAt ? new Date(g.playedAt).toISOString() : '—';
      lines.push(
        `| ${date} | ${g.gameId ?? '—'} | ${g.finalResult?.winnerCamp ?? '—'} | ${g.hasAI ? '✓' : ''} | ${g.casual ? '✓' : ''} |`
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const games = await loadGames();
  await mkdir(EXPORTS_DIR, { recursive: true });
  await writeFile(CSV_PATH, buildCsv(games), 'utf8');
  await writeFile(STATS_PATH, buildStats(games), 'utf8');
  console.log(`Wrote ${CSV_PATH} and ${STATS_PATH} for ${games.length} game(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
