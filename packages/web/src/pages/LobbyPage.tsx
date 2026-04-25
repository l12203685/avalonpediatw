import { useState, useEffect, useRef } from 'react';
import { useGameStore } from '../store/gameStore';
import { kickPlayer, addBot, removeBot, leaveRoom, setMaxPlayers, setRoleOptions, toggleReady, setRoomPassword, startGame, setTimerMultiplier } from '../services/socket';
import { Users, Play, Copy, Check, Link, X, LogOut, ChevronUp, ChevronDown, Lock, Unlock, ArrowLeft, Clock } from 'lucide-react';
import { AVALON_CONFIG, TIMER_MULTIPLIER_OPTIONS, TimerMultiplier, Player } from '@avalon/shared';
import PlayerCard from '../components/PlayerCard';
import ChatPanel from '../components/ChatPanel';
import { motion } from 'framer-motion';
import { getBoardImage } from '../utils/avalonAssets';

// Friendly label for the room-level thinking-time multiplier.
function timerLabel(multiplier: number | null | undefined): string {
  if (multiplier === null) return '無限';
  if (multiplier === 0.5) return '0.5x';
  if (multiplier === 1.5) return '1.5x';
  if (multiplier === 2) return '2x';
  return '1x';
}

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
  // Edward 2026-04-25: collapse R1/R2 swap + Oberon always-fail under "更多規則".
  // Default closed so vanilla rules stay quiet; lake stays always-visible.
  const [showMoreRules, setShowMoreRules] = useState(false);
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
              連線逾時 — 伺服器未回應房間資料
            </p>
            <p className="text-sm text-gray-400">
              可能原因：伺服器冷啟動中、網路不穩、或 WebSocket 連線失敗
            </p>
            <button
              onClick={() => { addToast('已返回首頁', 'info'); setGameState('home'); }}
              className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white font-bold py-2 px-6 rounded-lg transition-colors"
            >
              <ArrowLeft size={16} />
              返回首頁
            </button>
          </>
        ) : (
          <>
            <div className="inline-block animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-blue-400" />
            <p>連線中...</p>
            <button
              onClick={() => setGameState('home')}
              className="mt-2 text-sm text-gray-500 hover:text-gray-300 transition-colors underline"
            >
              取消
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
  const is9StandardWithOberon = playerList.length === 9
    && !is9Variant
    && Boolean(room.roleOptions?.oberon);
  let previewRoles: string[];
  if (is9Variant) {
    previewRoles = ['merlin', 'percival', 'loyal', 'loyal', 'loyal',
                    'assassin', 'morgana', 'mordred', 'oberon'];
  } else {
    previewRoles = (previewConfig?.roles as unknown as string[] ?? []).slice();
    if (is9StandardWithOberon) {
      const loyalIdx = previewRoles.indexOf('loyal');
      if (loyalIdx !== -1) previewRoles[loyalIdx] = 'oberon';
    }
  }
  const effectiveRoles = previewRoles.map(r => {
    if (r === 'percival' && !room.roleOptions?.percival) return 'loyal';
    if (r === 'morgana'  && !room.roleOptions?.morgana)  return 'minion';
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

  // Lady of the Lake default (Edward 2026-04-24 "7 人以上預設勾選").
  const ladyFieldUndefined = typeof ((room.roleOptions as unknown) as Record<string, unknown>)?.ladyOfTheLake === 'undefined';
  const ladyDefaultOn = ladyFieldUndefined && playerList.length >= 7;
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

  // Edward 2026-04-25 layout redesign: lobby + game share the same 3-col grid
  // (left rail | center chat | right rail). In lobby the rails show
  // PlayerCards (no roles/votes — `room.state === 'lobby'`); the center
  // column hosts the inline ChatPanel. Settings live in a compressed top
  // panel above the rails so the host can configure without scrolling far.
  const splitIndex = Math.ceil(playerList.length / 2);
  const rightRail = playerList
    .slice(0, splitIndex)
    .map((player, i) => ({ player, seatIndex: i }));
  const leftRail = playerList
    .slice(splitIndex)
    .map((player, i) => ({ player, seatIndex: splitIndex + i }))
    .reverse();

  // Lobby-only kick overlay so the host can remove someone without losing the
  // unified rail layout. PlayerCard stays untouched — we wrap it with an
  // absolute-positioned X button that only renders for the host.
  const renderLobbyPlayer = (player: Player, seatIndex: number, side: 'left' | 'right'): JSX.Element => {
    return (
      <div key={player.id} className="relative">
        <PlayerCard
          player={player}
          isCurrentPlayer={player.id === currentPlayer.id}
          hasVoted={false}
          isLeader={false}
          isOnQuestTeam={false}
          seatNumber={seatIndex + 1}
          side={side}
          isActiveTurn={false}
        />
        {/* Ready badge (non-host humans only) — top-right of the card row */}
        {!player.isBot && player.id !== room.host && (
          <span className={`absolute top-1 ${side === 'left' ? 'left-1' : 'right-1'} text-[9px] sm:text-[10px] px-1.5 py-0.5 rounded-full font-bold border z-30 ${
            readyIds.includes(player.id)
              ? 'bg-blue-900/70 border-blue-500 text-blue-200'
              : 'bg-gray-800/70 border-gray-600 text-gray-500'
          }`}>
            {readyIds.includes(player.id) ? '✓ 就緒' : '…'}
          </span>
        )}
        {/* Kick X — host only, never on self. Bottom corner so it doesn't
            collide with seat badge / vote ball. */}
        {isHost && player.id !== currentPlayer.id && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (player.isBot) removeBot(room.id, player.id);
              else kickPlayer(room.id, player.id);
            }}
            className={`absolute bottom-1 ${side === 'left' ? 'left-1' : 'right-1'} p-1 bg-red-900/70 hover:bg-red-800 border border-red-700 text-red-200 hover:text-white rounded-full transition-colors z-30`}
            title={player.isBot ? `移除機器人` : `踢出 ${player.name}`}
          >
            <X size={11} />
          </button>
        )}
      </div>
    );
  };

  // Per-table-size board watermark — Edward 2026-04-25 image batch. Lobby
  // adopts the same painted board background as GamePage so the table size
  // is recognisable while host configures the room. Falls back to the maxPlayers
  // setting when fewer than 5 players are present (we still want b5..b10
  // accuracy reflecting the *target* table size, not the current count).
  const lobbyBoardCount = Math.max(playerList.length, room.maxPlayers, 5);
  const lobbyBoardImageUrl = getBoardImage(lobbyBoardCount);

  return (
    <div className="relative min-h-screen bg-gradient-to-b from-avalon-dark to-black p-3 sm:p-4">
      {lobbyBoardImageUrl && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-0 bg-no-repeat bg-center bg-cover opacity-[0.08] sm:opacity-10 mix-blend-luminosity"
          style={{ backgroundImage: `url('${lobbyBoardImageUrl}')` }}
        />
      )}
      <div className="relative z-10 max-w-7xl mx-auto space-y-4">
        {/* ────────── Header ────────── */}
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-2 flex-wrap">
            <h1 className="text-xl sm:text-2xl font-bold text-white">{room.name}</h1>
            {/* Casual / AI tag — Edward 2026-04-24: 不計 ELO indicator */}
            {(room.casual || playerList.some(p => p.isBot)) && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] sm:text-xs font-semibold bg-amber-900/40 border border-amber-600 text-amber-200" title="此局不計 ELO">
                {room.casual ? '娛樂局 · 不計 ELO' : '含 AI · 不計 ELO'}
              </span>
            )}
          </div>

          {/* Room code + share / password row */}
          <div className="inline-flex items-center gap-2 flex-wrap justify-center">
            <div className="inline-flex items-center gap-2 bg-avalon-card/50 border border-gray-600 rounded-lg px-3 py-1.5">
              <span className="text-[10px] text-gray-500">代碼</span>
              <span className="text-sm font-mono font-bold text-yellow-400 tracking-widest">{shortCode}</span>
              <button
                onClick={handleCopyRoomId}
                className="text-gray-300 hover:text-white"
                title="複製代碼"
              >
                {copied === 'code' ? <Check size={13} className="text-blue-400" /> : <Copy size={13} />}
              </button>
              <button
                onClick={handleCopyLink}
                className="text-blue-300 hover:text-blue-100 ml-1 border-l border-gray-700 pl-2"
                title="複製邀請連結"
              >
                {copied === 'link' ? <Check size={13} className="text-amber-400" /> : <Link size={13} />}
              </button>
            </div>

            {/* Password / privacy toggle (host only) */}
            {isHost && (
              <button
                onClick={() => {
                  if (room.isPrivate) {
                    setRoomPassword(room.id, null);
                  } else {
                    setShowPasswordInput(v => !v);
                  }
                }}
                className={`inline-flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-lg border transition-colors ${
                  room.isPrivate
                    ? 'bg-yellow-900/40 border-yellow-600 text-yellow-300 hover:bg-yellow-900/60'
                    : 'bg-gray-800/40 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white'
                }`}
                data-testid="lobby-password-toggle"
              >
                {room.isPrivate ? <><Lock size={11} /> 已加密</> : <><Unlock size={11} /> 公開</>}
              </button>
            )}
          </div>

          {/* Password input (host only, when toggling) */}
          {isHost && showPasswordInput && !room.isPrivate && (
            <div className="flex items-center gap-2 max-w-sm mx-auto">
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
                className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-2 py-1 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-yellow-500"
              />
              <button
                onClick={() => {
                  if (newPassword.trim()) {
                    setRoomPassword(room.id, newPassword.trim());
                    setNewPassword('');
                    setShowPasswordInput(false);
                  }
                }}
                className="px-3 py-1 bg-yellow-600 hover:bg-yellow-700 text-white text-xs rounded-lg transition-colors"
              >
                確認
              </button>
            </div>
          )}
        </div>

        {/* ────────── Compact Settings Block (host-driven) ────────── */}
        {previewConfig && (
          <div className="bg-avalon-card/30 border border-gray-700 rounded-xl px-3 py-3 space-y-3">
            {/* Special roles — horizontal toggle row */}
            {isHost && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-1.5">特殊角色</p>
                <div className="flex flex-wrap gap-1.5">
                  {(Object.keys(ROLE_OPTION_INFO) as (keyof typeof ROLE_OPTION_INFO)[])
                    .filter(k => k !== 'morgana')
                    .map(key => {
                      const info = ROLE_OPTION_INFO[key];
                      const enabled = Boolean(((room.roleOptions as unknown) as Record<string, boolean>)?.[key]);
                      const label = key === 'percival' ? '派西維爾 + 莫甘娜' : info.label;
                      return (
                        <button
                          key={key}
                          onClick={() => handleToggleRole(key)}
                          className={`px-2.5 py-1 rounded-md border text-[11px] sm:text-xs font-semibold transition-all ${
                            enabled
                              ? 'bg-amber-900/40 border-amber-600 text-amber-200'
                              : 'bg-gray-800/40 border-gray-700 text-gray-500 hover:border-gray-500'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                </div>
              </div>
            )}

            {/* Lady + thinking time + max players — single-row meta strip */}
            <div className="flex flex-wrap items-center gap-3 text-xs">
              {/* Lady of the Lake */}
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ladyChecked}
                  onChange={() => setRoleOptions(room.id, { ladyOfTheLake: !ladyChecked })}
                  disabled={!isHost}
                  className="w-4 h-4 accent-cyan-500"
                />
                <span className="text-gray-300 font-semibold">湖中女神</span>
                {ladyChecked && playerList.length >= 7 && isHost && (
                  <select
                    value={(room.roleOptions as unknown as Record<string, string>)?.ladyStart ?? 'random'}
                    onChange={e => handleSelectAdvanced('ladyStart', e.target.value)}
                    className="bg-gray-900 border border-gray-600 rounded px-1.5 py-0.5 text-[11px] text-white focus:outline-none focus:border-cyan-500"
                  >
                    <option value="random">隨機</option>
                    <option value="seat0">隊長右手邊</option>
                    {Array.from({ length: playerList.length }, (_, i) => (
                      <option key={i + 1} value={`seat${i + 1}`}>
                        座位 {i + 1}
                      </option>
                    ))}
                  </select>
                )}
              </label>

              {/* Thinking time */}
              <div className="inline-flex items-center gap-1.5">
                <Clock size={12} className="text-blue-400" />
                {isHost && room.state === 'lobby' ? (
                  <select
                    value={room.timerConfig?.multiplier === null ? 'null' : String(room.timerConfig?.multiplier ?? 1)}
                    onChange={(e) => {
                      const v = e.target.value;
                      const next: TimerMultiplier = v === 'null' ? null : (Number(v) as TimerMultiplier);
                      setTimerMultiplier(room.id, next);
                    }}
                    className="bg-gray-900 border border-gray-600 rounded px-1.5 py-0.5 text-[11px] text-white focus:outline-none focus:border-amber-500"
                    data-testid="lobby-thinking-time-select"
                  >
                    {TIMER_MULTIPLIER_OPTIONS.map(opt => (
                      <option
                        key={opt.value === null ? 'null' : String(opt.value)}
                        value={opt.value === null ? 'null' : String(opt.value)}
                      >
                        {opt.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-gray-300 font-semibold">{timerLabel(room.timerConfig?.multiplier)}</span>
                )}
              </div>

              {/* Bot adders (host only) — Edward 2026-04-25: moved from footer to top
                  config strip so AI seats are visible alongside thinking time. */}
              {isHost && playerList.length < room.maxPlayers && (
                <div className="inline-flex items-center gap-1 ml-auto">
                  <span className="text-gray-500 mr-1 text-[10px]">加入 AI</span>
                  {([
                    { diff: 'easy',   label: '弱',   bg: 'bg-white hover:bg-gray-200 border-gray-300 text-black' },
                    { diff: 'normal', label: '中',   bg: 'bg-slate-500 hover:bg-slate-400 border-slate-400 text-white' },
                    { diff: 'hard',   label: '強',   bg: 'bg-black hover:bg-gray-900 border-gray-700 text-white' },
                  ] as const).map(({ diff, label, bg }) => (
                    <button
                      key={diff}
                      onClick={() => addBot(room.id, diff)}
                      className={`px-2 py-0.5 rounded border font-semibold text-[11px] transition-all ${bg}`}
                      title={`加入${label}AI`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Quest sizes preview — single-line ribbon (Edward 2026-04-25: nowrap so R1-R5 always inline) */}
            {previewQuestSizes.length > 0 && (
              <div className="flex flex-nowrap items-center gap-1 text-[11px] overflow-x-auto">
                <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mr-1 flex-shrink-0">任務人數</span>
                {previewQuestSizes.map((sz, i) => (
                  <span
                    key={i}
                    className="px-1.5 py-0.5 rounded-full font-semibold border bg-gray-800/40 border-gray-700 text-gray-300 whitespace-nowrap flex-shrink-0"
                  >
                    R{i + 1}: {sz}
                  </span>
                ))}
                {room.roleOptions?.swapR1R2 && (
                  <span className="text-amber-400 ml-1 whitespace-nowrap flex-shrink-0">· R1/R2 對調</span>
                )}
                {is9Variant && (
                  <span className="text-amber-400 ml-1 whitespace-nowrap flex-shrink-0">· 奧伯倫強制版</span>
                )}
              </div>
            )}

            {/* Role preview — single-line ribbon (Edward 2026-04-25: nowrap so all roles inline) */}
            <div className="flex flex-nowrap items-center gap-1 text-[11px] overflow-x-auto">
              <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mr-1 flex-shrink-0 whitespace-nowrap">
                {playerList.length} 人局
              </span>
              {[...goodRoles, ...evilRoles].map((role, i) => (
                <span
                  key={i}
                  className={`px-1.5 py-0.5 rounded-full font-semibold border whitespace-nowrap flex-shrink-0 ${
                    GOOD_ROLES.has(role)
                      ? 'bg-blue-900/40 border-blue-700/60 text-blue-300'
                      : 'bg-red-900/40 border-red-700/60 text-red-300'
                  }`}
                >
                  {ROLE_LABEL[role] ?? role}
                </span>
              ))}
            </div>

            {/* More rules collapse (host only) */}
            {isHost && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowMoreRules(v => !v)}
                  className="w-full flex items-center justify-between bg-gray-800/40 border border-gray-700 rounded-lg px-3 py-1.5 text-xs font-bold text-gray-300 hover:border-gray-500 hover:text-white transition-colors"
                  aria-expanded={showMoreRules}
                  aria-controls="lobby-more-rules"
                >
                  <span>更多規則</span>
                  {showMoreRules ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>

                {showMoreRules && (
                  <div id="lobby-more-rules" className="space-y-2 mt-2">
                    {/* R1/R2 quest size swap */}
                    <label className="flex items-center justify-between bg-gray-800/40 border border-gray-700 rounded-lg px-3 py-1.5 cursor-pointer">
                      <div className="flex-1 pr-3">
                        <div className="text-xs font-bold text-white">第 1/2 輪人數對調</div>
                        <p className="text-[10px] text-gray-500 leading-tight">交換第一、二輪任務所需人數</p>
                      </div>
                      <input
                        type="checkbox"
                        checked={Boolean(room.roleOptions?.swapR1R2)}
                        onChange={() => handleToggleAdvanced('swapR1R2')}
                        className="w-4 h-4 accent-amber-500 flex-shrink-0"
                      />
                    </label>

                    {/* Oberon must always fail */}
                    <label className="flex items-center justify-between bg-gray-800/40 border border-gray-700 rounded-lg px-3 py-1.5 cursor-pointer">
                      <div className="flex-1 pr-3">
                        <div className="text-xs font-bold text-white">奧伯倫必出失敗</div>
                        <p className="text-[10px] text-gray-500 leading-tight">奧伯倫強制投出失敗票</p>
                      </div>
                      <input
                        type="checkbox"
                        checked={Boolean((room.roleOptions as unknown as Record<string, boolean>)?.oberonAlwaysFail)}
                        onChange={() => handleToggleAdvanced('oberonAlwaysFail')}
                        className="w-4 h-4 accent-amber-500 flex-shrink-0"
                      />
                    </label>

                    {/* 9-player variant */}
                    {playerList.length === 9 && (
                      <div className="bg-gray-800/40 border border-gray-700 rounded-lg px-3 py-2 space-y-2">
                        <div>
                          <p className="text-xs font-bold text-white mb-1">9 人局變體</p>
                          <select
                            value={(room.roleOptions as unknown as Record<string, string>)?.variant9Player ?? 'standard'}
                            onChange={e => handleSelectAdvanced('variant9Player', e.target.value)}
                            className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-amber-500"
                          >
                            <option value="standard">標準 (6 好 3 壞)</option>
                            <option value="oberonMandatory">奧伯倫強制 (5 好 4 壞)</option>
                          </select>
                        </div>

                        {(() => {
                          const v9 = (room.roleOptions as unknown as Record<string, string>)?.variant9Player;
                          const v9Enabled = v9 === 'oberonMandatory';
                          const v9Opt2 = Boolean((room.roleOptions as unknown as Record<string, boolean>)?.variant9Option2);
                          return (
                            <label
                              className={`flex items-center justify-between bg-gray-900/60 border rounded px-3 py-1.5 ${
                                v9Enabled ? 'cursor-pointer border-gray-600' : 'cursor-not-allowed border-gray-800 opacity-50'
                              }`}
                            >
                              <div className="flex-1 pr-3">
                                <div className="text-xs font-bold text-white">保護局反轉模式</div>
                                <p className="text-[10px] text-gray-500 leading-tight">第 1/2/3/5 局恰好 1 張失敗 = 任務失敗</p>
                              </div>
                              <input
                                type="checkbox"
                                checked={v9Enabled && v9Opt2}
                                disabled={!v9Enabled}
                                onChange={() => {
                                  if (!v9Enabled) return;
                                  handleToggleAdvanced('variant9Option2');
                                }}
                                className="w-4 h-4 accent-amber-500 flex-shrink-0"
                              />
                            </label>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ────────── 3-col Layout: rails + chat ────────── */}
        <div className="hidden md:grid gap-3 lg:gap-4" style={{ gridTemplateColumns: '210px minmax(0, 1fr) 210px' }}>
          {/* Left rail */}
          <aside className="flex flex-col gap-2 bg-avalon-card/30 border border-gray-700/60 rounded-xl p-2 min-h-[320px]">
            {leftRail.length === 0 && (
              <div className="flex-1 flex items-center justify-center text-gray-600 text-xs text-center px-2">
                等待玩家加入...
              </div>
            )}
            {leftRail.map(({ player, seatIndex }) => (
              <motion.div
                key={player.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: seatIndex * 0.04 }}
              >
                {renderLobbyPlayer(player, seatIndex, 'left')}
              </motion.div>
            ))}
          </aside>

          {/* Center column — header band + chat */}
          <section className="flex flex-col gap-3 min-w-0">
            <div className="bg-gradient-to-b from-avalon-card/60 to-avalon-card/30 border border-gray-700/60 rounded-xl py-2 px-3 text-center flex items-center justify-center gap-2">
              <Users size={14} className="text-gray-400" />
              <span className="text-sm font-bold text-gray-200">
                玩家列表 ({playerList.length}/{room.maxPlayers})
              </span>
              {!canStart && (
                <span className="text-[11px] text-yellow-300 bg-yellow-900/30 border border-yellow-700/60 px-2 py-0.5 rounded-full">
                  還需 {5 - playerList.length} 人
                </span>
              )}
            </div>
            <div className="min-h-[320px] flex">
              <ChatPanel roomId={room.id} currentPlayerId={currentPlayer.id} variant="inline" />
            </div>
          </section>

          {/* Right rail */}
          <aside className="flex flex-col gap-2 bg-avalon-card/30 border border-gray-700/60 rounded-xl p-2 min-h-[320px] relative">
            {/* Host indicator badge — top-right corner of the rail */}
            <div className="absolute -top-2 right-3 bg-yellow-600/90 border border-yellow-800 text-yellow-50 text-[10px] font-bold px-2 py-0.5 rounded-full shadow-md z-10">
              房主 {room.players[room.host]?.name?.charAt(0).toUpperCase() ?? '?'}
            </div>
            {rightRail.length === 0 && (
              <div className="flex-1 flex items-center justify-center text-gray-600 text-xs text-center px-2">
                等待玩家加入...
              </div>
            )}
            {rightRail.map(({ player, seatIndex }) => (
              <motion.div
                key={player.id}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: seatIndex * 0.04 }}
              >
                {renderLobbyPlayer(player, seatIndex, 'right')}
              </motion.div>
            ))}
          </aside>
        </div>

        {/* Mobile (<md): two narrow vertical rails + center column wraps below */}
        <div className="md:hidden grid gap-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
          <aside className="bg-avalon-card/30 border border-gray-700/60 rounded-xl p-1.5 flex flex-col gap-1.5 min-h-[200px]">
            {leftRail.map(({ player, seatIndex }) => (
              <motion.div
                key={player.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: seatIndex * 0.04 }}
              >
                {renderLobbyPlayer(player, seatIndex, 'left')}
              </motion.div>
            ))}
          </aside>
          <aside className="bg-avalon-card/30 border border-gray-700/60 rounded-xl p-1.5 flex flex-col gap-1.5 min-h-[200px]">
            {rightRail.map(({ player, seatIndex }) => (
              <motion.div
                key={player.id}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: seatIndex * 0.04 }}
              >
                {renderLobbyPlayer(player, seatIndex, 'right')}
              </motion.div>
            ))}
          </aside>

          <section className="col-span-2 flex flex-col gap-2 mt-2">
            <div className="bg-gradient-to-b from-avalon-card/60 to-avalon-card/30 border border-gray-700/60 rounded-xl py-1.5 px-3 text-center flex items-center justify-center gap-2">
              <Users size={13} className="text-gray-400" />
              <span className="text-xs font-bold text-gray-200">
                玩家列表 ({playerList.length}/{room.maxPlayers})
              </span>
              {!canStart && (
                <span className="text-[10px] text-yellow-300 bg-yellow-900/30 border border-yellow-700/60 px-1.5 py-0.5 rounded-full">
                  還需 {5 - playerList.length}
                </span>
              )}
            </div>
            <div className="min-h-[280px] flex">
              <ChatPanel roomId={room.id} currentPlayerId={currentPlayer.id} variant="inline" />
            </div>
          </section>
        </div>

        {/* ────────── Footer: start / ready (bot adders moved to top settings strip 2026-04-25) ────────── */}
        {isHost ? (
          <div className="space-y-2">
            {humanPlayers.length > 0 && (
              <div className={`text-xs text-center py-1.5 rounded-lg border ${
                readyCount === humanPlayers.length
                  ? 'bg-blue-900/30 border-blue-700 text-blue-300'
                  : 'bg-gray-800/30 border-gray-700 text-gray-400'
              }`}>
                {readyCount === humanPlayers.length
                  ? `✓ 全部已準備（${readyCount}/${humanPlayers.length}）`
                  : `${readyCount}/${humanPlayers.length} 位玩家已準備`}
              </div>
            )}

            <button
              onClick={() => startGame(room.id)}
              disabled={!canStart}
              className={`w-full font-bold py-3 px-6 rounded-lg text-sm sm:text-base transition-all flex items-center justify-center gap-2 ${
                canStart
                  ? 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white shadow-lg hover:shadow-amber-500/30'
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed'
              }`}
            >
              <Play size={18} />
              開始遊戲
            </button>

            <button
              onClick={() => leaveRoom(room.id)}
              className="w-full flex items-center justify-center gap-2 bg-gray-800/40 hover:bg-red-900/20 border border-gray-700 hover:border-red-700 text-gray-500 hover:text-red-400 font-medium py-1 px-4 rounded-lg transition-all text-[11px]"
            >
              <LogOut size={11} />
              解散房間 / 移交房主
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <button
              onClick={() => toggleReady(room.id, currentPlayer.id)}
              className={`w-full font-bold py-3 px-6 rounded-lg text-sm sm:text-base transition-all flex items-center justify-center gap-2 border-2 ${
                isReady
                  ? 'bg-blue-900/50 border-blue-500 text-blue-300 hover:bg-red-900/30 hover:border-red-600 hover:text-red-300'
                  : 'bg-gray-800/50 border-gray-600 text-gray-300 hover:bg-blue-900/30 hover:border-blue-600 hover:text-blue-300'
              }`}
            >
              {isReady ? '✓ 已準備（點擊取消）' : '準備好了'}
            </button>
            <div className="text-center text-gray-500 text-xs py-1">等待房主開始遊戲...</div>
            <button
              onClick={() => leaveRoom(room.id)}
              className="w-full flex items-center justify-center gap-2 bg-gray-800/60 hover:bg-red-900/30 border border-gray-600 hover:border-red-600 text-gray-400 hover:text-red-400 font-semibold py-1.5 px-4 rounded-lg transition-all text-xs"
            >
              <LogOut size={13} />
              離開房間
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
