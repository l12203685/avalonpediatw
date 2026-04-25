import { QuestRecord } from '@avalon/shared';

/**
 * QuestResultBanner — top-of-scoresheet 4-block quest result strip.
 *
 * 2026-04-25 stub: built to unblock the FullScoresheetLayout build chain
 * (commit 58f1b51a left dangling imports). Real implementation will render
 * one block per round (5 total) with O/X glyphs reflecting questHistory
 * outcomes, mirroring Edward's 2026-04-24 reference image:
 *
 *   [OXX] [OOOX] [OOOO] [OOOOO] [_]
 *
 * Renders a placeholder so layout reserves space. Replace with full impl
 * in the next scoresheet UI batch.
 */
interface QuestResultBannerProps {
  questHistory: QuestRecord[];
  playerCount: number;
  maxRounds: number;
}

export default function QuestResultBanner({
  questHistory,
  playerCount: _playerCount,
  maxRounds,
}: QuestResultBannerProps): JSX.Element {
  // Stub: render the 5 round blocks with success/fail markers so the row is
  // visually anchored even before the full glyph implementation lands.
  const rounds = Array.from({ length: maxRounds }, (_, i) => i + 1);
  return (
    <div
      className="w-full flex gap-1 sm:gap-2 px-1 py-1 overflow-x-auto"
      data-testid="quest-result-banner-stub"
    >
      {rounds.map((r) => {
        const rec = questHistory.find((q) => q.round === r);
        const label = rec ? (rec.result === 'success' ? 'O' : 'X') : '_';
        const tone = rec
          ? rec.result === 'success'
            ? 'bg-blue-900/40 border-blue-500/40 text-blue-200'
            : 'bg-red-900/40 border-red-500/40 text-red-200'
          : 'bg-black/30 border-gray-700/40 text-gray-500';
        return (
          <div
            key={r}
            className={`flex-1 min-w-[40px] text-center text-xs font-mono py-1 rounded border ${tone}`}
          >
            {label}
          </div>
        );
      })}
    </div>
  );
}

export { QuestResultBanner };
