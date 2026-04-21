/**
 * Scoresheet icon primitives — matches Edward's 2026-04-21 spec for the traditional
 * Avalon scoresheet (Phase 2 recolor).
 *
 * - ShieldIcon: 黃色盾牌，表示此座位被選進任務隊伍（parent sets `text-yellow-400`）
 * - ApproveMark: 白勾（parent sets `text-white`）
 * - RejectMark: 純黑方塊（parent sets `text-black`）
 * - QuestSuccessMark: 藍圓（parent sets `text-blue-500`）
 * - QuestFailMark: 紅圓（parent sets `text-red-500`）
 *
 * All icons are color-agnostic — they use `currentColor` so the parent component
 * controls the fill via Tailwind `text-*` classes. Sizes are also controlled by
 * parent `className` (手機 12-14px、桌面 16-18px).
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
 * Approve mark — white checkmark overlay (parent: `text-white`).
 * Rendered on top of a yellow shield cell to indicate "approve" vote.
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
 * Reject mark — solid black square overlay (parent: `text-black`).
 * Rendered on top of (potentially) yellow shield cell to indicate "reject" vote.
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
 * Success dot for quest row — blue circle (parent: `text-blue-500`).
 */
export function QuestSuccessMark({ className = '' }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

/**
 * Fail dot for quest row — red circle (parent: `text-red-500`).
 */
export function QuestFailMark({ className = '' }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}
