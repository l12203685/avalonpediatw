/**
 * Avalon image asset registry — Edward 2026-04-25 image batch.
 *
 * 27 hand-drawn images shipped under `web/public/avalon-assets/`:
 *   • role-{merlin,percival,assassin,morgana,mordred,oberon}.jpg → canonical role art
 *   • role-loyal-{1..4}.jpg → 4 雜魚 (generic loyal) avatar variants
 *   • team-{good,evil}.jpg / unknown.jpg → team-alignment indicator art
 *   • cup-{good,evil}.jpg → end-screen winner-side cup
 *   • quest-{success,fail}.png → mission outcome banners
 *   • vote-{yes,no}.jpg / vote-token.png → vote-result graphics
 *   • lake.jpg → Lady-of-the-Lake icon
 *   • board-{5..10}.jpg → per-table-size scoresheet board art
 *
 * The registry below maps each canonical Role + special asset to its public
 * URL so callers don't need to remember filenames. All paths are absolute
 * from the site root (works under both `/` and Vite's `base`).
 *
 * Why ASCII filenames: the source archive used Chinese filenames that
 * required URL encoding when fetched by browser; copying to ASCII names
 * removes the encoding hazard and makes the asset list greppable.
 */
import type { Role } from '@avalon/shared';

const ASSET_BASE = '/avalon-assets';

/** Canonical role → painted avatar image URL (full-color, ~120-200 KB each). */
export const ROLE_AVATAR_IMAGES: Record<Role, string> = {
  merlin:   `${ASSET_BASE}/role-merlin.jpg`,
  percival: `${ASSET_BASE}/role-percival.jpg`,
  assassin: `${ASSET_BASE}/role-assassin.jpg`,
  morgana:  `${ASSET_BASE}/role-morgana.jpg`,
  mordred:  `${ASSET_BASE}/role-mordred.jpg`,
  oberon:   `${ASSET_BASE}/role-oberon.jpg`,
  // `loyal` uses one of 4 random variants — `getLoyalVariantUrl` is the
  // proper accessor; this entry exists for type-completeness and points to
  // variant 1 as a deterministic fallback when no playerId is available.
  loyal:    `${ASSET_BASE}/role-loyal-1.jpg`,
  // `minion` is a legacy non-canonical role kept around for old replays;
  // aliased to assassin art so any straggler reference still renders
  // something meaningful instead of a broken image.
  minion:   `${ASSET_BASE}/role-assassin.jpg`,
};

/** 4 雜魚 variants used when role is unknown OR when displaying generic 忠臣. */
export const LOYAL_VARIANT_URLS: readonly string[] = [
  `${ASSET_BASE}/role-loyal-1.jpg`,
  `${ASSET_BASE}/role-loyal-2.jpg`,
  `${ASSET_BASE}/role-loyal-3.jpg`,
  `${ASSET_BASE}/role-loyal-4.jpg`,
] as const;

/** Avatar shown when the viewer has no info on this seat (cover for unknowns). */
export const UNKNOWN_AVATAR_URL = `${ASSET_BASE}/unknown.jpg`;

/** Team indicator art (used by night-info / role reveal accents). */
export const TEAM_INDICATORS = {
  good:    `${ASSET_BASE}/team-good.jpg`,
  evil:    `${ASSET_BASE}/team-evil.jpg`,
  unknown: `${ASSET_BASE}/unknown.jpg`,
} as const;

/** End-screen winner cup. */
export const WINNER_CUPS = {
  good: `${ASSET_BASE}/cup-good.jpg`,
  evil: `${ASSET_BASE}/cup-evil.jpg`,
} as const;

/** Mission round result banners. */
export const QUEST_RESULT_IMAGES = {
  success: `${ASSET_BASE}/quest-success.png`,
  fail:    `${ASSET_BASE}/quest-fail.png`,
} as const;

/** Approve / reject vote-result art + ballot token. */
export const VOTE_IMAGES = {
  yes:   `${ASSET_BASE}/vote-yes.jpg`,
  no:    `${ASSET_BASE}/vote-no.jpg`,
  token: `${ASSET_BASE}/vote-token.png`,
} as const;

/** Lady-of-the-Lake icon. */
export const LAKE_IMAGE = `${ASSET_BASE}/lake.jpg`;

/** Per-table-size scoresheet board art (only 5..10 supplied). */
export function getBoardImage(playerCount: number): string | null {
  if (playerCount < 5 || playerCount > 10) return null;
  return `${ASSET_BASE}/board-${playerCount}.jpg`;
}

/**
 * Stable, deterministic 雜魚 variant picker.
 *
 * Goal: when several players hide behind the generic 忠臣 avatar in the same
 * room, distribute them across the 4 variant images so the rail doesn't show
 * 4 identical faces. We hash the playerId (a stable opaque string) into the
 * 0..3 range so the same player always gets the same variant within a room
 * AND across re-renders, keeping the rail visually consistent.
 *
 * Note: this does NOT guarantee global uniqueness when room size > 4 — by the
 * pigeonhole principle, 5+ generic loyals must share a variant. The hash
 * spread is the best we can do without server-side coordination, and Edward's
 * spec explicitly accepts this ("avoid duplicate"; not "guarantee unique").
 *
 * @param playerId — the canonical player id (UUID-like string)
 * @returns a public URL pointing at one of the 4 雜魚 variants
 */
export function getLoyalVariantUrl(playerId: string): string {
  // Simple FNV-1a-style hash → modulo 4. Avoids importing a hash library.
  let hash = 2166136261;
  for (let i = 0; i < playerId.length; i += 1) {
    hash ^= playerId.charCodeAt(i);
    // Use Math.imul for 32-bit overflow semantics; * 16777619 is the FNV prime.
    hash = Math.imul(hash, 16777619);
  }
  // Force unsigned + modulo 4. `>>> 0` collapses the sign bit before %.
  const idx = (hash >>> 0) % LOYAL_VARIANT_URLS.length;
  return LOYAL_VARIANT_URLS[idx];
}

/**
 * Pick the right avatar URL for a player from the viewer's perspective.
 *
 * Decision tree:
 *   1. role known + canonical role mapping exists → painted role art
 *   2. role known === 'loyal'                     → deterministic 雜魚 variant
 *   3. role unknown                               → deterministic 雜魚 variant
 *      (we use 雜魚 instead of `unknown.jpg` because Edward's intent is
 *      "rail should show characters", and 雜魚 art reads as a generic
 *      person, while unknown.jpg is the explicit "?" indicator reserved
 *      for night-info / inspection cases.)
 *
 * @param role     — the viewer-known role for this seat (null = unknown)
 * @param playerId — the seat's canonical player id (used for stable hash)
 */
export function pickAvatarUrl(role: Role | null | undefined, playerId: string): string {
  if (role && role !== 'loyal' && role !== 'minion') {
    return ROLE_AVATAR_IMAGES[role];
  }
  // Both 'loyal' and unknown fall back to a stable 雜魚 variant.
  return getLoyalVariantUrl(playerId);
}
