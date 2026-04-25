import { useState, useEffect, useRef } from 'react';
import { useGameStore } from '../store/gameStore';
import { kickPlayer, addBot, removeBot, leaveRoom, setRoleOptions, toggleReady, setRoomPassword, startGame, setTimerMultiplier } from '../services/socket';
import { Play, Copy, Check, Link, X, LogOut, ChevronUp, ChevronDown, Lock, Unlock, ArrowLeft, Clock } from 'lucide-react';
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

// Describe what enabling each optional role does
const ROLE_OPTION_INFO: Record<string, { label: string; short: string; description: string; paired?: string }> = {
  percival: { label: '派西維爾', short: '派+娜', description: '派西維爾看到梅林（以及莫甘娜，若啟用）', paired: 'morgana' },
  morgana:  { label: '莫甘娜',   short: '娜',     description: '莫甘娜偽裝成梅林，混淆派西維爾',        paired: 'percival' },
  mordred:  { label: '莫德雷德', short: '德',     description: '莫德雷德對梅林隱形，危險的隱藏邪惡' },
  oberon:   { label: '奧伯倫',   short: '奧',     description: '奧伯倫對邪惡陣營隱形（孤獨邪惡）' },
};

// (Edward 2026-04-25 holistic redesign) Compact role chips — tight short
// labels so the ribbon never wraps even on 375px viewport.
const ROLE_LABEL_SHORT: Record<string, string> = {
  merlin: '梅',
  percival: '派',
  loyal: '忠',
  assassin: '刺',
  morgana: '娜',
  mordred: '德',
  oberon: '奧',
};
const ROLE_LABEL: Record<string, string> = {
  merlin: '梅林',
  percival: '派西維爾',
  loyal: '忠臣',
  assassin: '刺客',
  morgana: '莫甘娜',
  mordred: '莫德雷德',
  oberon: '奧伯倫',
};
const GOOD_ROLES = new Set(['merlin', 'percival', 'loyal']);
const ALL_ROLES_FOR_CHIPS: string[] = [
  'merlin', 'percival', 'loyal',
  'assassin', 'morgana', 'mordred', 'oberon',
];

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

  // (Edward 2026-04-25 四修) Lobby 一進來就要看到「特殊角色 / 角色配置 / 任務
  // 人數」三項，不該等 5 人才顯示。1-4 人時用 5 人 default 配置預覽，5+ 人時
  // 按實際人數對應 AVALON_CONFIG。canStart 仍走真實 playerList.length >= 5。
  const previewPlayerCount = Math.min(Math.max(playerList.length, 5), 10);
  const previewConfig = AVALON_CONFIG[previewPlayerCount];
  const is9Variant = previewPlayerCount === 9
    && (room.roleOptions as unknown as Record<string, string>)?.variant9Player === 'oberonMandatory';

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

  // (Edward 2026-04-25) Compute which canonical roles are "active" in the
  // current configuration so the role-chip ribbon can light/dim them. Active =
  // role will appear in `effectiveRoles` once the game starts.
  const activeRolesSet: Set<string> = (() => {
    const set = new Set<string>();
    if (!previewConfig) return set;
    let baseRoster: string[];
    if (is9Variant) {
      baseRoster = ['merlin', 'percival', 'loyal', 'loyal', 'loyal',
                    'assassin', 'morgana', 'mordred', 'oberon'];
    } else {
      baseRoster = (previewConfig.roles as unknown as string[]).slice();
      const is9StandardWithOberon = previewPlayerCount === 9
        && Boolean(room.roleOptions?.oberon);
      if (is9StandardWithOberon) {
        const loyalIdx = baseRoster.indexOf('loyal');
        if (loyalIdx !== -1) baseRoster[loyalIdx] = 'oberon';
      }
    }
    for (const r of baseRoster) {
      if (r === 'percival' && !room.roleOptions?.percival) continue;
      if (r === 'morgana'  && !room.roleOptions?.morgana)  continue;
      if (r === 'oberon'   && !room.roleOptions?.oberon && !is9Variant) continue;
      if (r === 'mordred'  && !room.roleOptions?.mordred)  continue;
      set.add(r);
    }
    return set;
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

  const handleToggleAdvanced = (key: string) => {
    if (!room.roleOptions) return;
    const opts = (room.roleOptions as unknown) as Record<string, unknown>;
    const newVal = !Boolean(opts[key]);
    setRoleOptions(room.id, { [key]: newVal });
  };

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

  // Player rail split — same convention as GameBoard for visual consistency.
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
          <span className={`absolute top-1 ${side === 'left' ? 'left-1' : 'right-1'} text-[8px] sm:text-[10px] px-1 py-0.5 rounded-full font-bold border z-30 ${
            readyIds.includes(player.id)
              ? 'bg-blue-900/70 border-blue-500 text-blue-200'
              : 'bg-gray-800/70 border-gray-600 text-gray-500'
          }`}>
            {readyIds.includes(player.id) ? '✓' : '…'}
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
            className={`absolute bottom-1 ${side === 'left' ? 'left-1' : 'right-1'} p-0.5 bg-red-900/70 hover:bg-red-800 border border-red-700 text-red-200 hover:text-white rounded-full transition-colors z-30`}
            title={player.isBot ? `移除機器人` : `踢出 ${player.name}`}
          >
            <X size={9} />
          </button>
        )}
      </div>
    );
  };

  // Per-table-size board watermark — Edward 2026-04-25 image batch.
  const lobbyBoardCount = Math.max(playerList.length, room.maxPlayers, 5);
  const lobbyBoardImageUrl = getBoardImage(lobbyBoardCount);

  // Edward 2026-04-25 holistic mobile-first viewport-fit redesign:
  // Single-viewport guarantee — entire lobby fits 375x667 (iPhone SE) and
  // 1920x1080 (desktop) without page scroll. Inner panels (player rails,
  // chat) own their scroll. Layout uses h-[100dvh] + flex-col with
  // shrink-0 rows for header/settings/footer + flex-1 min-h-0 main 3-col.
  // Font sizes use clamp() so chips never overflow on narrow viewports.
  return (
    <div className="relative h-[100dvh] flex flex-col overflow-hidden bg-gradient-to-b from-avalon-dark to-black">
      {lobbyBoardImageUrl && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-0 bg-no-repeat bg-center bg-cover opacity-[0.08] sm:opacity-10 mix-blend-luminosity"
          style={{ backgroundImage: `url('${lobbyBoardImageUrl}')` }}
        />
      )}

      {/* ────────── HEADER ROW (shrink-0) ────────── */}
      {/* 1-line: 房主 (left) | tags + 房號 + 加入AI + 離房 + 密碼 (right) */}
      <div className="relative z-10 shrink-0 flex items-center justify-between gap-1 px-2 py-1 text-[clamp(0.6rem,2vw,0.8rem)]">
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-yellow-900/30 border border-yellow-700/60 text-yellow-200 font-semibold whitespace-nowrap min-w-0 truncate">
          <span className="hidden sm:inline">房主：</span>
          <span className="truncate">{room.players[room.host]?.name ?? '—'}</span>
        </span>

        <div className="flex items-center gap-1 flex-nowrap shrink-0">
          {(room.casual || playerList.some(p => p.isBot)) && (
            <span
              className="inline-flex items-center px-1 py-0.5 rounded-full text-[clamp(0.55rem,1.7vw,0.7rem)] font-semibold bg-amber-900/40 border border-amber-600 text-amber-200 whitespace-nowrap"
              title="此局不計 ELO"
            >
              {room.casual ? '娛樂' : '含 AI'}
            </span>
          )}
          <div className="inline-flex items-center gap-0.5 bg-avalon-card/50 border border-gray-600 rounded px-1 py-0.5 whitespace-nowrap">
            <span className="text-[clamp(0.65rem,2vw,0.85rem)] font-mono font-bold text-yellow-400 tracking-wider">
              {shortCode.slice(0, 4)}
            </span>
            <button
              onClick={handleCopyRoomId}
              className="text-gray-300 hover:text-white"
              title="複製代碼"
            >
              {copied === 'code' ? <Check size={11} className="text-blue-400" /> : <Copy size={11} />}
            </button>
            <button
              onClick={handleCopyLink}
              className="text-blue-300 hover:text-blue-100 ml-0.5 border-l border-gray-700 pl-1"
              title="複製邀請連結"
            >
              {copied === 'link' ? <Check size={11} className="text-amber-400" /> : <Link size={11} />}
            </button>
          </div>

          {isHost && room.state === 'lobby' && playerList.length < room.maxPlayers && (
            <button
              type="button"
              onClick={() => addBot(room.id, 'hard')}
              className="inline-flex items-center px-1.5 py-0.5 rounded border text-[clamp(0.55rem,1.7vw,0.7rem)] font-semibold bg-emerald-900/40 border-emerald-600 text-emerald-200 hover:bg-emerald-900/60 hover:text-white transition-colors whitespace-nowrap"
              title="加入 AI"
              data-testid="lobby-add-ai-button"
            >
              加入 AI
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              if (isHost) {
                const otherHumans = playerList.filter(p => !p.isBot && p.id !== currentPlayer.id).length;
                const msg = otherHumans > 0
                  ? '確定離開房間？'
                  : '確定離開？房間將解散。';
                if (!window.confirm(msg)) return;
              }
              leaveRoom(room.id);
            }}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[clamp(0.55rem,1.7vw,0.7rem)] font-semibold bg-gray-800/40 border-gray-700 text-gray-300 hover:bg-red-900/30 hover:border-red-700 hover:text-red-300 transition-colors whitespace-nowrap"
            title="離開房間"
            data-testid="lobby-leave-button"
          >
            <LogOut size={9} />
            離房
          </button>

          {isHost && (
            <button
              onClick={() => {
                if (room.isPrivate) {
                  setRoomPassword(room.id, null);
                } else {
                  setShowPasswordInput(v => !v);
                }
              }}
              className={`inline-flex items-center gap-0.5 text-[clamp(0.55rem,1.7vw,0.7rem)] px-1 py-0.5 rounded border transition-colors whitespace-nowrap ${
                room.isPrivate
                  ? 'bg-yellow-900/40 border-yellow-600 text-yellow-300 hover:bg-yellow-900/60'
                  : 'bg-gray-800/40 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white'
              }`}
              data-testid="lobby-password-toggle"
            >
              {room.isPrivate ? <><Lock size={9} /> 鎖</> : <><Unlock size={9} /> 公</>}
            </button>
          )}
        </div>
      </div>

      {/* Password input slot (host only, when toggling) */}
      {isHost && showPasswordInput && !room.isPrivate && (
        <div className="relative z-10 shrink-0 flex items-center gap-2 max-w-sm px-2 pb-1">
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
            className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-yellow-500"
          />
          <button
            onClick={() => {
              if (newPassword.trim()) {
                setRoomPassword(room.id, newPassword.trim());
                setNewPassword('');
                setShowPasswordInput(false);
              }
            }}
            className="px-2 py-0.5 bg-yellow-600 hover:bg-yellow-700 text-white text-xs rounded transition-colors"
          >
            確認
          </button>
        </div>
      )}

      {/* ────────── SETTINGS STRIP (shrink-0, compact rows) ────────── */}
      {previewConfig && (
        <div className="relative z-10 shrink-0 px-2 py-1 space-y-1 border-y border-gray-800/60 bg-black/20">
          {/* Special roles toggle — short labels (派+娜 / 德 / 奧) */}
          {isHost && (
            <div className="flex flex-nowrap items-center gap-1 overflow-x-auto">
              <span className="text-[clamp(0.55rem,1.7vw,0.7rem)] uppercase tracking-wider text-gray-500 font-semibold mr-0.5 shrink-0">特殊</span>
              {(Object.keys(ROLE_OPTION_INFO) as (keyof typeof ROLE_OPTION_INFO)[])
                .filter(k => k !== 'morgana')
                .map(key => {
                  const info = ROLE_OPTION_INFO[key];
                  const enabled = Boolean(((room.roleOptions as unknown) as Record<string, boolean>)?.[key]);
                  return (
                    <button
                      key={key}
                      onClick={() => handleToggleRole(key)}
                      className={`px-1.5 py-0.5 rounded border text-[clamp(0.6rem,1.8vw,0.75rem)] font-semibold transition-all shrink-0 whitespace-nowrap ${
                        enabled
                          ? 'bg-amber-900/40 border-amber-500 text-amber-200 shadow-sm shadow-amber-500/30'
                          : 'bg-gray-800/30 border-transparent text-gray-500 opacity-50 hover:opacity-80 hover:border-gray-600'
                      }`}
                      aria-pressed={enabled}
                      title={info.description}
                    >
                      {info.short}
                    </button>
                  );
                })}
            </div>
          )}

          {/* Lake + thinking-time row — single-line, nowrap */}
          <div className="flex flex-nowrap items-center gap-2 text-[clamp(0.6rem,1.8vw,0.75rem)] overflow-x-auto">
            <label className="inline-flex items-center gap-1 cursor-pointer shrink-0 whitespace-nowrap">
              <input
                type="checkbox"
                checked={ladyChecked}
                onChange={() => setRoleOptions(room.id, { ladyOfTheLake: !ladyChecked })}
                disabled={!isHost}
                className="w-3 h-3 accent-cyan-500"
              />
              <span className="text-gray-300 font-semibold">湖</span>
            </label>
            {ladyChecked && playerList.length >= 7 && isHost && (
              <select
                value={(room.roleOptions as unknown as Record<string, string>)?.ladyStart ?? 'seat0'}
                onChange={e => handleSelectAdvanced('ladyStart', e.target.value)}
                className="bg-gray-900 border border-gray-600 rounded px-1 py-0.5 text-[clamp(0.55rem,1.7vw,0.7rem)] text-white focus:outline-none focus:border-cyan-500 shrink-0"
              >
                <option value="seat0">隊長右</option>
                <option value="random">隨機起始</option>
                {Array.from({ length: playerList.length }, (_, i) => (
                  <option key={i + 1} value={`seat${i + 1}`}>{i + 1}家</option>
                ))}
              </select>
            )}

            <div className="inline-flex items-center gap-0.5 shrink-0 whitespace-nowrap">
              <Clock size={10} className="text-blue-400" />
              {isHost && room.state === 'lobby' ? (
                <select
                  value={room.timerConfig?.multiplier === null ? 'null' : String(room.timerConfig?.multiplier ?? 1)}
                  onChange={(e) => {
                    const v = e.target.value;
                    const next: TimerMultiplier = v === 'null' ? null : (Number(v) as TimerMultiplier);
                    setTimerMultiplier(room.id, next);
                  }}
                  className="bg-gray-900 border border-gray-600 rounded px-1 py-0.5 text-[clamp(0.55rem,1.7vw,0.7rem)] text-white focus:outline-none focus:border-amber-500"
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
          </div>

          {/* Quest sizes ribbon — nowrap, R1..R5 always inline */}
          {previewQuestSizes.length > 0 && (
            <div className="flex flex-nowrap items-center gap-1 text-[clamp(0.55rem,1.7vw,0.7rem)] overflow-x-auto">
              <span className="uppercase tracking-wider text-gray-500 font-semibold mr-0.5 shrink-0">任務</span>
              {previewQuestSizes.map((sz, i) => (
                <span
                  key={i}
                  className="px-1 py-0.5 rounded font-semibold border bg-gray-800/40 border-gray-700 text-gray-300 whitespace-nowrap shrink-0"
                >
                  R{i + 1}:{sz}
                </span>
              ))}
              {room.roleOptions?.swapR1R2 && (
                <span className="text-amber-400 ml-0.5 whitespace-nowrap shrink-0">·R1/2對調</span>
              )}
              {is9Variant && (
                <span className="text-amber-400 ml-0.5 whitespace-nowrap shrink-0">·奧伯倫</span>
              )}
            </div>
          )}

          {/* Role config ribbon — 7 chips, nowrap forever (Edward 14:32 fix) */}
          <div className="flex flex-nowrap items-center gap-1 text-[clamp(0.55rem,1.7vw,0.7rem)] overflow-x-auto">
            <span className="uppercase tracking-wider text-gray-500 font-semibold mr-0.5 shrink-0">配置</span>
            {ALL_ROLES_FOR_CHIPS.map(role => {
              const isActive = activeRolesSet.has(role);
              const isGood = GOOD_ROLES.has(role);
              const baseColor = isGood
                ? 'bg-blue-900/40 border-blue-600 text-blue-200'
                : 'bg-red-900/40 border-red-600 text-red-200';
              return (
                <span
                  key={role}
                  className={`px-1 py-0.5 rounded font-semibold border whitespace-nowrap transition-all shrink-0 ${
                    isActive
                      ? `${baseColor} shadow-sm`
                      : 'bg-gray-800/30 border-transparent text-gray-500 opacity-50'
                  }`}
                  title={isActive ? `${ROLE_LABEL[role]} · 該局會出現` : `${ROLE_LABEL[role]} · 該局不會出現`}
                >
                  {ROLE_LABEL_SHORT[role] ?? role}
                </span>
              );
            })}
          </div>

          {/* More rules collapse trigger (host only) */}
          {isHost && (
            <button
              type="button"
              onClick={() => setShowMoreRules(v => !v)}
              className="w-full flex items-center justify-between bg-gray-800/40 border border-gray-700 rounded px-2 py-0.5 text-[clamp(0.55rem,1.7vw,0.7rem)] font-bold text-gray-400 hover:border-gray-500 hover:text-white transition-colors"
              aria-expanded={showMoreRules}
              aria-controls="lobby-more-rules"
            >
              <span>更多規則</span>
              {showMoreRules ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>
          )}

          {/* More rules content — only when expanded; pushes layout down,
              chat panel still owns its own min-h-0 so it stays usable */}
          {isHost && showMoreRules && (
            <div id="lobby-more-rules" className="space-y-1 pt-1">
              <label className="flex items-center justify-between bg-gray-800/40 border border-gray-700 rounded px-2 py-1 cursor-pointer">
                <div className="flex-1 pr-2 min-w-0">
                  <div className="text-[clamp(0.6rem,1.8vw,0.75rem)] font-bold text-white">第 1/2 輪人數對調</div>
                  <p className="text-[9px] text-gray-500 leading-tight truncate">交換第一、二輪任務人數</p>
                </div>
                <input
                  type="checkbox"
                  checked={Boolean(room.roleOptions?.swapR1R2)}
                  onChange={() => handleToggleAdvanced('swapR1R2')}
                  className="w-3.5 h-3.5 accent-amber-500 shrink-0"
                />
              </label>

              <label className="flex items-center justify-between bg-gray-800/40 border border-gray-700 rounded px-2 py-1 cursor-pointer">
                <div className="flex-1 pr-2 min-w-0">
                  <div className="text-[clamp(0.6rem,1.8vw,0.75rem)] font-bold text-white">奧伯倫必出失敗</div>
                  <p className="text-[9px] text-gray-500 leading-tight truncate">奧伯倫強制投失敗票</p>
                </div>
                <input
                  type="checkbox"
                  checked={Boolean((room.roleOptions as unknown as Record<string, boolean>)?.oberonAlwaysFail)}
                  onChange={() => handleToggleAdvanced('oberonAlwaysFail')}
                  className="w-3.5 h-3.5 accent-amber-500 shrink-0"
                />
              </label>

              {playerList.length === 9 && (
                <div className="bg-gray-800/40 border border-gray-700 rounded px-2 py-1 space-y-1">
                  <div>
                    <p className="text-[clamp(0.6rem,1.8vw,0.75rem)] font-bold text-white mb-0.5">9 人局變體</p>
                    <select
                      value={(room.roleOptions as unknown as Record<string, string>)?.variant9Player ?? 'standard'}
                      onChange={e => handleSelectAdvanced('variant9Player', e.target.value)}
                      className="w-full bg-gray-900 border border-gray-600 rounded px-1.5 py-0.5 text-[clamp(0.55rem,1.7vw,0.7rem)] text-white focus:outline-none focus:border-amber-500"
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
                        className={`flex items-center justify-between bg-gray-900/60 border rounded px-2 py-0.5 ${
                          v9Enabled ? 'cursor-pointer border-gray-600' : 'cursor-not-allowed border-gray-800 opacity-50'
                        }`}
                      >
                        <div className="flex-1 pr-2 min-w-0">
                          <div className="text-[clamp(0.6rem,1.8vw,0.75rem)] font-bold text-white">保護局反轉</div>
                          <p className="text-[9px] text-gray-500 leading-tight truncate">第 1/2/3/5 局 1 失敗 = 任務失敗</p>
                        </div>
                        <input
                          type="checkbox"
                          checked={v9Enabled && v9Opt2}
                          disabled={!v9Enabled}
                          onChange={() => {
                            if (!v9Enabled) return;
                            handleToggleAdvanced('variant9Option2');
                          }}
                          className="w-3.5 h-3.5 accent-amber-500 shrink-0"
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

      {/* ────────── START / READY (shrink-0) ────────── */}
      <div className="relative z-10 shrink-0 px-2 py-1.5">
        {isHost ? (
          <div className="space-y-1">
            {humanPlayers.length > 0 && (
              <div className={`text-[clamp(0.55rem,1.7vw,0.7rem)] text-center py-0.5 rounded border ${
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
              className={`w-full font-bold py-2 px-4 rounded-lg text-[clamp(0.85rem,2.5vw,1rem)] transition-all flex items-center justify-center gap-2 ${
                canStart
                  ? 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white shadow-lg hover:shadow-amber-500/30'
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed'
              }`}
            >
              <Play size={16} />
              開始遊戲
              {!canStart && (
                <span className="text-[clamp(0.55rem,1.7vw,0.7rem)] opacity-80">（還需 {5 - playerList.length} 人）</span>
              )}
            </button>
          </div>
        ) : (
          <button
            onClick={() => toggleReady(room.id, currentPlayer.id)}
            className={`w-full font-bold py-2 px-4 rounded-lg text-[clamp(0.85rem,2.5vw,1rem)] transition-all flex items-center justify-center gap-2 border-2 ${
              isReady
                ? 'bg-blue-900/50 border-blue-500 text-blue-300 hover:bg-red-900/30 hover:border-red-600 hover:text-red-300'
                : 'bg-gray-800/50 border-gray-600 text-gray-300 hover:bg-blue-900/30 hover:border-blue-600 hover:text-blue-300'
            }`}
          >
            {isReady ? '✓ 已準備（點擊取消）' : '準備好了'}
          </button>
        )}
      </div>

      {/* ────────── MAIN 3-COL (flex-1, players + chat all self-scroll) ────────── */}
      {/* grid: left rail | chat | right rail. Each rail has overflow-y-auto +
          min-h-0 so they own their scroll. Chat is the inline variant which
          already does flex-1 min-h-0 + own message list scroll internally. */}
      <main className="relative z-10 flex-1 min-h-0 grid gap-1 px-1 pb-1"
            style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2.5fr) minmax(0, 1fr)' }}>
        <aside className="flex flex-col gap-1 bg-avalon-card/30 border border-gray-700/60 rounded-lg p-1 overflow-y-auto min-h-0 min-w-0">
          {leftRail.length === 0 && (
            <div className="flex-1 flex items-center justify-center text-gray-600 text-[10px] text-center px-1">
              等待...
            </div>
          )}
          {leftRail.map(({ player, seatIndex }) => (
            <motion.div
              key={player.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: seatIndex * 0.03 }}
            >
              {renderLobbyPlayer(player, seatIndex, 'left')}
            </motion.div>
          ))}
        </aside>

        <section className="flex flex-col min-h-0 min-w-0">
          <ChatPanel roomId={room.id} currentPlayerId={currentPlayer.id} variant="inline" />
        </section>

        <aside className="flex flex-col gap-1 bg-avalon-card/30 border border-gray-700/60 rounded-lg p-1 overflow-y-auto min-h-0 min-w-0">
          {rightRail.length === 0 && (
            <div className="flex-1 flex items-center justify-center text-gray-600 text-[10px] text-center px-1">
              等待...
            </div>
          )}
          {rightRail.map(({ player, seatIndex }) => (
            <motion.div
              key={player.id}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: seatIndex * 0.03 }}
            >
              {renderLobbyPlayer(player, seatIndex, 'right')}
            </motion.div>
          ))}
        </aside>
      </main>
    </div>
  );
}
