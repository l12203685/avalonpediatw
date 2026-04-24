/**
 * PublicChatPanel — Main-page (lobby) public chat (#63).
 *
 * Deliberately a separate component from `ChatPanel` (in-room chat) because
 *   a) the socket event channel differs (`lobby:*` vs `chat:*`)
 *   b) guest gating is unique to the public chat (read-only for guests)
 *   c) the layout is fixed-inline inside HomePage's right column, not floating
 *
 * Cross-platform sync (LINE / Discord) is intentionally NOT implemented —
 * that scope lives under task #82.
 */

import { useEffect, useRef, useState } from 'react';
import { Send, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getSocket } from '../services/socket';
import { useGameStore } from '../store/gameStore';
import AuthGateModal from './AuthGateModal';

// 2026-04-23 Edward 指令：鎖頭提示從靜態文字改成可點 CTA，
// 訪客點擊直接跳「系統設定 → 帳號綁定」區塊。模式與 SettingsPage
// 的 settings-btn-rename-or-bind 一致。不同點：從 Home 切到 Settings
// 是跨頁跳轉，SettingsPage 尚未 mount，單次 rAF 找不到 #settings-binding。
// 這裡用輕量重試（最多 500ms），等 Settings 掛上再 scroll。
function scrollToSettingsBinding(): void {
  const deadline = Date.now() + 500;
  const tick = (): void => {
    const el = document.getElementById('settings-binding');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    if (Date.now() < deadline) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

interface LobbyChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  message: string;
  timestamp: number;
  isSystem?: boolean;
  /**
   * #82: Platform that originated the message. When a message is mirrored from
   * LINE / Discord into the lobby we surface a small `[LINE]` / `[DC]` chip so
   * users can tell cross-platform traffic from native lobby chat. Absent /
   * `'lobby'` renders without a badge (self-origin, no noise).
   */
  source?: 'lobby' | 'line' | 'discord';
}

/** Chip label for a remote-origin message; null for lobby / unknown. */
function sourceBadgeLabel(source: LobbyChatMessage['source']): string | null {
  if (source === 'line') return '[LINE]';
  if (source === 'discord') return '[DC]';
  return null;
}

type LobbyErrorCode =
  | 'not-authenticated'
  | 'guest-read-only'
  | 'rate-limited'
  | 'invalid-message';

const MAX_LEN = 200;

export default function PublicChatPanel(): JSX.Element {
  const { t } = useTranslation();
  const { currentPlayer, addToast, setGameState } = useGameStore();
  const [messages, setMessages] = useState<LobbyChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [gateOpen, setGateOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Guest == read-only. Resolved from the currentPlayer provider flag set on
  // auth:success (see socket.ts). Falsy while the socket is still handshaking.
  const isGuest = currentPlayer?.provider === 'guest';
  const isAuthenticated = Boolean(currentPlayer);

  // Wire socket listeners. Re-runs only when the socket identity changes
  // (reconnects), keeping the handlers stable across message arrivals.
  useEffect(() => {
    let socket: ReturnType<typeof getSocket> | null = null;
    try {
      socket = getSocket();
    } catch {
      return; // Not connected yet — effect will re-run on player update.
    }

    const onSnapshot = (snapshot: LobbyChatMessage[]) => {
      setMessages(snapshot);
    };
    const onMessage = (msg: LobbyChatMessage) => {
      setMessages(prev => [...prev, msg]);
    };
    const onError = (code: LobbyErrorCode) => {
      const key: Record<LobbyErrorCode, string> = {
        'not-authenticated': 'home.lobbyChatErr.notAuth',
        'guest-read-only': 'home.lobbyChatErr.guest',
        'rate-limited': 'home.lobbyChatErr.rate',
        'invalid-message': 'home.lobbyChatErr.invalid',
      };
      addToast(t(key[code]), 'error');
    };

    socket.on('lobby:snapshot', onSnapshot);
    socket.on('lobby:message-received', onMessage);
    socket.on('lobby:error', onError);
    socket.emit('lobby:join');

    return () => {
      socket?.off('lobby:snapshot', onSnapshot);
      socket?.off('lobby:message-received', onMessage);
      socket?.off('lobby:error', onError);
    };
  }, [currentPlayer?.id, addToast, t]);

  // Auto-scroll the message list whenever it grows.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleSend = (): void => {
    const trimmed = input.trim();
    if (!trimmed || trimmed.length > MAX_LEN) return;
    if (!isAuthenticated || isGuest) return;
    try {
      getSocket().emit('lobby:send-message', trimmed);
      setInput('');
    } catch {
      addToast(t('home.lobbyChatErr.offline'), 'error');
    }
  };

  const placeholder = isGuest
    ? t('home.lobbyChatGuestPlaceholder')
    : t('home.lobbyChatInputPlaceholder');

  return (
    <div
      className="md:col-span-2 bg-zinc-900/60 border border-zinc-700 rounded-lg flex flex-col min-h-[280px] overflow-hidden"
      data-testid="public-chat-panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-700 bg-black/20">
        <h3 className="text-sm font-bold text-zinc-300 uppercase tracking-wider">
          {t('home.lobbyChat')}
        </h3>
        <span className="text-[10px] text-zinc-500">{messages.length}</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0 text-left">
        {messages.length === 0 && (
          <p className="text-center text-zinc-500 text-xs py-4">
            {t('home.lobbyChatEmpty')}
          </p>
        )}
        {messages.map(msg => {
          if (msg.isSystem) {
            return (
              <div key={msg.id} className="flex justify-center">
                <span className="text-xs text-zinc-500 bg-zinc-800/60 px-2 py-0.5 rounded-full italic">
                  {msg.message}
                </span>
              </div>
            );
          }
          const isMe = currentPlayer && msg.playerId === currentPlayer.id;
          const badge = sourceBadgeLabel(msg.source);
          return (
            <div
              key={msg.id}
              className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}
            >
              {!isMe && (
                <span className="text-xs text-zinc-500 mb-0.5 ml-1 flex items-center gap-1">
                  {badge && (
                    <span
                      className="text-[10px] font-semibold text-amber-400 tracking-wide"
                      data-testid={`lobby-chat-source-badge-${msg.source}`}
                    >
                      {badge}
                    </span>
                  )}
                  <span>{msg.playerName}</span>
                </span>
              )}
              <div
                className={`max-w-[85%] px-3 py-1.5 rounded-2xl text-sm break-words ${
                  isMe
                    ? 'bg-blue-600 text-white rounded-tr-sm'
                    : 'bg-zinc-700 text-zinc-100 rounded-tl-sm'
                }`}
              >
                {msg.message}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input — guest shows a clickable CTA that jumps to the binding section
          in SettingsPage. Previously static text + Lock icon looked like a bug
          because the explainer hinted at a resolution (register/sign-in) but
          had no affordance. Now the whole row acts like a link. */}
      {isGuest ? (
        <>
          <button
            type="button"
            onClick={() => setGateOpen(true)}
            title={t('chat.guestGateHint', { defaultValue: '點此登入帳號即可發言' })}
            aria-label={t('chat.guestGateHint', { defaultValue: '點此登入帳號即可發言' })}
            data-testid="public-chat-guest-cta"
            className="flex items-center gap-2 px-3 py-2 border-t border-zinc-700 bg-black/30 text-xs text-zinc-400 hover:bg-blue-900/30 hover:text-blue-200 transition-colors text-left w-full cursor-pointer underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          >
            <Lock size={12} />
            <span>{t('chat.guestPlaceholder', { defaultValue: '登入後即可發言…' })}</span>
          </button>
          <AuthGateModal
            isOpen={gateOpen}
            onClose={() => setGateOpen(false)}
            gateTarget="chat"
          />
        </>
      ) : (
        <div className="flex gap-2 p-2 border-t border-zinc-700">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            maxLength={MAX_LEN}
            placeholder={placeholder}
            disabled={!isAuthenticated}
            aria-label={t('home.lobbyChat')}
            className="flex-1 bg-zinc-800 border border-zinc-600 rounded-lg px-3 py-1.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500 disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || !isAuthenticated}
            className="p-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg text-white transition-colors"
            aria-label={t('home.lobbyChatSend')}
          >
            <Send size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
