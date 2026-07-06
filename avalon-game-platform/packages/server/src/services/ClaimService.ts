/**
 * ClaimService — manages claim requests for binding historical game records
 * to an authenticated user account.
 *
 * Firestore collections:
 *   - claimRequests/{id}        — player-submitted claim requests
 *   - games/{gameId}            — existing game records; players[].ownerUid
 *                                 is stamped when a claim is approved
 *   - adminAuditLog/{id}        — immutable audit trail of admin actions
 *
 * Record ID format: "<gameId>:<playerId>" — uniquely identifies one
 * historical game participation that can be claimed.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { getAdminFirestore } from './firebase';
import { invalidateLeaderboardCache } from './FirestoreLeaderboard';
import type { GameRecord, GamePlayerRecord } from './GameHistoryRepository';

// ---------------------------------------------------------------------------
// Types (these are the on-the-wire shape returned to the frontend)
// ---------------------------------------------------------------------------

export interface ClaimableRecord {
  /** "{gameId}:{playerId}" */
  recordId: string;
  gameId: string;
  playerId: string;
  displayName: string;
  role: string | null;
  team: 'good' | 'evil' | null;
  won: boolean;
  playerCount: number;
  roomName: string;
  createdAt: number;
  /** If already owned by someone, who (uid). Null when free to claim. */
  ownerUid: string | null;
  /** System-computed match confidence 0..100 when autoMatch surfaced it. */
  matchScore?: number;
}

export type ClaimStatus = 'pending' | 'approved' | 'rejected';

export interface ClaimRequest {
  id: string;
  uid: string;
  email: string | null;
  displayName: string;
  targetRecordIds: string[];
  evidenceNote: string;
  autoMatched: boolean;
  status: ClaimStatus;
  submittedAt: number;
  reviewedBy: string | null;
  reviewedAt: number | null;
  rejectReason: string | null;
  approvedRecordIds: string[] | null;
}

export interface AuditLogEntry {
  id: string;
  action: 'approve' | 'reject' | 'addAdmin' | 'removeAdmin';
  adminEmail: string;
  targetClaimId?: string;
  targetRecordIds?: string[];
  ts: number;
  details?: string;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

const CLAIMS = 'claimRequests';
const GAMES = 'games';
const AUDIT = 'adminAuditLog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StoredClaimRequest {
  uid: string;
  email: string | null;
  displayName: string;
  targetRecordIds: string[];
  evidenceNote: string;
  autoMatched: boolean;
  status: ClaimStatus;
  submittedAt: Timestamp;
  reviewedBy: string | null;
  reviewedAt: Timestamp | null;
  rejectReason: string | null;
  approvedRecordIds: string[] | null;
}

function tsToMillis(ts: Timestamp | null | undefined): number | null {
  if (!ts) return null;
  return typeof ts.toMillis === 'function' ? ts.toMillis() : Date.now();
}

function toClaim(id: string, doc: StoredClaimRequest): ClaimRequest {
  return {
    id,
    uid: doc.uid,
    email: doc.email,
    displayName: doc.displayName,
    targetRecordIds: doc.targetRecordIds ?? [],
    evidenceNote: doc.evidenceNote ?? '',
    autoMatched: !!doc.autoMatched,
    status: doc.status,
    submittedAt: tsToMillis(doc.submittedAt) ?? Date.now(),
    reviewedBy: doc.reviewedBy ?? null,
    reviewedAt: tsToMillis(doc.reviewedAt),
    rejectReason: doc.rejectReason ?? null,
    approvedRecordIds: doc.approvedRecordIds ?? null,
  };
}

function parseRecordId(id: string): { gameId: string; playerId: string } | null {
  const idx = id.indexOf(':');
  if (idx <= 0 || idx === id.length - 1) return null;
  return { gameId: id.slice(0, idx), playerId: id.slice(idx + 1) };
}

function recordIdOf(gameId: string, playerId: string): string {
  return `${gameId}:${playerId}`;
}

function gameToRecord(gameId: string, game: GameRecord, p: GamePlayerRecord, matchScore?: number): ClaimableRecord {
  const players = Array.isArray(game.players) ? game.players : [];
  const record: ClaimableRecord = {
    recordId: recordIdOf(gameId, p.playerId),
    gameId,
    playerId: p.playerId,
    displayName: p.displayName || p.playerId,
    role: p.role ?? null,
    team: p.team ?? null,
    won: !!p.won,
    playerCount: typeof game.playerCount === 'number' ? game.playerCount : players.length,
    roomName: game.roomName ?? gameId,
    createdAt: game.createdAt ?? 0,
    ownerUid: (p as GamePlayerRecord & { ownerUid?: string | null }).ownerUid ?? null,
  };
  if (matchScore !== undefined) record.matchScore = matchScore;
  return record;
}

