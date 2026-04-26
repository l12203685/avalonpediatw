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

/**
 * Build-time cache-bust suffix appended to every asset URL.
 *
 * Edward 2026-04-26 22:17 ROOT FIX「牌背圖反覆無法顯示」: prior to commit
 * `fbf4ae25` (18:04) the 4 corner asset JPEGs (leader-crown / mission-shield /
 * role-back / vote-back) were not committed, so Firebase Hosting answered any
 * `/avalon-assets/<missing>.jpg` request with the SPA fallback `index.html`.
 * Browsers that hit the page during that window cached **HTML bytes under a
 * `.jpg` URL** with `Cache-Control: public, max-age=86400` — every later
 * `<img src="/avalon-assets/role-back.jpg">` keeps re-using the broken disk
 * cache entry until 24h elapse OR the user manually clears cache. Even after
 * the fix shipped (commit `a4b4b5e0`/`fbf4ae25`/`8aa4683e`), Edward saw NO
 * change because his browser never refetched.
 *
 * The asset URLs are not Vite-hashed (they live under `public/`, not the build
 * pipeline), so `index-<hash>.js` busting alone doesn't reach them. Solution:
 * append `?v=<build-stamp>` so each build emits new image URLs, forcing a
 * fresh fetch and bypassing the poisoned cache entry. The stamp also lets
 * future asset swaps invalidate clients without manual action.
 *
 * `__BUILD_TIME__` is injected by `vite.config.ts:define` at build time
 * (`new Date().toISOString()` from the build host); falls back to `'dev'` in
 * test/SSR contexts where the global isn't set so unit tests stay readable.
 */
declare const __BUILD_TIME__: string;
const ASSET_VERSION = (() => {
  try {
    return typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'dev';
  } catch {
    return 'dev';
  }
})()
  // Strip non-URL-safe chars (colons / dots from ISO timestamp) so the
  // resulting query string is friendly to every CDN / origin we proxy through.
  .replace(/[^a-zA-Z0-9-]/g, '');
const VERSION_SUFFIX = ASSET_VERSION ? `?v=${ASSET_VERSION}` : '';

const ASSET_BASE = '/avalon-assets';
const withVersion = (path: string): string => `${path}${VERSION_SUFFIX}`;

/** Canonical role → painted avatar image URL (full-color, ~120-200 KB each). */
export const ROLE_AVATAR_IMAGES: Record<Role, string> = {
  merlin:   withVersion(`${ASSET_BASE}/role-merlin.jpg`),
  percival: withVersion(`${ASSET_BASE}/role-percival.jpg`),
  assassin: withVersion(`${ASSET_BASE}/role-assassin.jpg`),
  morgana:  withVersion(`${ASSET_BASE}/role-morgana.jpg`),
  mordred:  withVersion(`${ASSET_BASE}/role-mordred.jpg`),
  oberon:   withVersion(`${ASSET_BASE}/role-oberon.jpg`),
  // `loyal` uses one of 4 random variants — `getLoyalVariantUrl` is the
  // proper accessor; this entry exists for type-completeness and points to
  // variant 1 as a deterministic fallback when no playerId is available.
  loyal:    withVersion(`${ASSET_BASE}/role-loyal-1.jpg`),
  // `minion` is a legacy non-canonical role kept around for old replays;
  // aliased to assassin art so any straggler reference still renders
  // something meaningful instead of a broken image.
  minion:   withVersion(`${ASSET_BASE}/role-assassin.jpg`),
};

/** 4 雜魚 variants used when role is unknown OR when displaying generic 忠臣. */
export const LOYAL_VARIANT_URLS: readonly string[] = [
  withVersion(`${ASSET_BASE}/role-loyal-1.jpg`),
  withVersion(`${ASSET_BASE}/role-loyal-2.jpg`),
  withVersion(`${ASSET_BASE}/role-loyal-3.jpg`),
  withVersion(`${ASSET_BASE}/role-loyal-4.jpg`),
] as const;

/** Avatar shown when the viewer has no info on this seat (cover for unknowns). */
export const UNKNOWN_AVATAR_URL = withVersion(`${ASSET_BASE}/unknown.jpg`);

/** Team indicator art (used by night-info / role reveal accents). */
export const TEAM_INDICATORS = {
  good:    withVersion(`${ASSET_BASE}/team-good.jpg`),
  evil:    withVersion(`${ASSET_BASE}/team-evil.jpg`),
  unknown: withVersion(`${ASSET_BASE}/unknown.jpg`),
} as const;

/**
 * Camp/team emblem helper — Edward 2026-04-25 visual unification (21:52 revert
 * to canonical after a brief 19:40 lake-swap detour).
 *
 * Returns the painted shield art URL for a camp ('good' = blue dragon-gold-star
 * shield, 'evil' = red phoenix-silver-star shield). Use this anywhere a camp
 * indicator is shown (PlayerCard chip, MissionTrack circle, end-screen, etc.)
 * so callers don't have to reach into TEAM_INDICATORS directly. `CampDisc`
 * wraps this helper to clip just the central disc when the ornate star frame
 * would overpower a small inline glyph.
 *
 * Why a function: callers occasionally have `'good' | 'evil' | undefined` and a
 * helper is easier to type-check than ternary indexing into the const object.
 */
export function getCampImage(camp: 'good' | 'evil'): string {
  return camp === 'evil' ? TEAM_INDICATORS.evil : TEAM_INDICATORS.good;
}

/** End-screen winner cup. */
export const WINNER_CUPS = {
  good: withVersion(`${ASSET_BASE}/cup-good.jpg`),
  evil: withVersion(`${ASSET_BASE}/cup-evil.jpg`),
} as const;

