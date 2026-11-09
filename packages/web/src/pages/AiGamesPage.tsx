import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, Bot, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import AiGameReviewPanel from '../components/aiGames/AiGameReviewPanel';
import { closeAiGame, openAiGame, useOpenAiGame } from '../components/aiGames/aiGamesLink';
import { aiGamesErrorText, fetchAiGame, fetchAiGames } from '../services/aiGames';
import { parseAiGameName, type AiGameListItem, type AiGameTrace } from '../utils/aiGames';

/**
 * 百科AI 對局（Edward 2026-11-05：「剛剛玩的那場模擬局有紀錄嗎? 我想對百科AI的一些行動跟投票作回饋 像這樣回饋的功能可不可以寫在網站上
 * 或是只要有百科AI參與的牌局就自動記錄在網站&DC上 我們可以直接針對AI的動作作反饋?」）。
 *
 * 百科AI 在遊玩頁打的每一局，打完後自動貼到 DC 論壇 #牌譜紀錄與覆盤（一局一篇，2026-11-09 起；舊的 #百科問題回報 已刪除）；這頁從伺服器讀那些貼文：
 * 清單 → 點一局 → 回顧（每個百科AI 決定附理由，每一步可以按「這步怪怪的」，回饋貼成那篇 DC 討論串的回覆）。不用登入。
 * 網址：#ai-games（清單）、#ai-games=<DC 討論串 id>（直接打開那一局；DC 貼文最後一則附這個網址）。
 */

/** DC 論壇 #牌譜紀錄與覆盤。 */
const PAIPU_FORUM_URL = 'https://discord.com/channels/1132682489840812113/1132683080134578276';

type ListState = { state: 'loading' } | { state: 'ready'; games: AiGameListItem[]; stale: boolean } | { state: 'failed'; error: string };
type GameState = { state: 'loading' } | { state: 'ready'; trace: AiGameTrace; url: string } | { state: 'failed'; error: string };

export default function AiGamesPage(): JSX.Element {
  const openId = useOpenAiGame();
  return (
    <div className="relative z-10 mx-auto max-w-4xl px-3 py-4 sm:px-4 text-white">
      {/* key：換一局時狀態重來 */}
      {openId ? <GameView key={openId} id={openId} /> : <ListView />}
    </div>
  );
}

function ListView(): JSX.Element {
  const [list, setList] = useState<ListState>({ state: 'loading' });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetchAiGames()
      .then((r) => { if (!cancelled) setList({ state: 'ready', games: r.games, stale: r.stale }); })
      .catch((err: unknown) => { if (!cancelled) setList({ state: 'failed', error: aiGamesErrorText(err) }); });
    return (): void => { cancelled = true; };
  }, [reload]);

  return (
    <div className="space-y-3">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-bold"><Bot size={20} className="text-amber-300" />百科AI 對局</h1>
        <p className="text-xs leading-relaxed text-zinc-300">
          百科AI 在遊玩頁打的每一局，打完後自動記錄在這裡和 DC
          <a href={PAIPU_FORUM_URL} target="_blank" rel="noopener noreferrer" className="mx-1 text-emerald-300 underline underline-offset-2">#牌譜紀錄與覆盤</a>
          （標題有「含百科機器人」）。點一局可以看百科AI 每個派隊、投票、任務、湖、刺殺的理由；覺得哪一步怪，按「這步怪怪的」寫原因，會貼到那篇 DC 討論串。
        </p>
      </header>
      {list.state === 'loading' && (
        <p className="inline-flex items-center gap-2 py-8 text-sm text-zinc-300"><Loader2 size={16} className="animate-spin" />讀取中…（伺服器剛喚醒時要等 30–60 秒）</p>
      )}
      {list.state === 'failed' && (
        <div className="space-y-2 py-6 text-sm">
          <p className="inline-flex items-center gap-1.5 text-rose-300"><AlertTriangle size={15} />{list.error}</p>
          <button type="button" onClick={() => { setList({ state: 'loading' }); setReload((n) => n + 1); }} className="inline-flex items-center gap-1 rounded-lg border border-zinc-600 px-3 py-1.5 text-xs hover:bg-zinc-800">
            <RefreshCw size={13} />重新讀取
          </button>
        </div>
      )}
      {list.state === 'ready' && (
        <>
          {list.stale && <p className="text-[11px] text-amber-300/90">DC 暫時讀不到，顯示的是稍早的清單</p>}
          {list.games.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-400">還沒有百科AI 對局</p>
          ) : (
            <ul data-testid="ai-games-list" className="divide-y divide-zinc-800 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/70">
              {list.games.map((g) => {
                const { when, where } = parseAiGameName(g.name);
                return (
                  <li key={g.id}>
                    <button
                      type="button"
                      onClick={() => { openAiGame(g.id); window.scrollTo({ top: 0 }); }}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-zinc-800/70"
                    >
                      <span className="w-[7.5rem] flex-shrink-0 font-mono text-[12px] text-zinc-400">{when || g.createdAt.slice(0, 10)}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">{where || g.name}</span>
                      <ChevronRight size={16} className="flex-shrink-0 text-zinc-500" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function GameView({ id }: { id: string }): JSX.Element {
  const [game, setGame] = useState<GameState>({ state: 'loading' });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetchAiGame(id)
      .then((r) => { if (!cancelled) setGame({ state: 'ready', trace: r.trace, url: r.thread.url }); })
      .catch((err: unknown) => { if (!cancelled) setGame({ state: 'failed', error: aiGamesErrorText(err) }); });
    return (): void => { cancelled = true; };
  }, [id, reload]);

  return (
    <div className="space-y-3">
      <button type="button" onClick={closeAiGame} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800">
        <ArrowLeft size={14} />百科AI 對局清單
      </button>
      {game.state === 'loading' && (
        <p className="inline-flex items-center gap-2 py-8 text-sm text-zinc-300"><Loader2 size={16} className="animate-spin" />讀取中…</p>
      )}
      {game.state === 'failed' && (
        <div className="space-y-2 py-6 text-sm">
          <p className="inline-flex items-center gap-1.5 text-rose-300"><AlertTriangle size={15} />{game.error}</p>
          <button type="button" onClick={() => { setGame({ state: 'loading' }); setReload((n) => n + 1); }} className="inline-flex items-center gap-1 rounded-lg border border-zinc-600 px-3 py-1.5 text-xs hover:bg-zinc-800">
            <RefreshCw size={13} />重新讀取
          </button>
        </div>
      )}
      {game.state === 'ready' && <AiGameReviewPanel threadId={id} trace={game.trace} discordUrl={game.url} />}
    </div>
  );
}
