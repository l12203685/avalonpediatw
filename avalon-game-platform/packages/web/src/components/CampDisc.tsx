/**
 * CampDisc — Edward 2026-04-25 disc-only camp indicator (21:52 revert).
 *
 * Renders the **central blue/red disc** clipped from `team-good.jpg` /
 * `team-evil.jpg` (the 紅藍方陣營卡, blue dragon for good, red phoenix for
 * evil) — Edward's 21:52 directive: "其他正義邪惡方的代表圖像 應該是紅藍方
 * 陣營卡中心的紅藍圓圈". This reverts the earlier 19:40 swap that briefly
 * routed CampDisc through the lake declaration card art (vote-yes/no.jpg).
 *
 * The lake-yes/lake-no painted discs remain in use ONLY for the actual lake
 * declaration tokens in the 湖宣告 phase (where players lie or tell the
 * truth about the lake's reading) — those are declaration tokens, not camp
 * emojis, and live outside CampDisc.
 *
 * Used wherever the camp is shown inline next to text (PlayerCard chip,
 * RoleCard header, MissionTrack glyph, RoleStatsCard chip, GamePage
 * end-screen, ProfilePage replay row, etc.) so every camp indicator
 * platform-wide reads with the same dragon/phoenix vocabulary.
 *
 * Why a wrapper component (not a CSS-only tweak): the source JPGs are
 * 254×410 portrait (dragon disc + 8-point gold/silver star frame). To
 * display only the central disc inside a small square box we need three
 * things together:
 *   1. `overflow-hidden` + `rounded-full` on a wrapper to crop a clean circle
 *   2. `object-cover` + `object-position` to center the disc in the box
 *   3. `transform: scale(...)` to zoom past the star points so the disc
 *      fills the circle (without zoom, the star frame leaks into corners
 *      after object-cover)
 *
 * Encoding all three in one component keeps the call sites compact:
 *   <CampDisc team={team} className="w-4 h-4" alt={t('faction.good')} />
 *
 * Tuning notes:
 *   - Disc center in the source art is at roughly (50%, 48%) of the JPG
 *   - scale(1.55) zooms past the gold/silver star points so only the
 *     blue/red disc + thin metallic ring are visible inside the circle clip
 *   - transformOrigin matches objectPosition so the zoom stays centered
 *     on the disc and doesn't drift off-frame at small sizes (12–20 px)
 */
import { getCampImage } from '../utils/avalonAssets';

interface CampDiscProps {
  /** Which camp to display ('good' = blue dragon disc, 'evil' = red phoenix disc). */
  team: 'good' | 'evil';
  /**
   * Tailwind size + spacing classes applied to the wrapper (e.g.
   * `"w-3.5 h-3.5 flex-shrink-0"`). Defaults to `"w-4 h-4"` for callers
   * who just want a sensible inline-text size.
   */
  className?: string;
  /**
   * Accessible alt text for the underlying `<img>`. When omitted (or empty)
   * the disc is treated as decorative (`aria-hidden="true"`), which is the
   * right call when the camp is also conveyed by adjacent text.
   */
  alt?: string;
}

export function CampDisc({ team, className = 'w-4 h-4', alt }: CampDiscProps) {
  const decorative = !alt;
  return (
    <span
      className={`inline-block overflow-hidden rounded-full ${className}`}
      style={{ flexShrink: 0 }}
    >
      <img
        src={getCampImage(team)}
        alt={decorative ? '' : alt}
        aria-hidden={decorative ? 'true' : undefined}
        className="w-full h-full"
        style={{
          objectFit: 'cover',
          objectPosition: '50% 48%',
          transform: 'scale(1.55)',
          transformOrigin: '50% 48%',
        }}
        draggable={false}
        loading="lazy"
      />
    </span>
  );
}
