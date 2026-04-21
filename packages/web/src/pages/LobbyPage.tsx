import { useState, useEffect, useRef } from 'react';
import { useGameStore } from '../store/gameStore';
import { kickPlayer, addBot, removeBot, leaveRoom, setMaxPlayers, setRoleOptions, toggleReady, setRoomPassword, startGame } from '../services/socket';
import { Users, Play, Copy, Check, Link, X, Bot, LogOut, ChevronUp, ChevronDown, Lock, Unlock, ArrowLeft, Clock } from 'lucide-react';
import { AVALON_CONFIG } from '@avalon/shared';

// Friendly label for the room-level thinking-time multiplier.
function timerLabel(multiplier: number | null | undefined): string {
  if (multiplier === null) return '無限 (不計時)';
  if (multiplier === 0.5) return '0.5x (加速)';
  if (multiplier === 1.5) return '1.5x';
  if (multiplier === 2) return '2x (慢節奏)';
  return '1x (標準)';
}
import ChatPanel from '../components/ChatPanel';

const LOBBY_TIMEOUT_MS = 12_000; // 12 seconds to receive room state

const ROLE_LABEL: Record<string, string> = {
  merlin: '梅林', percival: '派西維爾', loyal: '忠臣',
  assassin: '刺客', morgana: '莫甘娜', oberon: '奧伯倫', mordred: '莫德雷德', minion: '爪牙',
};
const GOOD_ROLES = new Set(['merlin', 'percival', 'loyal']);

// Describe what enabling each optional role does
const ROLE_OPTION_INFO: Record<string, { label: string; description: string; paired?: string }> = {
  percival: { label: '派西維爾', description: '派西維爾看到梅林（以及莫甘娜，若啟用）', paired: 'morgana' },
  morgana:  { label: '莫甘娜',   description: '莫甘娜偽裝成梅林，混淆派西維爾',        paired: 'percival' },
  mordred:  { label: '莫德雷德', description: '莫德雷德對梅林隱形，危險的隱藏邪惡' },
  oberon:   { label: '奧伯倫',   description: '奧伯倫對邪惡陣營隱形（孤獨邪惡）' },
};

