import { useTranslation } from 'react-i18next';
import { Bot, LineChart, ListChecks, Shield, Sparkles, Swords } from 'lucide-react';
import { useGameStore, type GameState } from '../../store/gameStore';
import { clearAiGamesHash } from '../aiGames/aiGamesLink';
import { clearRecordsHash } from '../records/recordsLink';
import { clearWikiHash } from '../wikiLink';
import '../../i18n/aiKnights';
import { AI_KNIGHTS_NS } from '../../i18n/aiKnights';

/**
 * AI騎士團（站長 2026-11-26：「與百科AI有關 包括我剛剛提到的代理騎士擂台 全部挪到一個頁面下」）。
 *
 * 一個頁面、六個分頁；每個分頁還是原本那一頁（gameState 不變），所以舊連結 #ai-games、#ai-history、#arena、#collab、
 * #practice、#seat-filler 照樣打開對的分頁，新連結 #ai-knights 開「對局」。導覽列只剩一顆「AI騎士團」。
 *   對局     = 'aiGames'（AI騎士 在遊玩頁打的局＋每一步的理由、叫 AI騎士 補位）
 *   優化歷程 = 'aiHistory'
 *   擂台     = 'arena'（排行榜＋怎麼做自己的機器人）
 *   我的騎士 = 'myKnight'（代理騎士還在做：先放說明和連結）
 *   練習     = 'practice'（與 AI騎士 練習）
 *   一起改   = 'collab'（用你的 AI 一起改百科）
 */

export type AiKnightsTab = 'games' | 'history' | 'arena' | 'mine' | 'practice' | 'collab';

export const AI_KNIGHTS_TABS: readonly { tab: AiKnightsTab; state: GameState; Icon: typeof Bot }[] = [
  { tab: 'games', state: 'aiGames', Icon: ListChecks },
  { tab: 'history', state: 'aiHistory', Icon: LineChart },
  { tab: 'arena', state: 'arena', Icon: Swords },
  { tab: 'mine', state: 'myKnight', Icon: Shield },
  { tab: 'practice', state: 'practice', Icon: Bot },
  { tab: 'collab', state: 'collab', Icon: Sparkles },
];

/** 這一頁是 AI騎士團 的一個分頁嗎。 */
export function isAiKnightsState(state: GameState): boolean {
  return AI_KNIGHTS_TABS.some((t) => t.state === state);
}

/** 換到 AI騎士團 的某個分頁（清掉別頁留在網址上的 #ai-games=… 之類）。 */
export function openAiKnightsTab(state: GameState): void {
  clearAiGamesHash();
  clearRecordsHash();
  clearWikiHash();
  useGameStore.getState().setGameState(state);
  window.scrollTo({ top: 0 });
}

/** 頁首：名稱＋分頁（每個分頁上面都有；「對局」分頁多一段說明）。 */
export default function AiKnightsHub({ active }: { active: GameState }): JSX.Element {
  const { t } = useTranslation(AI_KNIGHTS_NS);
  const intro = active === 'aiGames';
  return (
    <div className="relative z-10 mx-auto max-w-4xl px-3 pt-3 text-white sm:px-4" data-testid="ai-knights-hub">
      <p className="flex items-center gap-2 text-base font-bold text-amber-200">
        <Shield size={18} className="text-amber-300" />{t('title')}
      </p>
      {intro && (
        <div className="mt-1 space-y-0.5 text-xs leading-relaxed text-zinc-300">
          <p>{t('intro')}</p>
          <p className="text-zinc-400">{t('names')}</p>
        </div>
      )}
      <div role="tablist" aria-label={t('tabsLabel')} className="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-zinc-900 p-1 min-[560px]:grid-cols-6">
        {AI_KNIGHTS_TABS.map(({ tab, state, Icon }) => {
          const on = state === active;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={on}
              data-testid={`ai-knights-tab-${tab}`}
              onClick={() => { if (!on) openAiKnightsTab(state); }}
              className={`flex min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-1 py-1.5 text-[13px] font-bold transition-colors ${
                on ? 'bg-white text-black' : 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
              }`}
            >
              <Icon size={14} className="flex-shrink-0" />
              {t(`tabs.${tab}`)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
