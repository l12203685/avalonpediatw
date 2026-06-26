import { readFile } from 'node:fs/promises';
import path from 'node:path';

const API_BASE = 'https://api.hackmd.io/v1';
const TOKEN = process.env.HACKMD_API_TOKEN;
const NOTE_ID = process.env.HACKMD_NOTE_ID;
const STATS_PATH = path.join(process.cwd(), 'STATS.md');

async function main() {
  if (!TOKEN || !NOTE_ID) {
    console.log('HACKMD_API_TOKEN or HACKMD_NOTE_ID not set, skipping HackMD sync.');
    return;
  }

  const content = await readFile(STATS_PATH, 'utf8');

  const res = await fetch(`${API_BASE}/notes/${NOTE_ID}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    throw new Error(`HackMD API PATCH /notes/${NOTE_ID} -> ${res.status} ${res.statusText}: ${await res.text()}`);
  }

  console.log(`Synced STATS.md to HackMD note ${NOTE_ID}.`);
}

main().catch((err) => {
  console.error('HackMD sync failed:', err);
  process.exitCode = 1;
});
