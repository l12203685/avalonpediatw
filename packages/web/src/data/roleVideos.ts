/**
 * Role video manifest — maps article/role IDs to R2 short video slugs.
 *
 * Phase 1 (current): Videos served from R2 public URL (pub-*.r2.dev).
 * Phase 2 (brand launch): switch baseUrl to media.avalonpediatw.com.
 *
 * Source of truth: content/_data/video_manifest.yaml
 * Upload script:   scripts/upload_videos_r2.py
 * R2 bucket:       avalonpediatw-media  (created post-M0.4 CF account)
 * Spike doc:       docs/M0.5_r2_spike.md
 *
 * GATED: R2_PUBLIC_BASE must be set as a Cloudflare Pages env var once the
 * bucket is live. Until then, videoUrl() returns null and RoleVideoCard
 * renders a "coming soon" placeholder rather than a broken player.
 */

export interface RoleVideo {
  /** Slug used as R2 object key under videos/shorts/<slug>.mp4 */
  slug: string;
  /** Chinese title shown in the UI */
  title_zh: string;
  /** Role identifier — matches keys in ROLE_STATS */
  role_tag: string;
  /** File size in bytes (for progress/placeholder sizing) */
  size_bytes: number;
}

/** All 6 canonical role short-videos (2023-10 production by Edward). */
export const ROLE_VIDEOS: RoleVideo[] = [
  {
    slug: 'merlin-importance',
    title_zh: '梅林有多重要',
    role_tag: 'merlin',
    size_bytes: 8_859_001,
  },
  {
    slug: 'percival-hard',
    title_zh: '派西維爾有多難分',
    role_tag: 'percival',
    size_bytes: 9_311_436,
  },
  {
    slug: 'assassin-key',
    title_zh: '刺客有多關鍵',
    role_tag: 'assassin',
    size_bytes: 8_581_494,
  },
  {
    slug: 'morgana-hard-to-play',
    title_zh: '莫甘娜有多難玩',
    role_tag: 'morgana',
    size_bytes: 9_787_433,
  },
  {
    slug: 'mordred-strong',
    title_zh: '莫德雷德有多強',
    role_tag: 'mordred',
    size_bytes: 8_554_551,
  },
  {
    slug: 'oberon-weak',
    title_zh: '奧伯倫到底有多爛',
    role_tag: 'oberon',
    size_bytes: 6_871_574,
  },
];

/** Lookup map: role_tag → RoleVideo */
export const VIDEO_BY_ROLE: Record<string, RoleVideo> = Object.fromEntries(
  ROLE_VIDEOS.map((v) => [v.role_tag, v]),
);

/**
 * Return the full video URL for a given slug, or null if the R2 base URL
 * is not yet configured (pre-M0.4 CF account creation).
 *
 * In production: set R2_PUBLIC_BASE as a CF Pages env var, e.g.
 *   https://pub-<hash>.r2.dev
 * or (Phase 2):
 *   https://media.avalonpediatw.com
 *
 * In Vite dev: set VITE_R2_PUBLIC_BASE in .env.local.
 */
export function videoUrl(slug: string): string | null {
  const base =
    // Vite exposes only VITE_* prefixed vars at runtime
    (import.meta as unknown as { env: Record<string, string | undefined> }).env
      ?.VITE_R2_PUBLIC_BASE ?? null;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/videos/shorts/${slug}.mp4`;
}
