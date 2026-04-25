/**
 * Verify `sheets:unknown` aggregate player appears in games_v2 as expected
 * after Edward 2026-04-24 15:27 decision (空玩家欄 → sheets:unknown fallback).
 * Prints count of games that include at least one `sheets:unknown` seat.
 */
import * as admin from 'firebase-admin';
import * as fs from 'fs';

function initAdmin(): void {
  if (admin.apps.length > 0) return;
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credsPath) throw new Error('No GOOGLE_APPLICATION_CREDENTIALS.');
  const sa = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: process.env.FIREBASE_PROJECT_ID ?? sa.project_id,
  });
}

async function main(): Promise<void> {
  initAdmin();
  const snap = await admin.firestore().collection('games_v2').get();
  let withUnknown = 0;
  let withoutUnknown = 0;
  let totalSeatsUnknown = 0;
  for (const doc of snap.docs) {
    const rec = doc.data() as { playerSeats?: string[] };
    const seats = rec.playerSeats ?? [];
    const unknownSeats = seats.filter((s) => s === 'sheets:unknown').length;
    if (unknownSeats > 0) {
      withUnknown += 1;
      totalSeatsUnknown += unknownSeats;
    } else {
      withoutUnknown += 1;
    }
  }
  console.log(
    `Total games_v2: ${snap.size}\n` +
      `  with sheets:unknown seat: ${withUnknown}\n` +
      `  without sheets:unknown seat: ${withoutUnknown}\n` +
      `  total sheets:unknown seat count: ${totalSeatsUnknown}`,
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
