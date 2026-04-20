/**
 * Scoresheet icon primitives — matches Edward's spec for the traditional Avalon scoresheet.
 *
 * - ShieldIcon: 藍色盾牌，表示此座位被選進任務隊伍（empty cell = 未被選中）
 * - ApproveMark: 白/藍勾，覆蓋在盾牌上表示投同意
 * - RejectMark: 黑色方塊，覆蓋在盾牌上表示投否決（無論是否被選進隊伍）
 *
 * 所有 icon 尺寸由父元件 className 控制（手機 12-14px、桌面 16-18px）。
 */

interface IconProps {
  className?: string;
}

export function ShieldIcon({ className = '' }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2L4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5l-8-3z" />
    </svg>
  );
}

/**
 * Approve mark — white/blue checkmark overlay.
 * Rendered on top of a blue shield cell to indicate "approve" vote.
 * If no shield (not on team), still shown centered with no background.
 */
export function ApproveMark({ className = '' }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="3.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="5,13 10,18 19,7" />
    </svg>
  );
}

/**
 * Reject mark — solid black square overlay.
 * Rendered on top of (potentially) blue shield cell to indicate "reject" vote.
 */
export function RejectMark({ className = '' }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
    </svg>
  );
}

/**
 * Success dot for quest row — white circle.
 */
export function QuestSuccessMark({ className = '' }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

/**
 * Fail dot for quest row — black circle with red ring.
 */
export function QuestFailMark({ className = '' }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}
