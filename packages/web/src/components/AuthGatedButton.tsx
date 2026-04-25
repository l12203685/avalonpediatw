/**
 * AuthGatedButton — wraps a CTA so guests get the modal, authed users flow through.
 *
 * Design SSoT: staging/subagent_results/design_pregame_binding_2026-04-24.md
 * Task:        hineko_20260424_1040_ux_phase2_modal_badge
 *
 * Drop-in replacement for the button you'd normally write in HomePage:
 *
 *   <AuthGatedButton gateTarget="stats" onAuthedClick={gotoStats}>
 *     <Icon /> 個人戰績
 *   </AuthGatedButton>
 *
 * - Guest → opens <AuthGateModal gateTarget={...} /> and does NOT fire
 *   `onAuthedClick` until the user completes OAuth (which reloads).
 * - Authed → calls `onAuthedClick` synchronously.
 *
 * `isGuestPlayer` logic mirrors the SettingsPage helper so both surfaces
 * treat identity the same way.
 */

import { ReactNode, useState } from 'react';
import { useGameStore } from '../store/gameStore';
import AuthGateModal, { AuthGateTarget } from './AuthGateModal';

interface AuthGatedButtonProps {
  onAuthedClick: () => void;
  gateTarget: AuthGateTarget;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  'data-testid'?: string;
  title?: string;
}

function isGuestPlayer(player: { name?: string; provider?: string } | null | undefined): boolean {
  if (!player) return true;
  if (player.provider) return player.provider === 'guest';
  return /^Guest_\d{3,}$/i.test(player.name ?? '');
}

export default function AuthGatedButton({
  onAuthedClick,
  gateTarget,
  children,
  className,
  disabled,
  title,
  ...rest
}: AuthGatedButtonProps): JSX.Element {
  const { currentPlayer } = useGameStore();
  const [gateOpen, setGateOpen] = useState(false);
  const testId = rest['data-testid'];

  const handleClick = (): void => {
    if (isGuestPlayer(currentPlayer)) {
      setGateOpen(true);
      return;
    }
    onAuthedClick();
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        data-testid={testId}
        title={title}
        className={className}
      >
        {children}
      </button>
      <AuthGateModal
        isOpen={gateOpen}
        onClose={() => setGateOpen(false)}
        gateTarget={gateTarget}
      />
    </>
  );
}
