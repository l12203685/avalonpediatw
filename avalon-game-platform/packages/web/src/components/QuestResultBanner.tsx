import { QuestRecord } from '@avalon/shared';
import { QUEST_RESULT_IMAGES } from '../utils/avalonAssets';

/**
 * QuestResultBanner — top-of-scoresheet 5-block quest result strip.
 *
 * Edward 2026-04-25 image batch: each completed round renders the painted
 * success.png / fail.png banner; pending rounds keep the dim underscore
 * placeholder so the row reserves space until that round resolves.
 *
 *   [success.png] [fail.png] [success.png] [_] [_]
 *
 * Layout: equal-flex columns with min-width so a 5-round row spans the
 * scoresheet header without horizontal scroll on mobile.
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
  const rounds = Array.from({ length: maxRounds }, (_, i) => i + 1);
  return (
    <div
      className="w-full flex gap-1 sm:gap-2 px-1 py-1"
      data-testid="quest-result-banner"
    >
      {rounds.map((r) => {
        const rec = questHistory.find((q) => q.round === r);
        if (!rec) {
          return (
            <div
              key={r}
              className="flex-1 min-w-[40px] text-center text-xs font-mono py-2 rounded border bg-black/30 border-gray-700/40 text-gray-500"
              aria-label={`第 ${r} 輪 — 未進行`}
            >
              _
            </div>
          );
        }
        const isSuccess = rec.result === 'success';
        const tone = isSuccess
          ? 'bg-blue-900/40 border-blue-500/40'
          : 'bg-red-900/40 border-red-500/40';
        const imgSrc = isSuccess ? QUEST_RESULT_IMAGES.success : QUEST_RESULT_IMAGES.fail;
        return (
          <div
            key={r}
            className={`flex-1 min-w-[40px] flex items-center justify-center py-1 rounded border ${tone}`}
            aria-label={`第 ${r} 輪 — ${isSuccess ? '任務成功' : '任務失敗'}`}
          >
            <img
              src={imgSrc}
              alt={isSuccess ? '任務成功' : '任務失敗'}
              className="h-6 w-auto object-contain"
              loading="lazy"
              draggable={false}
            />
          </div>
        );
      })}
    </div>
  );
}

export { QuestResultBanner };