/** Mission round result banners. */
export const QUEST_RESULT_IMAGES = {
  success: withVersion(`${ASSET_BASE}/quest-success.png`),
  fail:    withVersion(`${ASSET_BASE}/quest-fail.png`),
} as const;

/** Approve / reject vote-result art + ballot token. */
export const VOTE_IMAGES = {
  yes:   withVersion(`${ASSET_BASE}/vote-yes.jpg`),
  no:    withVersion(`${ASSET_BASE}/vote-no.jpg`),
  token: withVersion(`${ASSET_BASE}/vote-token.png`),
} as const;

/**
 * Vote-token helper — Edward 2026-04-25 vote-matrix swap.
 *
 * Returns the painted ballot art for an individual vote: 'approve' resolves to
 * the white-stone vote-yes image, 'reject' to the black-stone vote-no image.
 * Mirrors the physical Avalon table tokens (white = yes, black = no) so the
 * inline matrix glyphs match what players hand-place at the table.
 *
 * Why a function: callers in the matrix have a `boolean | undefined` (cast vote
 * vs no-vote), and the helper gives them a clean translation step instead of
 * inlining a ternary that reads VOTE_IMAGES directly.
 */
export function getVoteTokenImage(vote: 'approve' | 'reject'): string {
  return vote === 'approve' ? VOTE_IMAGES.yes : VOTE_IMAGES.no;
}

/**
 * Proposal-result helper — Edward 2026-04-25 vote-matrix swap.
 *
 * Returns the painted circular medallion for the proposal-pass / proposal-fail
 * column header in the vote matrix. Reuses the QUEST_RESULT_IMAGES art (success
 * = gold sun-burst circle, fail = red rune circle) because Edward's spec wants
 * the same "成功圓圈 / 失敗圓圈" visual vocabulary on every approve/reject toggle
 * across the app — proposals and missions share the same pass/fail glyph.
 */
export function getProposalResultImage(approved: boolean): string {
  return approved ? QUEST_RESULT_IMAGES.success : QUEST_RESULT_IMAGES.fail;
}

/** Lady-of-the-Lake icon. */
export const LAKE_IMAGE = withVersion(`${ASSET_BASE}/lake.jpg`);

/**
 * PlayerCard 4-corner indicator art — Edward 2026-04-25 20:05 redesign.
 *
 * The PlayerCard was changed from a circular avatar with floating mini-icons
 * to a full-square tile (`aspect-square`) where the portrait fills the entire
 * background and four corners surface state via painted icons:
 *   - top-left:    seat number (inline text, not an asset)
 *   - top-center:  leader crown    → `leader-crown.jpg`
 *   - top-right:   mission shield  → `mission-shield.jpg` (recoloured by border)
 *   - bottom-right: vote token     → `vote-back.jpg` (back) / vote-yes.jpg (approve) / vote-no.jpg (reject)
 *
 * The three new assets ship as ASCII-named JPGs under public/avalon-assets/
 * so the PlayerCard rewrite can reach them via the same registry as the role
 * portraits. Helpers below are tiny one-liners but exist for symmetry with
 * `getCampImage` / `getVoteTokenImage` so callers stay declarative.
 */
export const LEADER_CROWN_IMAGE = withVersion(`${ASSET_BASE}/leader-crown.jpg`);
export const MISSION_SHIELD_IMAGE = withVersion(`${ASSET_BASE}/mission-shield.jpg`);
export const VOTE_BACK_IMAGE = withVersion(`${ASSET_BASE}/vote-back.jpg`);
/**
 * Role-back card art — Edward 2026-04-25 20:12 spec.
 *
 * Used as the PlayerCard background for any seat whose role hasn't been
 * revealed to the viewer yet (`player.role === null` from the viewer's
 * perspective, including the 忠臣視角 blindfold). Replaces the painted
 * portrait so the rail reads like physical face-down cards on the table.
 *
 * Asset: 紫色 3 王冠旗幟卡背 (cp 自 `Q_unknown.jpg`).
 */
export const ROLE_BACK_IMAGE = withVersion(`${ASSET_BASE}/role-back.jpg`);

/** PlayerCard 隊長王冠 URL. */
export function getLeaderCrownUrl(): string {
  return LEADER_CROWN_IMAGE;
}

/** PlayerCard 任務盾牌 URL. */
export function getMissionShieldUrl(): string {
  return MISSION_SHIELD_IMAGE;
}

/** PlayerCard 投票球背面 (尚未揭曉時用). */
export function getVoteBackUrl(): string {
  return VOTE_BACK_IMAGE;
}

/**
 * PlayerCard 牌背 URL — 未揭角色 (`player.role === null` / 忠臣視角) 時整張
 * tile 用此圖取代大頭，配合「隱藏 corner indicators (除了 seat 號碼)」的隱身規則。
 */
export function getRoleBackUrl(): string {
  return ROLE_BACK_IMAGE;
}

/**
 * Lake-of-the-Lady icon URL — symmetry helper for the PlayerCard right-top
 * corner. Same asset as `LAKE_IMAGE`; named accessor exists so call sites
 * read declaratively (`getLakeImage()`) alongside the other corner helpers.
 */
export function getLakeImage(): string {
  return LAKE_IMAGE;
}

/** Per-table-size scoresheet board art (only 5..10 supplied). */
export function getBoardImage(playerCount: number): string | null {
  if (playerCount < 5 || playerCount > 10) return null;
  return withVersion(`${ASSET_BASE}/board-${playerCount}.jpg`);
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