export default function LobbyPage(): JSX.Element {
  const { room, currentPlayer, setGameState, addToast } = useGameStore();
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const [showPasswordInput, setShowPasswordInput] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [timedOut, setTimedOut] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Timeout: if room state never arrives, let the user go back
  useEffect(() => {
    if (room) {
      // Room arrived — clear any pending timeout
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      setTimedOut(false);
      return;
    }
    timerRef.current = setTimeout(() => setTimedOut(true), LOBBY_TIMEOUT_MS);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [room]);

  if (!room || !currentPlayer) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4 text-white">
        {timedOut ? (
          <>
            <p className="text-red-400 font-semibold">
              連線逾時 — 伺服器未回應房間資料 (Connection timed out)
            </p>
            <p className="text-sm text-gray-400">
              可能原因：伺服器冷啟動中、網路不穩、或 WebSocket 連線失敗
            </p>
            <button
              onClick={() => { addToast('已返回首頁', 'info'); setGameState('home'); }}
              className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white font-bold py-2 px-6 rounded-lg transition-colors"
            >
              <ArrowLeft size={16} />
              返回首頁 (Back to Home)
            </button>
          </>
        ) : (
          <>
            <div className="inline-block animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-blue-400" />
            <p>連線中... (Connecting to room...)</p>
            <button
              onClick={() => setGameState('home')}
              className="mt-2 text-sm text-gray-500 hover:text-gray-300 transition-colors underline"
            >
              取消 (Cancel)
            </button>
          </>
        )}
      </div>
    );
  }

  const playerList = Object.values(room.players);
  const isHost = room.host === currentPlayer.id;
  const canStart = playerList.length >= 5;
  const readyIds = room.readyPlayerIds ?? [];
  const isReady = readyIds.includes(currentPlayer.id);
  const humanPlayers = playerList.filter(p => !p.isBot && p.id !== room.host);
  const readyCount = humanPlayers.filter(p => readyIds.includes(p.id)).length;
  const shortCode = room.id.slice(0, 8).toUpperCase();

  // Role preview based on current player count
  const previewConfig = AVALON_CONFIG[playerList.length];
  const is9Variant = playerList.length === 9
    && (room.roleOptions as unknown as Record<string, string>)?.variant9Player === 'oberonMandatory';
  // Apply roleOptions to get effective role list for preview. The
  // 9-player variant replaces the standard 6G/3E split with 5G/4E +
  // mandatory Oberon, matching GameEngine.assignRoles semantics.
  const previewRoles: string[] = is9Variant
    ? ['merlin', 'percival', 'loyal', 'loyal', 'loyal',
       'assassin', 'morgana', 'mordred', 'oberon']
    : (previewConfig?.roles as unknown as string[] ?? []);
  const effectiveRoles = previewRoles.map(r => {
    if (r === 'percival' && !room.roleOptions?.percival) return 'loyal';
    if (r === 'morgana'  && !room.roleOptions?.morgana)  return 'minion';
    // 9-variant forces Oberon regardless of the toggle
    if (r === 'oberon'   && !room.roleOptions?.oberon && !is9Variant) return 'minion';
    if (r === 'mordred'  && !room.roleOptions?.mordred)  return 'minion';
    return r;
  });
  const goodRoles  = effectiveRoles.filter(r => GOOD_ROLES.has(r));
  const evilRoles  = effectiveRoles.filter(r => !GOOD_ROLES.has(r));

  // Effective quest sizes preview for the scoresheet ribbon (honours
  // swapR1R2 + 9-variant, matching GameEngine.computeEffectiveQuestSizes).
  const previewQuestSizes: number[] = (() => {
    if (!previewConfig) return [];
    let sizes = is9Variant ? [4, 3, 4, 5, 5] : [...previewConfig.questTeams];
    if (room.roleOptions?.swapR1R2 && sizes.length >= 2) {
      const t = sizes[0]; sizes[0] = sizes[1]; sizes[1] = t;
    }
    return sizes;
  })();

  const handleToggleRole = (key: string) => {
    if (!room.roleOptions) return;
    const opts = (room.roleOptions as unknown) as Record<string, boolean>;
    const newVal = !opts[key];
    // Percival and Morgana are paired — toggle together
    const info = ROLE_OPTION_INFO[key];
    const updates: Record<string, boolean> = { [key]: newVal };
    if (info.paired) updates[info.paired] = newVal;
    setRoleOptions(room.id, updates);
  };

  // Advanced toggles (#90) — generic single-key boolean flip with no pairing.
  const handleToggleAdvanced = (key: string) => {
    if (!room.roleOptions) return;
    const opts = (room.roleOptions as unknown) as Record<string, unknown>;
    const newVal = !Boolean(opts[key]);
    setRoleOptions(room.id, { [key]: newVal });
  };

  // Advanced enum controls (variant9Player / ladyStart).
  const handleSelectAdvanced = (key: string, value: string) => {
    setRoleOptions(room.id, { [key]: value });
  };

  // #90 Part 2 — UI-side "canonical default" for Lady of the Lake: when
  // the host has NOT explicitly set ladyOfTheLake (undefined), and the
  // table is 7+ players AND Mordred is enabled, the pre-check should be
  // ON. Explicit false wins — we only auto-derive when the field is
  // untouched. Checking `typeof ... === 'undefined'` keeps the
  // "intentional off" signal working.
  const ladyFieldUndefined = typeof ((room.roleOptions as unknown) as Record<string, unknown>)?.ladyOfTheLake === 'undefined';
  const ladyDefaultOn = ladyFieldUndefined && playerList.length >= 7 && Boolean(room.roleOptions?.mordred);
  const ladyChecked = ladyFieldUndefined
    ? ladyDefaultOn
    : Boolean(room.roleOptions?.ladyOfTheLake);

  const handleCopyRoomId = () => {
    navigator.clipboard.writeText(shortCode).then(() => {
      setCopied('code');
      setTimeout(() => setCopied(null), 2000);
    });
  };

  const handleCopyLink = () => {
    const link = `${window.location.origin}/?room=${shortCode}`;
    navigator.clipboard.writeText(link).then(() => {
      setCopied('link');
      setTimeout(() => setCopied(null), 2000);
    });
  };

  return (
    <>
    <div className="flex items-center justify-center min-h-screen p-4">
      <div className="w-full max-w-2xl space-y-6">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-3">{room.name}</h1>

          {/* Room ID with copy buttons */}
          <div className="inline-flex items-center gap-2 sm:gap-3 bg-avalon-card/50 border border-gray-600 rounded-xl px-3 sm:px-5 py-2 sm:py-3">
            <div className="text-left">
              <p className="text-[10px] sm:text-xs text-gray-500 mb-0.5 sm:mb-1">房間代碼 (Room Code — share with friends)</p>
              <p className="text-base sm:text-lg font-mono font-bold text-yellow-400 tracking-widest">{shortCode}</p>
            </div>
            <button
              onClick={handleCopyRoomId}
              className={`flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1.5 sm:py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
                copied === 'code'
                  ? 'bg-blue-700/60 text-blue-300 border border-blue-600'
                  : 'bg-gray-700/60 hover:bg-gray-600/60 text-gray-300 border border-gray-600'
              }`}
            >
              {copied === 'code' ? <Check size={14} /> : <Copy size={14} />}
              {copied === 'code' ? '已複製！' : '複製'}
            </button>
            <button
              onClick={handleCopyLink}
              className={`flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1.5 sm:py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
                copied === 'link'
                  ? 'bg-amber-700/60 text-amber-300 border border-amber-600'
                  : 'bg-blue-700/60 hover:bg-blue-600/60 text-blue-300 border border-blue-600'
              }`}
              title="複製邀請連結 (Copy invite link)"
            >
              {copied === 'link' ? <Check size={14} /> : <Link size={14} />}
              {copied === 'link' ? '已複製！' : '邀請連結 (Invite Link)'}
            </button>
          </div>
        </div>

        {/* Role configuration + preview */}
        {previewConfig && (
          <div className="bg-avalon-card/30 border border-gray-700 rounded-xl px-4 py-3 space-y-3">
            {/* Optional role toggles (host only) */}
            {isHost && (
              <div>
                <p className="text-xs text-gray-500 mb-2 font-semibold uppercase tracking-wider">特殊角色設定 (Role Configuration)</p>
                <div className="grid grid-cols-2 gap-2">
                  {(Object.keys(ROLE_OPTION_INFO) as (keyof typeof ROLE_OPTION_INFO)[]).map(key => {
                    const info = ROLE_OPTION_INFO[key];
                    const enabled = Boolean(((room.roleOptions as unknown) as Record<string, boolean>)?.[key]);
                    // Skip paired role (morgana is controlled by percival toggle)
                    if (key === 'morgana') return null;
                    return (
                      <button
                        key={key}
                        onClick={() => handleToggleRole(key)}
                        className={`text-left px-3 py-2 rounded-lg border text-xs transition-all ${
                          enabled
                            ? 'bg-amber-900/40 border-amber-600 text-amber-200'
                            : 'bg-gray-800/40 border-gray-700 text-gray-500 hover:border-gray-500'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="font-bold">
                            {key === 'percival' ? '派西維爾 + 莫甘娜' : info.label}
                          </span>
                          <span className={`text-xs font-bold ${enabled ? 'text-amber-400' : 'text-gray-600'}`}>
                            {enabled ? '開' : '關'}
                          </span>
                        </div>
                        <p className="text-gray-500 text-xs leading-tight">{info.description}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* #90 Advanced rule options (host only) */}
            {isHost && (
              <div>
                <p className="text-xs text-gray-500 mb-2 font-semibold uppercase tracking-wider">
                  進階規則 (Advanced Rules)
                </p>
                <div className="space-y-2">
                  {/* Lady of the Lake enable + starting seat */}
                  <div className="bg-gray-800/40 border border-gray-700 rounded-lg px-3 py-2">
                    <label className="flex items-center justify-between cursor-pointer">
                      <div className="flex-1 pr-3">
                        <div className="text-sm font-bold text-white">湖中女神 (Lady of the Lake)</div>
                        <p className="text-xs text-gray-500 leading-tight mt-0.5">
                          任務 2 起輪流互查陣營；可公開宣告或保持沉默
                          {ladyFieldUndefined && ladyDefaultOn && (
                            <span className="text-amber-400 ml-1">(預設開啟：7+ 人且啟用莫德雷德)</span>
                          )}
                        </p>
                      </div>
                      <input
                        type="checkbox"
                        checked={ladyChecked}
                        onChange={() => {
                          // First interaction solidifies the field — send
                          // the current resolved value flipped.
                          setRoleOptions(room.id, { ladyOfTheLake: !ladyChecked });
                        }}
                        className="w-5 h-5 accent-amber-500 flex-shrink-0"
                      />
                    </label>

                    {ladyChecked && playerList.length >= 7 && (
                      <div className="mt-2 pt-2 border-t border-gray-700/60">
                        <p className="text-xs text-gray-500 mb-1.5">起始湖女持有者 (Starting holder)</p>
                        <select
                          value={(room.roleOptions as unknown as Record<string, string>)?.ladyStart ?? 'random'}
                          onChange={e => handleSelectAdvanced('ladyStart', e.target.value)}
                          className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-amber-500"
                        >
                          <option value="random">隨機 (Random)</option>
                          <option value="seat0">隊長右手邊 (Seat 0 · Leader's right)</option>
                          {Array.from({ length: playerList.length }, (_, i) => (
                            <option key={i + 1} value={`seat${i + 1}`}>
                              座位 {i + 1} ({playerList[i]?.name ?? '—'})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>

                  {/* R1/R2 quest size swap */}
                  <label className="flex items-center justify-between bg-gray-800/40 border border-gray-700 rounded-lg px-3 py-2 cursor-pointer">
                    <div className="flex-1 pr-3">
                      <div className="text-sm font-bold text-white">第 1/2 輪人數對調 (Swap R1/R2)</div>
                      <p className="text-xs text-gray-500 leading-tight mt-0.5">
                        交換第一、二輪任務所需人數（例如 2/3 → 3/2）
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      checked={Boolean(room.roleOptions?.swapR1R2)}
                      onChange={() => handleToggleAdvanced('swapR1R2')}
                      className="w-5 h-5 accent-amber-500 flex-shrink-0"
                    />
                  </label>

                  {/* Oberon must always fail — applies whenever Oberon is in
                      play (canonical evil toggle or 9-variant forces him in).
                      Default OFF so vanilla Avalon is unchanged. */}
                  <label className="flex items-center justify-between bg-gray-800/40 border border-gray-700 rounded-lg px-3 py-2 cursor-pointer">
                    <div className="flex-1 pr-3">
                      <div className="text-sm font-bold text-white">奧伯倫必出失敗 (Oberon Must Fail)</div>
                      <p className="text-xs text-gray-500 leading-tight mt-0.5">
                        開啟後任務階段奧伯倫強制投出失敗票，無論 AI 或真人（介面僅顯示失敗按鈕）
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      checked={Boolean((room.roleOptions as unknown as Record<string, boolean>)?.oberonAlwaysFail)}
                      onChange={() => handleToggleAdvanced('oberonAlwaysFail')}
                      className="w-5 h-5 accent-amber-500 flex-shrink-0"
                    />
                  </label>

                  {/* 9-player variant (only shown for 9-player tables) */}
                  {playerList.length === 9 && (
                    <div className="bg-gray-800/40 border border-gray-700 rounded-lg px-3 py-2 space-y-2">
                      <div>
                        <p className="text-sm font-bold text-white mb-1">9 人局變體 (9-Player Variant)</p>
                        <p className="text-xs text-gray-500 leading-tight mb-2">
                          奧伯倫強制版：5 好 4 壞、強制加入奧伯倫、任務人數改為 4/3/4/5/5
                        </p>
                        <select
                          value={(room.roleOptions as unknown as Record<string, string>)?.variant9Player ?? 'standard'}
                          onChange={e => handleSelectAdvanced('variant9Player', e.target.value)}
                          className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-amber-500"
                        >
                          <option value="standard">標準 (Standard · 6 好 3 壞)</option>
                          <option value="oberonMandatory">奧伯倫強制 (Oberon mandatory · 5 好 4 壞)</option>
                        </select>
                      </div>

                      {/* Option 2 — inverted protection. Only enabled when
                          variant9Player === 'oberonMandatory'. Server also
                          auto-clears the flag when reverting to 'standard'
                          so the stale-state risk is belt + braces. */}
                      {(() => {
                        const v9 = (room.roleOptions as unknown as Record<string, string>)?.variant9Player;
                        const v9Enabled = v9 === 'oberonMandatory';
                        const v9Opt2 = Boolean((room.roleOptions as unknown as Record<string, boolean>)?.variant9Option2);
                        return (
                          <label
                            className={`flex items-center justify-between bg-gray-900/60 border rounded px-3 py-2 ${
                              v9Enabled ? 'cursor-pointer border-gray-600' : 'cursor-not-allowed border-gray-800 opacity-50'
                            }`}
                          >
                            <div className="flex-1 pr-3">
                              <div className="text-sm font-bold text-white">
                                保護局反轉模式 (Inverted Protection)
                              </div>
                              <p className="text-xs text-gray-500 leading-tight mt-0.5">
                                僅限奧伯倫強制版。第 1/2/3/5 局「恰好 1 張失敗 = 任務失敗」，2+ 張失敗反而成功；第 4 局（保護局）維持原規則
                              </p>
                            </div>
                            <input
                              type="checkbox"
                              checked={v9Enabled && v9Opt2}
                              disabled={!v9Enabled}
                              onChange={() => {
                                if (!v9Enabled) return;
                                handleToggleAdvanced('variant9Option2');
                              }}
                              className="w-5 h-5 accent-amber-500 flex-shrink-0"
                            />
                          </label>
                        );
                      })()}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Password lock (host only) */}
            {isHost && (
              <div>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-gray-500 font-semibold uppercase tracking-wider">房間密碼 (Room Password)</p>
                  <button
                    onClick={() => {
                      if (room.isPrivate) {
                        setRoomPassword(room.id, null);
                      } else {
                        setShowPasswordInput(v => !v);
                      }
                    }}
                    className={`flex items-center gap-1 text-xs px-2 py-1 rounded-lg border transition-colors ${
                      room.isPrivate
                        ? 'bg-yellow-900/40 border-yellow-600 text-yellow-300 hover:bg-yellow-900/60'
                        : 'bg-gray-800/40 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white'
                    }`}
                  >
                    {room.isPrivate ? <><Lock size={11} /> 已加密 — 點擊解鎖</> : <><Unlock size={11} /> 公開 — 點擊設定密碼</>}
                  </button>
                </div>
                {showPasswordInput && !room.isPrivate && (
                  <div className="flex gap-2 mt-2">
                    <input
                      type="password"
                      placeholder="設定密碼"
                      value={newPassword}
                      onChange={e => setNewPassword(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && newPassword.trim()) {
                          setRoomPassword(room.id, newPassword.trim());
                          setNewPassword('');
                          setShowPasswordInput(false);
                        }
                      }}
                      className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-yellow-500"
                    />
                    <button
                      onClick={() => {
                        if (newPassword.trim()) {
                          setRoomPassword(room.id, newPassword.trim());
                          setNewPassword('');
                          setShowPasswordInput(false);
                        }
                      }}
                      className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-700 text-white text-sm rounded-lg transition-colors"
                    >
                      確認
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Thinking-time multiplier (read-only info; host sets it on create) */}
            <div>
              <p className="text-xs text-gray-500 mb-2 font-semibold uppercase tracking-wider">
                思考時間倍率 (Thinking Time)
              </p>
              <div className="inline-flex items-center gap-2 bg-gray-800/60 border border-gray-700 rounded-lg px-3 py-1.5">
                <Clock size={13} className="text-blue-400" />
                <span className="text-sm text-gray-200 font-semibold">{timerLabel(room.timerConfig?.multiplier)}</span>
              </div>
            </div>

            {/* Quest size preview — honours swapR1R2 + 9-variant */}
            {previewQuestSizes.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-2 font-semibold uppercase tracking-wider">
                  任務人數 (Quest Sizes)
                  {room.roleOptions?.swapR1R2 && (
                    <span className="text-amber-400 ml-2 normal-case tracking-normal">· R1/R2 已對調</span>
                  )}
                  {is9Variant && (
                    <span className="text-amber-400 ml-2 normal-case tracking-normal">· 奧伯倫強制版</span>
                  )}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {previewQuestSizes.map((sz, i) => (
                    <span
                      key={i}
                      className="text-xs px-2 py-0.5 rounded-full font-semibold border bg-gray-800/40 border-gray-700 text-gray-300"
                    >
                      R{i + 1}: {sz} 人
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Role preview */}
            <div>
              <p className="text-xs text-gray-500 mb-2 font-semibold uppercase tracking-wider">
                {playerList.length} 人局角色預覽
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[...goodRoles, ...evilRoles].map((role, i) => (
                  <span
                    key={i}
                    className={`text-xs px-2 py-0.5 rounded-full font-semibold border ${
                      GOOD_ROLES.has(role)
                        ? 'bg-blue-900/40 border-blue-700/60 text-blue-300'
                        : 'bg-red-900/40 border-red-700/60 text-red-300'
                    }`}
                  >
                    {ROLE_LABEL[role] ?? role}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Players */}
        <div className="bg-avalon-card/50 border border-gray-600 rounded-lg p-3 sm:p-6">
          <div className="flex items-center gap-2 mb-3 sm:mb-5">
            <Users size={20} />
            <h2 className="text-base sm:text-xl font-bold">
              玩家列表 ({playerList.length}/{room.maxPlayers})
            </h2>
            {/* Host: adjust max players */}
            {isHost && (
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => setMaxPlayers(room.id, room.maxPlayers - 1)}
                  disabled={room.maxPlayers <= Math.max(5, playerList.length)}
                  className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="減少人數上限"
                >
                  <ChevronDown size={14} />
                </button>
                <span className="text-xs text-gray-400 w-8 text-center">{room.maxPlayers}人</span>
                <button
                  onClick={() => setMaxPlayers(room.id, room.maxPlayers + 1)}
                  disabled={room.maxPlayers >= 10}
                  className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="增加人數上限"
                >
                  <ChevronUp size={14} />
                </button>
              </div>
            )}
            {!isHost && !canStart && (
              <span className="ml-auto text-[10px] sm:text-xs text-yellow-400 bg-yellow-900/30 border border-yellow-700 px-2 py-0.5 sm:py-1 rounded-full">
                還需要 {5 - playerList.length} 人
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            {playerList.map((player) => {
              const botDifficultyLabel = player.isBot
                ? player.botDifficulty === 'easy'
                  ? '弱AI'
                  : player.botDifficulty === 'hard'
                  ? '強AI'
                  : '中AI'
                : null;
              return (
              <div
                key={player.id}
                className={`bg-avalon-dark rounded-lg p-2 sm:p-3 border flex items-center gap-2 sm:gap-3 min-w-0 ${
                  player.id === currentPlayer.id
                    ? 'border-blue-500/60 bg-blue-900/20'
                    : player.isBot
                    ? 'border-slate-600/50 bg-slate-900/10'
                    : 'border-gray-600'
                }`}
              >
                {player.isBot ? (
                  <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 bg-gradient-to-br from-slate-500 to-slate-700">
                    <Bot size={16} />
                  </div>
                ) : player.avatar ? (
                  <img src={player.avatar} alt={player.name} className="w-8 h-8 sm:w-10 sm:h-10 rounded-full object-cover flex-shrink-0 border border-gray-600" />
                ) : (
                  <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center font-bold text-xs sm:text-sm flex-shrink-0 bg-gradient-to-br from-blue-500 to-amber-500">
                    {player.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="flex-1 min-w-0 overflow-hidden">
                  <p className={`text-sm sm:text-base font-bold truncate ${player.status === 'disconnected' ? 'text-gray-500' : 'text-white'}`}>
                    {player.name}
                  </p>
                  <p className="text-[10px] sm:text-xs text-gray-400 truncate whitespace-nowrap overflow-hidden text-ellipsis">
                    {player.id === room.host ? '👑 房主' : player.isBot ? (
                      <span>AI・{botDifficultyLabel}</span>
                    ) : '玩家'}
                    {player.id === currentPlayer.id && ' · 你'}
                    {player.status === 'disconnected' && !player.isBot && <span className="text-red-400"> · 斷線</span>}
                  </p>
                </div>
                {/* Ready badge */}
                {!player.isBot && player.id !== room.host && (
                  <span className={`flex-shrink-0 text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5 rounded-full font-bold border ${
                    readyIds.includes(player.id)
                      ? 'bg-blue-900/50 border-blue-600 text-blue-300'
                      : 'bg-gray-800/50 border-gray-700 text-gray-600'
                  }`}>
                    {readyIds.includes(player.id) ? '✓' : '…'}
                  </span>
                )}
                {isHost && player.id !== currentPlayer.id && (
                  <button
                    onClick={() => player.isBot ? removeBot(room.id, player.id) : kickPlayer(room.id, player.id)}
                    className="flex-shrink-0 p-1 sm:p-1.5 text-gray-600 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-colors"
                    title={player.isBot ? `移除機器人 (Remove Bot)` : `踢出 ${player.name} (Kick)`}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              );
            })}
          </div>
        </div>

        {/* Start Button */}
        {isHost && (
          <div className="space-y-3">
            <button
              onClick={() => leaveRoom(room.id)}
              className="w-full flex items-center justify-center gap-2 bg-gray-800/40 hover:bg-red-900/20 border border-gray-700 hover:border-red-700 text-gray-500 hover:text-red-400 font-medium py-1.5 px-4 rounded-lg transition-all text-xs"
            >
              <LogOut size={13} />
              解散房間 / 移交房主 (Leave / Transfer host)
            </button>
            {!canStart && (
              <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-2.5 sm:p-3 text-yellow-200 text-xs sm:text-sm text-center">
                至少需要 5 名玩家才能開始（目前 {playerList.length} 人）
              </div>
            )}
            {/* Ready status summary */}
            {humanPlayers.length > 0 && (
              <div className={`text-xs sm:text-sm text-center py-2 rounded-lg border ${
                readyCount === humanPlayers.length
                  ? 'bg-blue-900/30 border-blue-700 text-blue-300'
                  : 'bg-gray-800/30 border-gray-700 text-gray-400'
              }`}>
                {readyCount === humanPlayers.length
                  ? `✓ 所有玩家已準備好！(${readyCount} ready)`
                  : `${readyCount}/${humanPlayers.length} 位玩家已準備`}
              </div>
            )}
            {/* Add Bot buttons with difficulty selection */}
            {playerList.length < room.maxPlayers && (
              <div className="space-y-1.5">
                <p className="text-[11px] sm:text-xs text-gray-500 text-center font-semibold">加入 AI 機器人</p>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { diff: 'easy',   label: '弱AI', bg: 'bg-white hover:bg-gray-200 border-gray-300 text-black' },
                    { diff: 'normal', label: '中AI', bg: 'bg-slate-500 hover:bg-slate-400 border-slate-400 text-white' },
                    { diff: 'hard',   label: '強AI', bg: 'bg-black hover:bg-gray-900 border-gray-700 text-white' },
                  ] as const).map(({ diff, label, bg }) => (
                    <button
                      key={diff}
                      onClick={() => addBot(room.id, diff)}
                      className={`flex items-center justify-center py-2 px-2 rounded-lg border font-semibold text-sm sm:text-base transition-all ${bg}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {/* Quick fill — fills remaining slots to minimum 5 with normal bots */}
                {playerList.length < 5 && (
                  <button
                    onClick={() => {
                      const needed = 5 - playerList.length;
                      for (let i = 0; i < needed; i++) addBot(room.id, 'normal');
                    }}
                    className="w-full text-[11px] sm:text-xs py-1.5 bg-gray-800/40 hover:bg-gray-700/50 border border-gray-700 text-gray-400 hover:text-gray-200 rounded-lg transition-all flex items-center justify-center gap-1.5"
                  >
                    <Bot size={12} />
                    快速填滿至 5 人 (Fill to 5)
                  </button>
                )}
              </div>
            )}
            <button
              onClick={() => startGame(room.id)}
              disabled={!canStart}
              className={`w-full font-bold py-2.5 sm:py-3 px-6 rounded-lg text-sm sm:text-base transition-all flex items-center justify-center gap-2 ${
                canStart
                  ? 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white shadow-lg hover:shadow-amber-500/30'
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed'
              }`}
            >
              <Play size={18} />
              開始遊戲 (Start Game)
            </button>
          </div>
        )}

        {!isHost && (
          <div className="space-y-3">
            {/* Ready button for non-host players */}
            <button
              onClick={() => toggleReady(room.id, currentPlayer.id)}
              className={`w-full font-bold py-2.5 sm:py-3 px-6 rounded-lg text-sm sm:text-base transition-all flex items-center justify-center gap-2 border-2 ${
                isReady
                  ? 'bg-blue-900/50 border-blue-500 text-blue-300 hover:bg-red-900/30 hover:border-red-600 hover:text-red-300'
                  : 'bg-gray-800/50 border-gray-600 text-gray-300 hover:bg-blue-900/30 hover:border-blue-600 hover:text-blue-300'
              }`}
            >
              {isReady ? '✓ 已準備（點擊取消）' : '準備好了 (Ready)'}
            </button>
            <div className="text-center text-gray-500 text-xs sm:text-sm py-1">
              等待房主開始遊戲... (Waiting for host...)
            </div>
            <button
              onClick={() => leaveRoom(room.id)}
              className="w-full flex items-center justify-center gap-2 bg-gray-800/60 hover:bg-red-900/30 border border-gray-600 hover:border-red-600 text-gray-400 hover:text-red-400 font-semibold py-1.5 sm:py-2 px-4 rounded-lg transition-all text-xs sm:text-sm"
            >
              <LogOut size={14} />
              離開房間 (Leave Room)
            </button>
          </div>
        )}
      </div>
    </div>

    {/* Floating chat — available in lobby */}
    <ChatPanel roomId={room.id} currentPlayerId={currentPlayer.id} />
    </>
  );
}
