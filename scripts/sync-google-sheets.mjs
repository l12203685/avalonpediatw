import { GoogleAuth } from 'google-auth-library';
import { loadGames } from './lib/load-games.mjs';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID;
const SHEET_NAME = process.env.GOOGLE_SHEETS_TAB || 'Games';
const CREDENTIALS_JSON = process.env.GOOGLE_SHEETS_CREDENTIALS_JSON;

const HEADER = [
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
];

function toRow(game) {
  const seats = Array.isArray(game.playerSeats) ? game.playerSeats : [];
  return [
    game.gameId ?? '',
    game.playedAt ? new Date(game.playedAt).toISOString() : '',
    game.playedAt ?? '',
    game.totalDurationMs ?? '',
    game.finalResult?.winnerCamp ?? '',
    game.hasAI ?? false,
    game.casual ?? false,
    Array.isArray(game.missions) ? game.missions.length : 0,
    Array.isArray(game.ladyChain) ? game.ladyChain.length : 0,
    ...Array.from({ length: 10 }, (_, i) => seats[i] ?? ''),
  ];
}

async function getAccessToken(credentials) {
  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

async function sheetsRequest(token, method, pathSuffix, body) {
  const res = await fetch(`${SHEETS_API}/${SPREADSHEET_ID}${pathSuffix}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Sheets API ${method} ${pathSuffix} -> ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  if (!CREDENTIALS_JSON || !SPREADSHEET_ID) {
    console.log('GOOGLE_SHEETS_CREDENTIALS_JSON or GOOGLE_SHEETS_ID not set, skipping Google Sheets sync.');
    return;
  }

  const credentials = JSON.parse(CREDENTIALS_JSON);
  const token = await getAccessToken(credentials);
  const games = await loadGames();
  const values = [HEADER, ...games.map(toRow)];

  await sheetsRequest(token, 'POST', `/values/${encodeURIComponent(SHEET_NAME)}:clear`);
  await sheetsRequest(
    token,
    'PUT',
    `/values/${encodeURIComponent(`${SHEET_NAME}!A1`)}?valueInputOption=RAW`,
    { values }
  );

  console.log(`Synced ${games.length} game(s) to Google Sheet ${SPREADSHEET_ID} (tab "${SHEET_NAME}").`);
}

main().catch((err) => {
  console.error('Google Sheets sync failed:', err);
  process.exitCode = 1;
});
