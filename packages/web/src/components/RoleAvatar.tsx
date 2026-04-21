/**
 * RoleAvatar — circular character badge for each canonical Avalon role.
 *
 * Plan #83 Phase 4: replace plain text role names (梅林/派西維爾/...) with a
 * colored circle + single-character short code so players can scan rails,
 * reveal modals, and night-info panels at a glance.
 *
 * Good-team roles render on a blue fill, evil-team roles on a red fill, so
 * team alignment is encoded in both color and character. The component is
 * self-contained (pure Tailwind, no external SVG) and safe to nest anywhere
 * a role is known — callers should NOT pass another player's role when the
 * viewer is not entitled to know it (this would leak night-info).
 */
import type { Role } from '@avalon/shared';

interface RoleConfig {
  /** Single-character short code rendered inside the circle. */
  short: string;
  /** Team alignment — drives the background color. */
  team: 'good' | 'evil';
}

/**
 * Per-role visual config. Short codes are the last character of the Chinese
 * role name so players can match them back to the full name easily:
 *   梅林 → 梅, 派西維爾 → 派, 忠臣 → 忠,
 *   刺客 → 刺, 莫甘娜 → 娜, 莫德雷德 → 德,
 *   奧伯倫 → 奧, 爪牙 → 爪.
 */
const ROLE_CONFIG: Record<Role, RoleConfig> = {
  merlin:   { short: '梅', team: 'good' },
  percival: { short: '派', team: 'good' },
  loyal:    { short: '忠', team: 'good' },
  assassin: { short: '刺', team: 'evil' },
  morgana:  { short: '娜', team: 'evil' },
  mordred:  { short: '德', team: 'evil' },
  oberon:   { short: '奧', team: 'evil' },
  minion:   { short: '爪', team: 'evil' },
};

export type RoleAvatarSize = 'sm' | 'md' | 'lg';

export interface RoleAvatarProps {
  /** Role to display. MUST only be passed when the viewer is entitled to see it. */
  role: Role;
  /** Circle size. sm = 24px, md = 40px, lg = 64px. Default md. */
  size?: RoleAvatarSize;
  /** Extra Tailwind classes applied to the root circle. */
  className?: string;
  /**
   * When true, render the short-code character next to the circle as well
   * (used on the RoleRevealModal headline). When false (default), the short
   * code is visible inside the circle only.
   */
  showLabel?: boolean;
}

/**
 * Circular character badge for an Avalon role. See file-level docs for the
 * color + character mapping. Does NOT render anything if `role` is missing.
 */
export default function RoleAvatar({
  role,
  size = 'md',
  className,
  showLabel = false,
}: RoleAvatarProps): JSX.Element | null {
  const config = ROLE_CONFIG[role];
  if (!config) return null;

  const bgColor = config.team === 'good'
    ? 'bg-blue-600'
    : 'bg-red-600';
  const borderColor = config.team === 'good'
    ? 'border-blue-400'
    : 'border-red-400';

  const sizeClass =
    size === 'sm' ? 'w-6 h-6 text-[11px] border'
    : size === 'lg' ? 'w-16 h-16 text-2xl border-2'
    : 'w-10 h-10 text-base border-2';

  const labelSizeClass =
    size === 'sm' ? 'text-[11px]'
    : size === 'lg' ? 'text-lg'
    : 'text-sm';

  const circle = (
    <div
      className={`${sizeClass} ${bgColor} ${borderColor} rounded-full flex items-center justify-center font-bold text-white shadow-sm ${className ?? ''}`}
      aria-label={`角色 ${config.short}`}
    >
      {config.short}
    </div>
  );

  if (!showLabel) return circle;

  return (
    <div className="inline-flex items-center gap-2">
      {circle}
      <span className={`font-semibold text-white ${labelSizeClass}`}>{config.short}</span>
    </div>
  );
}

/** Exported so other components (e.g. tests, night-info panel) can reuse the
 *  team/short-code mapping without re-deriving it. */
export { ROLE_CONFIG };