// ---------------------------------------------------------------------------
// Matching heuristics
// ---------------------------------------------------------------------------

function normalize(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/** Simple fuzzy score: 100 exact, 80 case-insensitive, 60 substring, 40 token overlap. */
function scoreName(candidate: string, query: string): number {
  const c = normalize(candidate);
  const q = normalize(query);
  if (!c || !q) return 0;
  if (c === q) return 100;
  if (c === q || c.replace(/\s+/g, '') === q.replace(/\s+/g, '')) return 95;
  if (c.includes(q) || q.includes(c)) return 70;
  // Token overlap for multi-word names
  const ct = new Set(c.split(/\s+/));
  const qt = q.split(/\s+/);
  const overlap = qt.filter(t => ct.has(t)).length;
  if (overlap > 0) return 40 + overlap * 5;
  return 0;
}

// ---------------------------------------------------------------------------
// Auto-match: surface claim candidates for a given user
// ---------------------------------------------------------------------------

/**
 * Find claimable records that look like they might belong to `user`.
 * We search historical games for participants whose:
 *   - displayName fuzzy-matches user.displayName, OR
 *   - playerId === user.discordId / lineId / email prefix / etc.
 *
 * Records already owned by the current user are skipped; records owned by
 * another user are excluded (can't steal).
 */
export async function autoMatchCandidates(user: {
  uid: string;
  email?: string | null;
  displayName?: string | null;
}, limit = 50): Promise<ClaimableRecord[]> {
  const firestore = getAdminFirestore();

  const userDisplayName = normalize(user.displayName);
  const userEmail = normalize(user.email);
  const emailPrefix = userEmail.split('@')[0] || '';

  const snapshot = await firestore
    .collection(GAMES)
    .orderBy('endedAt', 'desc')
    .limit(500)
    .get();

  const candidates: ClaimableRecord[] = [];
  for (const doc of snapshot.docs) {
    const game = doc.data() as GameRecord;
    if (!Array.isArray(game.players)) continue;
    for (const p of game.players) {
      if (!p.playerId) continue;
      const ownerUid = (p as GamePlayerRecord & { ownerUid?: string | null }).ownerUid ?? null;
      if (ownerUid && ownerUid !== user.uid) continue; // already owned by someone else
      if (ownerUid === user.uid) continue; // already mine; not a candidate

      // Compute best score across several signals
      let score = 0;
      if (userDisplayName) {
        score = Math.max(score, scoreName(p.displayName ?? '', user.displayName ?? ''));
        score = Math.max(score, scoreName(p.playerId, user.displayName ?? ''));
      }
      if (emailPrefix) {
        score = Math.max(score, scoreName(p.displayName ?? '', emailPrefix));
      }
      // Exact match on playerId (e.g. Discord id matches historical guest id)
      if (p.playerId === user.uid) score = 100;

      if (score >= 40) {
        candidates.push(gameToRecord(doc.id, game, p, score));
      }
    }
    if (candidates.length >= limit) break;
  }

  candidates.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
  return candidates.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Manual search: fuzzy match by an old nickname + optional date range
// ---------------------------------------------------------------------------

export async function searchRecordsByName(
  query: string,
  opts: { since?: number; until?: number; limit?: number } = {},
): Promise<ClaimableRecord[]> {
  const q = normalize(query);
  if (!q) return [];

  const firestore = getAdminFirestore();
  const since = opts.since ?? 0;
  const until = opts.until ?? Date.now();
  const limit = opts.limit ?? 100;

  const snapshot = await firestore
    .collection(GAMES)
    .orderBy('endedAt', 'desc')
    .limit(1000)
    .get();

  const matches: ClaimableRecord[] = [];
  for (const doc of snapshot.docs) {
    const game = doc.data() as GameRecord;
    const ts = game.endedAt ?? game.createdAt ?? 0;
    if (ts < since || ts > until) continue;
    if (!Array.isArray(game.players)) continue;
    for (const p of game.players) {
      if (!p.playerId) continue;
      const ownerUid = (p as GamePlayerRecord & { ownerUid?: string | null }).ownerUid ?? null;
      if (ownerUid) continue; // skip already-owned records
      const score = scoreName(p.displayName ?? '', query);
      if (score >= 40) {
        matches.push(gameToRecord(doc.id, game, p, score));
      }
    }
    if (matches.length >= limit) break;
  }

  matches.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
  return matches.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Create / read claim requests
// ---------------------------------------------------------------------------

export async function createClaim(input: {
  uid: string;
  email: string | null;
  displayName: string;
  targetRecordIds: string[];
  evidenceNote: string;
  autoMatched: boolean;
}): Promise<ClaimRequest> {
  if (!input.targetRecordIds || input.targetRecordIds.length === 0) {
    throw new Error('No target records specified');
  }

  // Strip any invalid ids up front so we don't store junk
  const validIds = input.targetRecordIds.filter(id => parseRecordId(id) !== null);
  if (validIds.length === 0) {
    throw new Error('No valid record ids');
  }

  const firestore = getAdminFirestore();
  const ref = firestore.collection(CLAIMS).doc();

  const data: StoredClaimRequest = {
    uid: input.uid,
    email: input.email ?? null,
    displayName: input.displayName,
    targetRecordIds: validIds,
    evidenceNote: (input.evidenceNote ?? '').slice(0, 2000),
    autoMatched: !!input.autoMatched,
    status: 'pending',
    submittedAt: Timestamp.now(),
    reviewedBy: null,
    reviewedAt: null,
    rejectReason: null,
    approvedRecordIds: null,
  };

  await ref.set(data);
  return toClaim(ref.id, data);
}

export async function listMyClaims(uid: string): Promise<ClaimRequest[]> {
  const firestore = getAdminFirestore();
  // No orderBy here to avoid requiring a composite index — small result set
  // per user, sorted in memory.
  const snap = await firestore
    .collection(CLAIMS)
    .where('uid', '==', uid)
    .limit(200)
    .get();
  return snap.docs
    .map(d => toClaim(d.id, d.data() as StoredClaimRequest))
    .sort((a, b) => b.submittedAt - a.submittedAt);
}

export async function listPendingClaims(): Promise<ClaimRequest[]> {
  const firestore = getAdminFirestore();
  const snap = await firestore
    .collection(CLAIMS)
    .where('status', '==', 'pending')
    .limit(200)
    .get();
  return snap.docs
    .map(d => toClaim(d.id, d.data() as StoredClaimRequest))
    .sort((a, b) => a.submittedAt - b.submittedAt);
}

/** Hydrate a claim's target records so admins can see what's being claimed. */
export async function hydrateClaimRecords(
  targetRecordIds: string[],
): Promise<ClaimableRecord[]> {
  if (!targetRecordIds || targetRecordIds.length === 0) return [];

  // Group by gameId to minimize Firestore reads
  const byGame = new Map<string, string[]>();
  for (const rid of targetRecordIds) {
    const parsed = parseRecordId(rid);
    if (!parsed) continue;
    const list = byGame.get(parsed.gameId) ?? [];
    list.push(parsed.playerId);
    byGame.set(parsed.gameId, list);
  }

  const firestore = getAdminFirestore();
  const out: ClaimableRecord[] = [];
  for (const [gameId, playerIds] of byGame) {
    const doc = await firestore.collection(GAMES).doc(gameId).get();
    if (!doc.exists) continue;
    const game = doc.data() as GameRecord;
    if (!Array.isArray(game.players)) continue;
    for (const pid of playerIds) {
      const p = game.players.find(pl => pl.playerId === pid);
      if (!p) continue;
      out.push(gameToRecord(gameId, game, p));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Admin: approve / reject
// ---------------------------------------------------------------------------

/**
 * Approve a claim for the given subset of records.
 * Writes ownerUid into each games/{gameId}.players[i] row and marks the
 * claim approved. Uses a transaction per game document.
 */
export async function approveClaim(
  claimId: string,
  adminEmail: string,
  approvedRecordIds: string[],
): Promise<ClaimRequest> {
  const firestore = getAdminFirestore();
  const claimRef = firestore.collection(CLAIMS).doc(claimId);
  const claimSnap = await claimRef.get();
  if (!claimSnap.exists) throw new Error('Claim not found');
  const claim = claimSnap.data() as StoredClaimRequest;
  if (claim.status !== 'pending') {
    throw new Error(`Claim already ${claim.status}`);
  }

  // Only approve ids that are actually in the original target set
  const allowedSet = new Set(claim.targetRecordIds);
  const toApprove = approvedRecordIds.filter(id => allowedSet.has(id));
  if (toApprove.length === 0) {
    throw new Error('No valid records to approve');
  }

  // Group by gameId
  const byGame = new Map<string, string[]>();
  for (const rid of toApprove) {
    const parsed = parseRecordId(rid);
    if (!parsed) continue;
    const list = byGame.get(parsed.gameId) ?? [];
    list.push(parsed.playerId);
    byGame.set(parsed.gameId, list);
  }

  // Stamp ownerUid into each games doc
  for (const [gameId, playerIds] of byGame) {
    await firestore.runTransaction(async tx => {
      const gameRef = firestore.collection(GAMES).doc(gameId);
      const gSnap = await tx.get(gameRef);
      if (!gSnap.exists) return;
      const game = gSnap.data() as GameRecord;
      const players = Array.isArray(game.players) ? game.players : [];
      const updated = players.map(p => {
        if (playerIds.includes(p.playerId)) {
          return { ...p, ownerUid: claim.uid };
        }
        return p;
      });
      tx.update(gameRef, { players: updated });
    });
  }

  const reviewedAt = Timestamp.now();
  await claimRef.update({
    status: 'approved',
    reviewedBy: adminEmail,
    reviewedAt,
    approvedRecordIds: toApprove,
  });

  // Audit
  await writeAudit({
    action: 'approve',
    adminEmail,
    targetClaimId: claimId,
    targetRecordIds: toApprove,
    details: `uid=${claim.uid} displayName=${claim.displayName} count=${toApprove.length}`,
  });

  // Invalidate aggregate caches so ownership shows in profiles/leaderboards
  invalidateLeaderboardCache();

  return toClaim(claimId, {
    ...claim,
    status: 'approved',
    reviewedBy: adminEmail,
    reviewedAt,
    approvedRecordIds: toApprove,
  });
}

export async function rejectClaim(
  claimId: string,
  adminEmail: string,
  reason: string,
): Promise<ClaimRequest> {
  const firestore = getAdminFirestore();
  const claimRef = firestore.collection(CLAIMS).doc(claimId);
  const snap = await claimRef.get();
  if (!snap.exists) throw new Error('Claim not found');
  const claim = snap.data() as StoredClaimRequest;
  if (claim.status !== 'pending') {
    throw new Error(`Claim already ${claim.status}`);
  }

  const reviewedAt = Timestamp.now();
  const rejectReason = (reason ?? '').slice(0, 1000);
  await claimRef.update({
    status: 'rejected',
    reviewedBy: adminEmail,
    reviewedAt,
    rejectReason,
  });

  await writeAudit({
    action: 'reject',
    adminEmail,
    targetClaimId: claimId,
    targetRecordIds: claim.targetRecordIds,
    details: `reason=${rejectReason}`,
  });

  return toClaim(claimId, {
    ...claim,
    status: 'rejected',
    reviewedBy: adminEmail,
    reviewedAt,
    rejectReason,
  });
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function writeAudit(entry: Omit<AuditLogEntry, 'id' | 'ts'>): Promise<void> {
  try {
    const firestore = getAdminFirestore();
    const ref = firestore.collection(AUDIT).doc();
    await ref.set({
      ...entry,
      ts: Timestamp.now(),
    });
  } catch (err) {
    // Audit must never break the request; just log
    console.error('[claim-service] writeAudit failed:', err);
  }
}

export async function listAuditLog(limit = 100): Promise<AuditLogEntry[]> {
  try {
    const firestore = getAdminFirestore();
    const snap = await firestore
      .collection(AUDIT)
      .orderBy('ts', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map(d => {
      const data = d.data() as { action: AuditLogEntry['action']; adminEmail: string; targetClaimId?: string; targetRecordIds?: string[]; ts: Timestamp; details?: string };
      return {
        id: d.id,
        action: data.action,
        adminEmail: data.adminEmail,
        targetClaimId: data.targetClaimId,
        targetRecordIds: data.targetRecordIds,
        ts: tsToMillis(data.ts) ?? Date.now(),
        details: data.details,
      };
    });
  } catch (err) {
    console.error('[claim-service] listAuditLog failed:', err);
    return [];
  }
}
