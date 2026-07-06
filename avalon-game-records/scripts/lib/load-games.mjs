import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_GAMES_DIR = path.join(process.cwd(), 'games');

async function walkJsonFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkJsonFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}

// Reads every games/{YYYY}/{MM}/{gameId}.json into a flat, playedAt-sorted array.
export async function loadGames(gamesDir = DEFAULT_GAMES_DIR) {
  const files = await walkJsonFiles(gamesDir);
  const games = [];
  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    let record;
    try {
      record = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse ${file}: ${err.message}`);
    }
    games.push(record);
  }
  games.sort((a, b) => (a.playedAt ?? 0) - (b.playedAt ?? 0));
  return games;
}
