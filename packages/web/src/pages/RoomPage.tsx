import { useState, useEffect, useRef } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useGameStore } from '../store/gameStore';
import {
  kickPlayer,
  addBot,
  removeBot,
  leaveRoom,
  setRoleOptions,
  toggleReady,
  setRoomPassword,
  startGame,
  setTimerMultiplier,
  submitVote,
  submitAssassination,
  submitLadyOfTheLake,
  declareLakeResult,
  skipLakeDeclaration,
  leaveSpectate,
} from '../services/socket';
import {
  Play,
  Copy,
  Check,
  Link,
  X,
  LogOut,
  ChevronUp,
  ChevronDown,
  Lock,
  Unlock,
  ArrowLeft,
  Clock,
  Bell,
  WifiOff,
  Loader2,
  Eye,
  ClipboardList,
} from 'lucide-react';
import {
  AVALON_CONFIG,
  TIMER_MULTIPLIER_OPTIONS,
  TimerMultiplier,
  Player,
} from '@avalon/shared';
import GameBoard from '../components/GameBoard';
import ChatPanel from '../components/ChatPanel';
import VotePanel from '../components/VotePanel';
import QuestPanel from '../components/QuestPanel';
import QuestTeamToolbar from '../components/QuestTeamToolbar';
import RoleRevealModal from '../components/RoleRevealModal';
import MissionTrack from '../components/MissionTrack';
import CompactScoresheet from '../components/CompactScoresheet';
import FullScoresheetLayout from '../components/FullScoresheetLayout';
import PhaseInfoBanner from '../components/PhaseInfoBanner';
import { motion, AnimatePresence } from 'framer-motion';
import { requestNotificationPermission } from '../services/notifications';
import { displaySeatNumber, seatOf } from '../utils/seatDisplay';
import { LAKE_IMAGE, getBoardImage } from '../utils/avalonAssets';
import { CampDisc } from '../components/CampDisc';
import audioService from '../services/audio';

// Friendly label for the room-level thinking-time multiplier.
function timerLabel(multiplier: number | null | undefined): string {
  if (multiplier === null) return '無限';
  if (multiplier === 0.5) return '0.5x';
  if (multiplier === 1.5) return '1.5x';
  if (multiplier === 2) return '2x';
  return '1x';
}

const LOBBY_TIMEOUT_MS = 12_000;

// Describe what enabling each optional role does.
// Edward 2026-04-26: lobby chips 顯示全名 — 派西+莫甘娜為「+娜 套組」 (因 morgana
// 從 chip 列被 filter 掉, percival 啟用即同時啟用莫甘娜).
const ROLE_OPTION_INFO: Record<string, { label: string; short: string; description: string; paired?: string }> = {
  percival: { label: '派西維爾 + 莫甘娜', short: '派+娜', description: '派西維爾看到梅林（以及莫甘娜，若啟用）', paired: 'morgana' },
  morgana:  { label: '莫甘娜',           short: '娜',     description: '莫甘娜偽裝成梅林，混淆派西維爾',        paired: 'percival' },
  mordred:  { label: '莫德雷德',         short: '德',     description: '莫德雷德對梅林隱形，危險的隱藏邪惡' },
  oberon:   { label: '奧伯倫',           short: '奧',     description: '奧伯倫對邪惡陣營隱形（孤獨邪惡）' },
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

// Base seconds per phase (match server constants at 1x multiplier).
const TEAM_SELECT_BASE = 90;
const ASSASSIN_BASE = 180;

/**
 * RoomPage — Edward 2026-04-25 23:39 unified Lobby+Game layout.
 *
 * Single page that handles every `room.state` value (`lobby` | `voting` |
 * `quest` | `lady_of_the_lake` | `discussion` | `ended`). The layout is the
 * same in every phase:
 *
 *   ┌──────────────────────────────────────┐
 *   │ TOP SECTION (phase-specific)         │  ← settings (lobby) /
 *   │ - lobby: 設定 + 開始遊戲              │     mission track + 否決
 *   │ - playing/lady/discussion: 否決 + 牌譜│     (gameplay) /
 *   │ - ended: 牌譜紀錄 (結算)              │     scoresheet (ended)
 *   ├──────────────────────────────────────┤
 *   │ MAIN (rails + chat — phase-agnostic)  │  ← GameBoard always renders
 *   │   left rail │ chat │ right rail       │     here, lobbyMode toggle
 *   ├──────────────────────────────────────┤
 *   │ TOOLBAR (phase-specific, optional)    │  ← start/ready (lobby) /
 *   │ - lobby: 開始遊戲 / 準備好了           │     QuestTeamToolbar /
 *   │ - voting/quest: VotePanel / QuestPanel│     VotePanel / QuestPanel
 *   │ - ended: nothing (auto return to lobby)│
 *   └──────────────────────────────────────┘
 *
 * Edward verbatim: 「準備房間 跟 遊戲房間 應該要可以共用 (版圖配置幾乎一模一樣,
 * 除了最頂端的設定區到開始遊戲這塊可以拿掉外 其他都可以完全相同)」+「遊戲結束的
 * 『返回房間』其實有點多餘」— 結算後 5 秒自動回 lobby，不需要專屬按鈕。
 */
export default function RoomPage(): JSX.Element {
  const { t } = useTranslation(['game', 'common']);
  const {
    room,
    currentPlayer,
    setGameState,
    addToast,
    isSpectator,
    socketStatus,
  } = useGameStore();

  // ─── Lobby-only state ───────────────────────────────────────────────
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const [showPasswordInput, setShowPasswordInput] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [timedOut, setTimedOut] = useState(false);
  const [showMoreRules, setShowMoreRules] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Game-only state ────────────────────────────────────────────────
  const [isVoting, setIsVoting] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [isAssassinating, setIsAssassinating] = useState(false);
  const [showRoleReveal, setShowRoleReveal] = useState(true);
  const prevRoomState = useRef<string | null>(null);
  const timerMultiplier = room?.timerConfig?.multiplier ?? 1;
  const isUnlimitedTimer = timerMultiplier === null;
  const teamSelectBase = isUnlimitedTimer ? 0 : Math.round(TEAM_SELECT_BASE * (timerMultiplier as number));
  const assassinBase = isUnlimitedTimer ? 0 : Math.round(ASSASSIN_BASE * (timerMultiplier as number));
  const [assassinTimer, setAssassinTimer] = useState(assassinBase);
  const [teamSelectTimer, setTeamSelectTimer] = useState(teamSelectBase);
  const [loyalView, setLoyalView] = useState(false);
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<string>>(new Set());
  // Edward 2026-04-26 17:05: 牌譜全展 toggle. true => 主畫面 (rails+chat) 整個被
  // FullScoresheetLayout 替換, 不顯 10 個 PlayerCard. 點頂端 ClipboardList icon
  // 切換. Phase 變化時不自動重置 — 由玩家自主控制.
  const [scoresheetExpanded, setScoresheetExpanded] = useState(false);
  const prevVoteHistoryLen = useRef(0);
  const prevQuestHistoryLen = useRef(0);

  // Lobby connection timeout
  useEffect(() => {
    if (room) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      setTimedOut(false);
      return;
    }
    timerRef.current = setTimeout(() => setTimedOut(true), LOBBY_TIMEOUT_MS);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [room]);

  // Browser notification permission
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // Show role reveal each time game starts (lobby → voting transition)
  useEffect(() => {
    if (!room) return;
    if (prevRoomState.current === 'lobby' && room.state === 'voting') {
      setShowRoleReveal(true);
      setIsVoting(false);
      setIsAssassinating(false);
      setSelectedTarget(null);
      // Edward 2026-04-26 19:31 spec 29: when a new round starts, collapse any
      // lingering「看牌譜」full-screen overlay from the lobby so players land
      // on the live board, not the previous game's replay.
      setScoresheetExpanded(false);
    }
    if (prevRoomState.current === null && room.state !== 'lobby') {
      setShowRoleReveal(true);
    }
    prevRoomState.current = room.state;
  }, [room?.state]);

  // Team-select countdown
  useEffect(() => {
    if (!room || room.state !== 'voting' || room.questTeam.length > 0) return;
    if (isUnlimitedTimer) {
      setTeamSelectTimer(0);
      return;
    }
    setTeamSelectTimer(teamSelectBase);
    const interval = setInterval(() => {
      setTeamSelectTimer(t => Math.max(0, t - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [room?.state, room?.questTeam?.length, room?.leaderIndex, isUnlimitedTimer, teamSelectBase]);

  // Assassination countdown
  useEffect(() => {
    if (!room || room.state !== 'discussion') return;
    if (isUnlimitedTimer) {
      setAssassinTimer(0);
      return;
    }
    setAssassinTimer(assassinBase);
    const interval = setInterval(() => {
      setAssassinTimer(t => Math.max(0, t - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [room?.state, isUnlimitedTimer, assassinBase]);

  // Reset isVoting once server confirms
  useEffect(() => {
    if (!room || !currentPlayer) return;
    if (room.votes[currentPlayer.id] !== undefined) {
      setIsVoting(false);
    }
  }, [room?.votes]);

  // Reset leader's selected-team picks on phase change
  useEffect(() => {
    if (!room) return;
    if (room.state !== 'voting' || room.questTeam.length > 0) {
      setSelectedTeamIds(new Set());
    }
  }, [room?.state, room?.questTeam?.length, room?.leaderIndex, room?.currentRound]);

  // Audio cues for vote / quest history
  useEffect(() => {
    if (!room) return;
    const len = room.voteHistory.length;
    if (len > prevVoteHistoryLen.current && len > 0) {
      const latest = room.voteHistory[len - 1];
      audioService.playSound(latest.approved ? 'approval' : 'rejection');
    }
    prevVoteHistoryLen.current = len;
  }, [room?.voteHistory?.length]);

  useEffect(() => {
    if (!room) return;
    const len = room.questHistory.length;
    if (len > prevQuestHistoryLen.current && len > 0) {
      const latest = room.questHistory[len - 1];
      audioService.playSound(latest.result === 'success' ? 'quest-success' : 'quest-fail');
    }
    prevQuestHistoryLen.current = len;
  }, [room?.questHistory?.length]);

  // Edward 2026-04-26 19:31 spec 26-28「結束直接回 lobby (砍返回通知)」: drop
  // the 8-second wait — Edward verbatim「結束就是回到 lobby 頁面 只是依然可以
  // 看牌譜 & 看到系統訊息紀錄」. Switch happens in 1.2s (just enough to let the
  //「正義/邪惡方獲勝」system-chat line + final scoresheet update visually
  // settle before the layout transitions). Lobby retains the previous game's
  // chat history + scoresheet via the「看牌譜」toggle (spec 29).
  useEffect(() => {
    if (!room || room.state !== 'ended') return;
    const id = window.setTimeout(() => {
      // Only flip GameState; room.state stays 'ended' until server transitions.
      // GameState='lobby' lets the layout treat the room as the waiting page
      // (settings + start/ready) so the host can spin up the next round.
      setGameState('lobby');
    }, 1200);
    return () => window.clearTimeout(id);
  }, [room?.state, setGameState]);

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

  // ─── Derived state shared by lobby + game phases ─────────────────────
  const isLobbyPhase = room.state === 'lobby';
  const isGameplayPhase =
    room.state === 'voting' ||
    room.state === 'quest' ||
    room.state === 'lady_of_the_lake' ||
    room.state === 'discussion';
  const isEndedPhase = room.state === 'ended';

  const playerList = Object.values(room.players);
  const playerIds = Object.keys(room.players);
  const isHost = room.host === currentPlayer.id;
  const canStart = playerList.length >= 5;
  const readyIds = room.readyPlayerIds ?? [];
  const isReady = readyIds.includes(currentPlayer.id);
  const humanPlayers = playerList.filter(p => !p.isBot && p.id !== room.host);
  const readyCount = humanPlayers.filter(p => readyIds.includes(p.id)).length;
  const shortCode = room.id.slice(0, 8).toUpperCase();

  // Lobby preview config (5..10 players)
  const previewPlayerCount = Math.min(Math.max(playerList.length, 5), 10);
  const previewConfig = AVALON_CONFIG[previewPlayerCount];
  const is9Variant = previewPlayerCount === 9
    && (room.roleOptions as unknown as Record<string, string>)?.variant9Player === 'oberonMandatory';

  const previewQuestSizes: number[] = (() => {
    if (!previewConfig) return [];
    const sizes = is9Variant ? [4, 3, 4, 5, 5] : [...previewConfig.questTeams];
    if (room.roleOptions?.swapR1R2 && sizes.length >= 2) {
      const t = sizes[0]; sizes[0] = sizes[1]; sizes[1] = t;
    }
    return sizes;
  })();

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
    const newVal = !opts[key];
    setRoleOptions(room.id, { [key]: newVal });
  };

  const handleSelectAdvanced = (key: string, value: string) => {
    setRoleOptions(room.id, { [key]: value });
  };

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

  // ─── Game phase handlers ────────────────────────────────────────────
  const leaderId = playerIds[room.leaderIndex % playerIds.length];
  const isCurrentPlayerLeader = currentPlayer.id === leaderId;
  const teamSelected = room.questTeam.length > 0;
  const config = AVALON_CONFIG[playerIds.length];

  const handleVote = (approve: boolean): void => {
    if (isVoting) return;
    setIsVoting(true);
    submitVote(room.id, currentPlayer.id, approve);
    setTimeout(() => setIsVoting(false), 3000);
  };

  const expectedTeamSize = config?.questTeams[room.currentRound - 1] ?? 0;
  const handleSeatClick = (playerId: string): void => {
    setSelectedTeamIds(prev => {
      const next = new Set(prev);
      if (next.has(playerId)) {
        next.delete(playerId);
      } else if (next.size < expectedTeamSize) {
        next.add(playerId);
      }
      return next;
    });
  };
  const clearSelectedTeam = (): void => setSelectedTeamIds(new Set());
  const isLeaderPicking =
    room.state === 'voting' && !teamSelected && isCurrentPlayerLeader && !isSpectator;

  const handleAssassinate = (targetId: string): void => {
    if (isAssassinating) return;
    setSelectedTarget(targetId);
    setIsAssassinating(true);
    submitAssassination(room.id, currentPlayer.id, targetId);
    setTimeout(() => setIsAssassinating(false), 3000);
  };

  const alreadyVoted = room.votes[currentPlayer.id] !== undefined;
  void alreadyVoted;
  const isOnQuestTeam = room.questTeam.includes(currentPlayer.id);
  const isAssassin = currentPlayer.role === 'assassin';
  const isLadyHolder = room.ladyOfTheLakeHolder === currentPlayer.id;
  const lastLadyRecord = (room.ladyOfTheLakeHistory ?? [])[
    (room.ladyOfTheLakeHistory?.length ?? 0) - 1
  ];
  const isRecentLadyDeclarer =
    !!lastLadyRecord
    && lastLadyRecord.round === room.currentRound
    && lastLadyRecord.holderId === currentPlayer.id;

  type ActionBanner = { msg: string; color: string } | null;
  const actionBanner: ActionBanner =
    room.state === 'voting' && !teamSelected && isCurrentPlayerLeader
      ? { msg: t('game:action.leaderTurn'), color: 'border-amber-500 bg-amber-900/30 text-amber-200' }
      : room.state === 'quest' && isOnQuestTeam
      ? { msg: t('game:action.questTurn'), color: 'border-blue-500 bg-blue-900/30 text-blue-200' }
      : room.state === 'lady_of_the_lake' && isLadyHolder
      ? { msg: t('game:action.ladyTurn'), color: 'border-blue-500 bg-blue-900/30 text-blue-200' }
      : room.state === 'discussion' && isAssassin
      ? { msg: t('game:action.assassinTurn'), color: 'border-red-500 bg-red-900/30 text-red-200' }
      : null;

  const teamVotePhaseSticky =
    room.state === 'voting' && teamSelected && !isSpectator;
  const questPhaseSticky = room.state === 'quest' && !isSpectator;

  // Edward 2026-04-26 00:17 fix「投票階段正上方有黑色大空白」: GameBoard 區
  // 原本 hardcode `pb-[36dvh]` 給所有 isGameplayPhase / isEndedPhase 階段, 但
  // 黏在底部的 sticky toolbars (QuestTeamToolbar / VotePanel / QuestPanel) 只
  // 在特定子階段才 render. 非 sticky 階段 (例: voting + 非隊長 + 隊伍未選定 /
  // lady_of_the_lake / discussion / ended) 還是預留 36dvh, 形成大塊黑色空白.
  // 改成只在實際會 render sticky toolbar 時才 reserve 空間.
  //
  // Edward 2026-04-26 16:53 root fix「投票下方贊成/拒絕 上方有大塊黑色無用區塊」:
  // 之前 padding `pb-[36dvh]` 比 sticky panel 的 `max-h-[30dvh]` 多 6dvh,
  // 即使有 toolbar 也預留多餘空間, 形成 toolbar 上方一條黑帶. 三個 sticky panel
  // (VotePanel / QuestPanel / QuestTeamToolbar) 都用 `max-h-[30dvh]`, 所以 padding
  // 對齊 30dvh 即可 — 不會超出 panel 高度也不會留多餘黑塊.
  const hasStickyToolbar = isLeaderPicking || teamVotePhaseSticky || questPhaseSticky;

  // Per-table-size board watermark — 5..10 only; null falls back to lobby preview size.
  const tableCountForBoard = isLobbyPhase
    ? Math.max(playerList.length, room.maxPlayers, 5)
    : playerIds.length;
  const boardImageUrl = getBoardImage(tableCountForBoard);

  // ─── Lobby-mode per-player overlay (kick X + ready badge) ───────────
  const renderLobbyOverlay = (player: Player, _seatIndex: number, _side: 'left' | 'right') => {
    const isMe = player.id === currentPlayer.id;
    const isHostBadge = player.id === room.host;
    return (
      <>
        {!player.isBot && !isHostBadge && (
          <span className={`absolute top-1 left-9 sm:left-11 text-[8px] sm:text-[10px] px-1 py-0.5 rounded-full font-bold border z-30 ${
            readyIds.includes(player.id)
              ? 'bg-blue-900/70 border-blue-500 text-blue-200'
              : 'bg-gray-800/70 border-gray-600 text-gray-500'
          }`}>
            {readyIds.includes(player.id) ? '✓' : '…'}
          </span>
        )}
        {isHost && !isMe && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (player.isBot) removeBot(room.id, player.id);
              else kickPlayer(room.id, player.id);
            }}
            className="absolute -top-1 -right-1 p-0.5 bg-red-900/80 hover:bg-red-800 border border-red-500 text-red-100 hover:text-white rounded-full transition-colors z-40 shadow-md"
            title={player.isBot ? `移除機器人` : `踢出 ${player.name}`}
            aria-label={player.isBot ? `移除機器人 ${player.name}` : `踢出 ${player.name}`}
          >
            <X size={11} />
          </button>
        )}
      </>
    );
  };

  // ─── Phase-specific TOP SECTION ──────────────────────────────────────
  const lobbyTopSection = (
    <>
      {/* Header row — host name + tags + room code + add AI + leave + lock */}
      <div className="relative z-10 shrink-0 flex items-center justify-between gap-1 px-2 py-1 text-[clamp(0.5rem,1.7vw,0.65rem)]">
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-yellow-900/30 border border-yellow-700/60 text-yellow-200 font-semibold whitespace-nowrap min-w-0 truncate">
          <span className="hidden sm:inline">房主：</span>
          <span className="truncate">{room.players[room.host]?.name ?? '—'}</span>
        </span>

        <div className="flex items-center gap-1 flex-nowrap shrink-0">
          {(room.casual || playerList.some(p => p.isBot)) && (
            <span
              className="inline-flex items-center px-1 py-0.5 rounded-full text-[clamp(0.5rem,1.5vw,0.62rem)] font-semibold bg-amber-900/40 border border-amber-600 text-amber-200 whitespace-nowrap"
              title="此局不計 ELO"
            >
              {room.casual ? '娛樂' : '含 AI'}
            </span>
          )}
          <div className="inline-flex items-center gap-0.5 bg-avalon-card/50 border border-gray-600 rounded px-1 py-0.5 whitespace-nowrap">
            <span className="text-[clamp(0.65rem,2vw,0.85rem)] font-mono font-bold text-yellow-400 tracking-wider">
              {shortCode.slice(0, 4)}
            </span>
            <button onClick={handleCopyRoomId} className="text-gray-300 hover:text-white" title="複製代碼">
              {copied === 'code' ? <Check size={11} className="text-blue-400" /> : <Copy size={11} />}
            </button>
            <button onClick={handleCopyLink} className="text-blue-300 hover:text-blue-100 ml-0.5 border-l border-gray-700 pl-1" title="複製邀請連結">
              {copied === 'link' ? <Check size={11} className="text-amber-400" /> : <Link size={11} />}
            </button>
          </div>

          {isHost && room.state === 'lobby' && playerList.length < room.maxPlayers && (
            <button
              type="button"
              onClick={() => addBot(room.id, 'hard')}
              className="inline-flex items-center px-1.5 py-0.5 rounded border text-[clamp(0.5rem,1.5vw,0.62rem)] font-semibold bg-emerald-900/40 border-emerald-600 text-emerald-200 hover:bg-emerald-900/60 hover:text-white transition-colors whitespace-nowrap"
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
                const msg = otherHumans > 0 ? '確定離開房間？' : '確定離開？房間將解散。';
                if (!window.confirm(msg)) return;
              }
              leaveRoom(room.id);
            }}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[clamp(0.5rem,1.5vw,0.62rem)] font-semibold bg-gray-800/40 border-gray-700 text-gray-300 hover:bg-red-900/30 hover:border-red-700 hover:text-red-300 transition-colors whitespace-nowrap"
            title="離開房間"
            data-testid="lobby-leave-button"
          >
            <LogOut size={9} />
            離房
          </button>

          {isHost && (
            <button
              onClick={() => {
                if (room.isPrivate) setRoomPassword(room.id, null);
                else setShowPasswordInput(v => !v);
              }}
              className={`inline-flex items-center gap-0.5 text-[clamp(0.5rem,1.5vw,0.62rem)] px-1 py-0.5 rounded border transition-colors whitespace-nowrap ${
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

      {/* Settings strip (special roles, lake, timer, quest sizes, role chips, more rules) */}
      {previewConfig && (
        <div className="relative z-10 shrink-0 px-2 py-0.5 space-y-0.5 border-y border-gray-800/60 bg-black/20">
          {isHost && (
            <div className="flex flex-nowrap items-center gap-0.5 overflow-x-auto">
              <span className="text-[clamp(0.5rem,1.5vw,0.62rem)] uppercase tracking-wider text-gray-500 font-semibold mr-0.5 shrink-0">角色</span>
              {(Object.keys(ROLE_OPTION_INFO) as (keyof typeof ROLE_OPTION_INFO)[])
                .filter(k => k !== 'morgana')
                .map(key => {
                  const info = ROLE_OPTION_INFO[key];
                  const enabled = Boolean(((room.roleOptions as unknown) as Record<string, boolean>)?.[key]);
                  return (
                    <button
                      key={key}
                      onClick={() => handleToggleRole(key)}
                      className={`min-w-fit px-1.5 py-0.5 rounded border text-[clamp(0.6rem,1.8vw,0.75rem)] font-semibold transition-all shrink-0 whitespace-nowrap ${
                        enabled
                          ? 'bg-amber-900/40 border-amber-500 text-amber-200 shadow-sm shadow-amber-500/30'
                          : 'bg-gray-800/30 border-transparent text-gray-500 opacity-50 hover:opacity-80 hover:border-gray-600'
                      }`}
                      aria-pressed={enabled}
                      title={info.description}
                    >
                      {info.label}
                    </button>
                  );
                })}
            </div>
          )}

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
                className="bg-gray-900 border border-gray-600 rounded px-1 py-0.5 text-[clamp(0.5rem,1.5vw,0.62rem)] text-white focus:outline-none focus:border-cyan-500 shrink-0"
              >
                <option value="seat0">隊長右</option>
                <option value="random">隨機起始</option>
                {Array.from({ length: playerList.length }, (_, i) => (
                  <option key={i + 1} value={`seat${i + 1}`}>{i + 1}</option>
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
                  className="bg-gray-900 border border-gray-600 rounded px-1 py-0.5 text-[clamp(0.5rem,1.5vw,0.62rem)] text-white focus:outline-none focus:border-amber-500"
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

          {previewQuestSizes.length > 0 && (
            <div className="flex flex-nowrap items-center gap-1 text-[clamp(0.5rem,1.5vw,0.62rem)] overflow-x-auto">
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

          <div className="flex flex-nowrap items-center gap-1 text-[clamp(0.5rem,1.5vw,0.62rem)] overflow-x-auto">
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
                    isActive ? `${baseColor} shadow-sm` : 'bg-gray-800/30 border-transparent text-gray-500 opacity-50'
                  }`}
                  title={isActive ? `${ROLE_LABEL[role]} · 該局會出現` : `${ROLE_LABEL[role]} · 該局不會出現`}
                >
                  {ROLE_LABEL[role] ?? role}
                </span>
              );
            })}
          </div>

          {isHost && (
            <button
              type="button"
              onClick={() => setShowMoreRules(v => !v)}
              className="w-full flex items-center justify-between bg-gray-800/40 border border-gray-700 rounded px-2 py-0.5 text-[clamp(0.5rem,1.5vw,0.62rem)] font-bold text-gray-400 hover:border-gray-500 hover:text-white transition-colors"
              aria-expanded={showMoreRules}
              aria-controls="lobby-more-rules"
            >
              <span>更多規則</span>
              {showMoreRules ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>
          )}

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
                      className="w-full bg-gray-900 border border-gray-600 rounded px-1.5 py-0.5 text-[clamp(0.5rem,1.5vw,0.62rem)] text-white focus:outline-none focus:border-amber-500"
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

      {/*
        Edward 2026-04-26 19:31 spec 29「Lobby 加『看牌譜』按鈕」: only render
        when the room retains history from a previous game (voteHistory or
        questHistory non-empty). Click → flip `scoresheetExpanded` so the main
        area swaps GameBoard for FullScoresheetLayout (same toggle game phase
        uses). Re-click hides it. Disabled-look fallback when there's nothing
        to review (fresh lobby) — we just don't render it at all so newcomers
        aren't confused by a button that opens an empty replay.
      */}
      {(room.voteHistory.length > 0 || room.questHistory.length > 0) && (
        <div className="relative z-10 shrink-0 px-2 pb-1">
          <button
            type="button"
            onClick={() => setScoresheetExpanded(v => !v)}
            data-testid="lobby-btn-scoresheet-toggle"
            aria-pressed={scoresheetExpanded}
            className={`w-full inline-flex items-center justify-center gap-1.5 px-3 py-1 rounded-lg border text-[clamp(0.6rem,1.8vw,0.75rem)] font-semibold transition-colors ${
              scoresheetExpanded
                ? 'bg-emerald-700/40 border-emerald-500 text-emerald-100 hover:bg-emerald-700/60'
                : 'bg-slate-800/60 border-slate-600 text-slate-200 hover:bg-slate-700/60 hover:border-slate-500'
            }`}
          >
            <ClipboardList size={12} />
            {scoresheetExpanded ? '收回牌譜' : '看牌譜'}
          </button>
        </div>
      )}

      {/* Start / Ready bar */}
      <div className="relative z-10 shrink-0 px-2 py-1">
        {isHost ? (
          <div className="space-y-0.5">
            {humanPlayers.length > 0 && (
              <div className={`text-[clamp(0.5rem,1.5vw,0.62rem)] text-center py-0.5 rounded border ${
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
              className={`w-full font-bold py-1.5 px-3 rounded-lg text-[clamp(0.75rem,2.2vw,0.9rem)] transition-all flex items-center justify-center gap-2 ${
                canStart
                  ? 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white shadow-lg hover:shadow-amber-500/30'
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed'
              }`}
            >
              <Play size={14} />
              開始遊戲
              {!canStart && (
                <span className="text-[clamp(0.5rem,1.5vw,0.62rem)] opacity-80">（還需 {5 - playerList.length} 人）</span>
              )}
            </button>
          </div>
        ) : (
          <button
            onClick={() => toggleReady(room.id, currentPlayer.id)}
            className={`w-full font-bold py-1.5 px-3 rounded-lg text-[clamp(0.75rem,2.2vw,0.9rem)] transition-all flex items-center justify-center gap-2 border-2 ${
              isReady
                ? 'bg-blue-900/50 border-blue-500 text-blue-300 hover:bg-red-900/30 hover:border-red-600 hover:text-red-300'
                : 'bg-gray-800/50 border-gray-600 text-gray-300 hover:bg-blue-900/30 hover:border-blue-600 hover:text-blue-300'
            }`}
          >
            {isReady ? '✓ 已準備（點擊取消）' : '準備好了'}
          </button>
        )}
      </div>
    </>
  );

  const gameTopSection = (
    <>
      <AnimatePresence>
        {(socketStatus === 'reconnecting' || socketStatus === 'disconnected') && (
          <motion.div
            key="reconnect-banner"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className={`relative z-10 shrink-0 flex items-center gap-2 mx-3 mt-2 rounded-xl px-4 py-2 text-[11px] sm:text-xs font-semibold ${
              socketStatus === 'reconnecting'
                ? 'bg-yellow-900/60 border border-yellow-600 text-yellow-200'
                : 'bg-red-900/60 border border-red-600 text-red-200'
            }`}
          >
            {socketStatus === 'reconnecting' ? (
              <><Loader2 size={16} className="animate-spin flex-shrink-0" />{t('game:connection.reconnecting')}</>
            ) : (
              <><WifiOff size={16} className="flex-shrink-0" />{t('game:connection.disconnected')}</>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {isSpectator && (
        <div className="relative z-10 shrink-0 flex items-center justify-between mx-3 mt-2 bg-slate-800/40 border border-slate-600 rounded-xl px-4 py-1.5">
          <span className="text-slate-300 text-[11px] sm:text-xs font-semibold">{t('game:spectator.bannerTitle')}</span>
          <button
            onClick={() => leaveSpectate(room.id)}
            className="text-[10px] sm:text-[11px] text-slate-400 hover:text-white border border-slate-600 hover:border-white px-3 py-0.5 rounded-lg transition-colors"
          >
            {t('game:spectator.leave')}
          </button>
        </div>
      )}

      {/* Edward 2026-04-26 17:03 compact 2-row top header (mockup
          screenshots/avalon_top_compact_2026-04-26_1703.png):
            Row 1: R1-R5 任務軌 (mission circles only, 結果用藍紅圓圈整個蓋)
            Row 2: 否決: 4 灰格 + ⏰ 倒數 + 眼睛 + 牌譜 (右側)
          砍掉舊「Row1=否決+眼睛 / Row2=mission」分離 + 中間空白 — 對齊 Edward
          「上方排版太佔空間」原則. */}
      {/* Row 1 — mission circles */}
      <div className="relative z-10 shrink-0 px-3 pt-2">
        <MissionTrack room={room} variant="mission-only" />
      </div>

      {/* Row 2 — 否決 + countdown + eye + 牌譜 */}
      <div className="relative z-10 shrink-0 flex items-center justify-between gap-2 px-3 pt-1.5">
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <MissionTrack room={room} variant="rejection-only" />
          {room.state === 'voting' && room.questTeam.length === 0 && !isUnlimitedTimer && (
            <span
              className={`inline-flex items-center gap-1 text-[10px] sm:text-[11px] px-1.5 py-0.5 rounded-full font-semibold border ${
                teamSelectTimer < 20
                  ? 'bg-red-900/60 text-red-300 border-red-800'
                  : 'bg-gray-800/60 text-gray-400 border-gray-700'
              }`}
            >
              <Clock size={10} />
              {teamSelectTimer}s
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={() => setLoyalView(v => !v)}
            title={loyalView ? t('game:header.loyalViewOff') : t('game:header.loyalViewOn')}
            aria-label={loyalView ? t('game:header.loyalViewOff') : t('game:header.loyalViewOn')}
            aria-pressed={loyalView}
            className={`flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-full transition-colors border ${
              loyalView
                ? 'bg-yellow-500/30 hover:bg-yellow-500/50 border-yellow-400 text-yellow-200 shadow-md shadow-yellow-400/30'
                : 'bg-blue-900/40 hover:bg-blue-800/70 border-blue-700/60 text-blue-300'
            }`}
          >
            <Eye size={14} />
          </button>
          {/* Edward 2026-04-26 17:05 牌譜 toggle — 點開後主畫面整個替換為
              FullScoresheetLayout (砍 PlayerCardGrid + ChatPanel), 再點收回. */}
          <button
            onClick={() => setScoresheetExpanded(v => !v)}
            title={scoresheetExpanded ? t('game:scoresheet.collapse', { defaultValue: '收回牌譜' }) : t('game:scoresheet.expand', { defaultValue: '展開牌譜' })}
            aria-label={scoresheetExpanded ? '收回牌譜' : '展開牌譜'}
            aria-pressed={scoresheetExpanded}
            data-testid="game-btn-scoresheet-toggle"
            className={`flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-full transition-colors border ${
              scoresheetExpanded
                ? 'bg-emerald-500/30 hover:bg-emerald-500/50 border-emerald-400 text-emerald-200'
                : 'bg-slate-800/60 hover:bg-slate-700 border-slate-600 text-slate-300'
            }`}
          >
            <ClipboardList size={14} />
          </button>
        </div>
      </div>

      <AnimatePresence>
        {actionBanner && (
          <motion.div
            key={actionBanner.msg}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className={`relative z-10 shrink-0 mx-3 mt-1 flex items-center gap-2 border rounded-lg px-3 py-1.5 text-[11px] sm:text-xs font-semibold ${actionBanner.color}`}
          >
            <Bell size={14} className="flex-shrink-0" />
            {actionBanner.msg}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );

  // Edward 2026-04-25 23:39「ended → 上面應該是拿來放牌譜紀錄」: ended phase keeps the
  // gameplay top section (rejection chip + mission circles) so players can
  // review the full scoresheet before the auto-return countdown sweeps them
  // back to the lobby waiting room. No actionBanner (no live actor).
  // Edward 2026-04-26 17:03+17:05: compact 2-row + 牌譜 toggle 對齊 gameTopSection.
  const endedTopSection = (
    <>
      <div className="relative z-10 shrink-0 px-3 pt-2">
        <MissionTrack room={room} variant="mission-only" />
      </div>
      <div className="relative z-10 shrink-0 flex items-center justify-between gap-2 px-3 pt-1.5">
        <div className="flex-1 min-w-0">
          <MissionTrack room={room} variant="rejection-only" />
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={() => setScoresheetExpanded(v => !v)}
            title={scoresheetExpanded ? '收回牌譜' : '展開牌譜'}
            aria-label={scoresheetExpanded ? '收回牌譜' : '展開牌譜'}
            aria-pressed={scoresheetExpanded}
            data-testid="game-btn-scoresheet-toggle-ended"
            className={`flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-full transition-colors border ${
              scoresheetExpanded
                ? 'bg-emerald-500/30 hover:bg-emerald-500/50 border-emerald-400 text-emerald-200'
                : 'bg-slate-800/60 hover:bg-slate-700 border-slate-600 text-slate-300'
            }`}
          >
            <ClipboardList size={14} />
          </button>
        </div>
      </div>
    </>
  );

  // ─── Center column phase panel (gameplay only) ──────────────────────
  // Edward 2026-04-26 18:30-18:31 spec 7「砍遊戲資訊方塊 (只用對話紀錄)」+
  // spec 6「本次任務隊伍 chip」: 砍 teamSelected 後的 yellow「本次任務隊伍: ...」
  // 方框 — 同樣資訊從 ChatPanel 合成的「系統: R-A, L: TEAM」直接讀更精簡 + chronological.
  // 也砍 voting 階段非隊長路徑的 redundant timer chip (頂端 row2 已有 teamSelectTimer,
  // 對齊 spec 9). 留 leader-only banner (有 instructional 動作提示).
  const gameCenterPanel = (
    <>
      {room.state === 'voting' && !isSpectator && !teamSelected && isCurrentPlayerLeader && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-avalon-card/50 border-2 border-amber-500 rounded-lg p-4 sm:p-5 text-center space-y-2"
        >
          <h2 className="text-base sm:text-lg font-bold text-amber-200">
            {t('game:teamSelect.youAreLeaderBanner')}
          </h2>
          <p className="text-xs sm:text-[13px] text-amber-100">
            {t('game:teamSelect.youAreLeaderInstruction', { count: expectedTeamSize })}
          </p>
          <p className="text-[11px] sm:text-xs text-gray-400">
            {t('game:teamSelect.shieldHint')}
          </p>
        </motion.div>
      )}

      {room.state === 'lady_of_the_lake' && !isSpectator && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-avalon-card/50 border-2 border-blue-600 rounded-lg p-3 sm:p-4 space-y-3"
        >
          <motion.img
            key="lake-header"
            src={LAKE_IMAGE}
            alt=""
            aria-hidden="true"
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 280, damping: 20 }}
            className="mx-auto w-14 h-14 sm:w-20 sm:h-20 object-cover rounded-full border-2 border-cyan-400/70 shadow-lg shadow-cyan-500/30 drop-shadow-xl"
            draggable={false}
          />
          {isRecentLadyDeclarer && room.ladyOfTheLakeResult ? (
            <div className="text-center space-y-2">
              <h2 className="text-base sm:text-xl font-bold text-blue-400">{t('game:lady.title')}</h2>
              <p className="text-[11px] sm:text-xs text-gray-300">
                <Trans
                  i18nKey="game:lady.targetTeamLabel"
                  values={{
                    name: room.ladyOfTheLakeTarget
                      ? displaySeatNumber(seatOf(room.ladyOfTheLakeTarget, room.players))
                      : '',
                  }}
                  components={{ target: <span className="font-bold text-white" /> }}
                />
              </p>
              <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm sm:text-lg font-bold border-2 ${
                room.ladyOfTheLakeResult === 'good'
                  ? 'bg-blue-900/40 border-blue-500 text-blue-300'
                  : 'bg-red-900/40 border-red-500 text-red-300'
              }`}>
                <CampDisc team={room.ladyOfTheLakeResult === 'good' ? 'good' : 'evil'} className="w-4 h-4 sm:w-5 sm:h-5" />
                {room.ladyOfTheLakeResult === 'good' ? t('game:lady.resultGood') : t('game:lady.resultEvil')}
              </div>

              {lastLadyRecord?.declared ? (
                <div className="pt-1">
                  <p className="text-amber-300 text-[11px] sm:text-xs font-semibold">
                    {t('game:lady.declared', {
                      claim: lastLadyRecord.declaredClaim === 'good'
                        ? t('game:lady.declareGood')
                        : t('game:lady.declareEvil'),
                    })}
                  </p>
                </div>
              ) : (
                <div className="space-y-2 pt-1">
                  <p className="text-[10px] sm:text-[11px] text-gray-400 uppercase tracking-wider font-semibold">
                    {t('game:lady.declareTitle')}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => declareLakeResult(room.id, 'good')}
                      className="py-2 px-3 rounded-lg border-2 bg-blue-900/30 border-blue-600 text-blue-200 hover:bg-blue-800/60 font-semibold text-xs sm:text-[13px] transition-all"
                    >
                      {t('game:lady.declareGood')}
                    </button>
                    <button
                      onClick={() => declareLakeResult(room.id, 'evil')}
                      className="py-2 px-3 rounded-lg border-2 bg-red-900/30 border-red-600 text-red-200 hover:bg-red-800/60 font-semibold text-xs sm:text-[13px] transition-all"
                    >
                      {t('game:lady.declareEvil')}
                    </button>
                  </div>
                  <p className="text-[10px] sm:text-[11px] text-gray-500">{t('game:lady.declareKeepPrivate')}</p>
                  <button
                    onClick={() => skipLakeDeclaration(room.id)}
                    className="mt-1 py-1.5 px-3 rounded-lg border border-gray-600 text-gray-300 hover:bg-gray-700/40 text-[11px] sm:text-xs font-medium transition-all"
                  >
                    {t('game:lady.skipDeclaration')}
                  </button>
                </div>
              )}
            </div>
          ) : isLadyHolder && !room.ladyOfTheLakeResult ? (
            <>
              <div className="text-center">
                <h2 className="text-base sm:text-xl font-bold text-blue-400">{t('game:lady.title')}</h2>
                <p className="text-xs sm:text-sm text-gray-300 mt-1">{t('game:lady.pickTitle')}</p>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {Object.values(room.players)
                  .filter(p => p.id !== currentPlayer.id && !(room.ladyOfTheLakeUsed ?? []).includes(p.id))
                  .map((player) => (
                    <button
                      key={player.id}
                      onClick={() => submitLadyOfTheLake(room.id, currentPlayer.id, player.id)}
                      className="py-2 px-3 rounded-lg border-2 transition-all font-semibold text-xs sm:text-[13px] bg-blue-900/30 border-blue-600 text-white hover:bg-blue-800/60"
                    >
                      {displaySeatNumber(seatOf(player.id, room.players))}
                    </button>
                  ))}
              </div>
            </>
          ) : (
            <div className="text-center space-y-2">
              <h2 className="text-base sm:text-xl font-bold text-blue-400">{t('game:lady.title')}</h2>
              <p className="text-[11px] sm:text-xs text-gray-300">
                <Trans
                  i18nKey="game:lady.waitingDesc"
                  values={{
                    name: room.ladyOfTheLakeHolder
                      ? displaySeatNumber(seatOf(room.ladyOfTheLakeHolder, room.players))
                      : '',
                  }}
                  components={{ holder: <span className="text-blue-400 font-bold" /> }}
                />
              </p>
              <p className="text-gray-500 text-[10px] sm:text-[11px]">{t('game:lady.waitingNote')}</p>
            </div>
          )}
        </motion.div>
      )}

      {isSpectator && (room.state === 'voting' || room.state === 'quest' || room.state === 'lady_of_the_lake' || room.state === 'discussion') && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="bg-avalon-card/30 border border-slate-700/50 rounded-xl p-3 text-center"
        >
          <p className="text-slate-400 text-[11px] sm:text-xs">
            {room.state === 'voting' && t('game:spectator.hintVoting')}
            {room.state === 'quest' && t('game:spectator.hintQuest')}
            {room.state === 'lady_of_the_lake' && t('game:spectator.hintLady')}
            {room.state === 'discussion' && t('game:spectator.hintDiscussion')}
          </p>
        </motion.div>
      )}

      {room.state === 'discussion' && !isSpectator && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-avalon-card/50 border-2 border-red-700 rounded-lg p-3 sm:p-4 space-y-3"
        >
          {room.questHistory.length > 0 && (
            <div className="bg-gray-800/40 border border-gray-700 rounded-xl p-2">
              <p className="text-[10px] sm:text-xs text-gray-500 mb-1 font-semibold uppercase tracking-wider">{t('game:assassin.questHistoryHeader')}</p>
              <div className="space-y-1">
                {room.questHistory.map(q => (
                  <div key={q.round} className="flex items-center gap-2 text-[11px] sm:text-xs">
                    <span className={`w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center rounded-full font-bold ${q.result === 'success' ? 'bg-blue-600 text-white' : 'bg-red-600 text-white'}`}>
                      {q.result === 'success' ? '✓' : '✗'}
                    </span>
                    <span className="text-gray-400">{t('game:assassin.roundPrefix', { round: q.round })}</span>
                    <span className="text-gray-300 truncate">{q.team.map(id => displaySeatNumber(seatOf(id, room.players))).join('、')}</span>
                    {q.result === 'fail' && q.failCount > 0 && <span className="text-red-400 ml-1">{t('game:assassin.failBadge', { count: q.failCount })}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {currentPlayer.role === 'assassin' ? (
            <>
              <div className="text-center">
                <h2 className="text-base sm:text-xl font-bold text-red-400 mb-1">{t('game:assassin.title')}</h2>
                <p className="text-[11px] sm:text-xs text-gray-300">{t('game:assassin.prompt')}</p>
                {isUnlimitedTimer ? (
                  <div className="inline-flex items-center gap-2 mt-2 px-3 py-1 rounded-full font-bold text-xs bg-blue-700 text-blue-100">
                    {t('game:teamSelect.unlimitedTimer')}
                  </div>
                ) : (
                  <div className={`inline-flex items-center gap-2 mt-2 px-3 py-1 rounded-full font-bold text-xs ${assassinTimer < 30 ? 'bg-red-600 text-white' : 'bg-gray-700 text-gray-300'}`}>
                    {t('game:teamSelect.timer', { seconds: assassinTimer })}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {/*
                  Edward 2026-04-26 19:31 spec 32「紅方刺殺不能選紅方陣營」:
                  filter out evil-team players so the assassin only sees the
                  legitimate (good-team) targets — server-side GameEngine.
                  submitAssassination also rejects evil targets as a defence
                  layer, but filtering here matches the「砍掉不可選的選項」
                  pattern used elsewhere (Lady picker hides used targets,
                  team-pick toolbar hides full slots).
                  The assassin sees their own team via the role-reveal modal
                  so this UI never accidentally exposes hidden alignment
                  (only the assassin reaches this branch — `currentPlayer.role
                  === 'assassin'` is the parent guard).
                */}
                {Object.values(room.players)
                  .filter(p => p.id !== currentPlayer.id && p.team !== 'evil')
                  .map((player) => (
                    <button
                      key={player.id}
                      onClick={() => handleAssassinate(player.id)}
                      disabled={isAssassinating || selectedTarget !== null}
                      className={`py-2 px-2 rounded-lg border-2 transition-all font-semibold text-xs sm:text-[13px] ${
                        selectedTarget === player.id
                          ? 'bg-red-600/40 border-red-400 text-white'
                          : 'bg-avalon-evil/30 border-red-600 text-white hover:bg-avalon-evil/60 disabled:opacity-50'
                      }`}
                    >
                      {displaySeatNumber(seatOf(player.id, room.players))}
                      {selectedTarget === player.id && ' ✓'}
                    </button>
                  ))}
              </div>
              {selectedTarget && (
                <p className="text-center text-gray-400 text-[10px] sm:text-xs">{t('game:assassin.selectedHint')}</p>
              )}
            </>
          ) : (
            <div className="text-center space-y-2">
              <h2 className="text-base sm:text-xl font-bold text-red-400">{t('game:assassin.discussionTitle')}</h2>
              <p className="text-[11px] sm:text-xs text-gray-300">{t('game:assassin.goodWonIntro')}</p>
              <p className="text-[11px] sm:text-xs text-gray-400">{t('game:assassin.pickingTarget')}</p>
              <div className="text-[10px] sm:text-[11px] text-yellow-500 bg-yellow-900/20 border border-yellow-700 rounded-lg p-2">
                {t('game:assassin.warning')}
              </div>
            </div>
          )}
        </motion.div>
      )}

      {/* Edward 2026-04-26 19:31 spec 26-28「結束直接回 lobby (砍返回通知)」:
          砍掉「8 秒後自動回到房間」hint — switch 已縮到 1.2s, 等同瞬切;
          winner 結果由 chat 的「系統: 正義/邪惡方獲勝」line 顯示, 不需中央
          冗餘公告. 留空 (這個 branch 整個變 null) 讓 ended phase 中央區乾淨,
          牌譜可由頂端 ClipboardList toggle 全展. */}
      {/* room.state === 'ended' — intentionally renders nothing here */}
    </>
  );

  return (
    <div className="relative h-[100dvh] flex flex-col overflow-hidden bg-gradient-to-b from-avalon-dark to-black">
      {boardImageUrl && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-0 bg-no-repeat bg-center bg-cover opacity-[0.08] sm:opacity-10 mix-blend-luminosity"
          style={{ backgroundImage: `url('${boardImageUrl}')` }}
        />
      )}

      {/* Role Reveal Modal — only during gameplay phases */}
      {!isLobbyPhase && !isEndedPhase && showRoleReveal && !isSpectator && (
        <RoleRevealModal
          room={room}
          currentPlayer={currentPlayer}
          onClose={() => setShowRoleReveal(false)}
        />
      )}

      {/* ────────── TOP SECTION (phase-specific) ────────── */}
      {isLobbyPhase && lobbyTopSection}
      {isGameplayPhase && gameTopSection}
      {isEndedPhase && endedTopSection}

      {/* ────────── PHASE-INFO BANNER (Edward 2026-04-26 spec 33) ──────────
          常駐 sticky 方塊顯當下動作; 不靠 chat 訊息驅動 (避 #25 lag), 直接從
          room.state + questTeam + votes + leader/lady 派生. 只在 gameplay phases
          render (lobby/ended 不顯). scoresheet 全展模式藏起 (專注 review). */}
      {isGameplayPhase && !scoresheetExpanded && <PhaseInfoBanner room={room} />}

      {/* ────────── MAIN: GameBoard with rails + chat (phase-agnostic) ──────────
          Edward 2026-04-26 00:17 fix: 改成只在 sticky toolbar 真正 render 的子階段
          才 reserve 空間, 避免 lady / discussion / ended / 非隊長 team-pick 等
          無 sticky toolbar 階段顯出大塊黑色空白.
          Edward 2026-04-26 16:53 root fix: padding 對齊 sticky panel 的 max-h
          (30dvh), 之前 36dvh 多 6dvh 形成 toolbar 上方黑帶. */}
      <div
        className={`relative z-10 flex-1 min-h-0 flex flex-col px-2 sm:px-3 ${
          hasStickyToolbar && !scoresheetExpanded ? 'pb-[30dvh]' : 'pb-1'
        }`}
      >
        {/* Edward 2026-04-26 17:05: 牌譜全展模式 — 點頂端 ClipboardList icon 後
            主畫面整個 (rails + chat + center panel) 替換為 FullScoresheetLayout.
            不顯 10 個 PlayerCard, 不顯 ChatPanel, 也不 reserve sticky toolbar
            空間.
            Edward 2026-04-26 19:31 spec 29: lobby phase 也支援 — 房間 state
            從 ended 切回 lobby 時 voteHistory / questHistory 仍保留, 玩家可
            review 上場牌譜後再準備下一局. lobby 會用上方專屬「看牌譜」按鈕
            觸發 (gameplay/ended 用頂端 ClipboardList icon). */}
        {scoresheetExpanded && (room.voteHistory.length > 0 || room.questHistory.length > 0) ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <FullScoresheetLayout room={room} currentPlayer={currentPlayer} />
          </div>
        ) : (
          <GameBoard
            room={room}
            currentPlayer={currentPlayer}
            isPicking={isLeaderPicking}
            selectedTeamIds={selectedTeamIds}
            onSeatClick={handleSeatClick}
            loyalView={loyalView}
            lobbyMode={isLobbyPhase}
            renderPlayerOverlay={isLobbyPhase ? renderLobbyOverlay : undefined}
            chatSlot={
              <ChatPanel roomId={room.id} currentPlayerId={currentPlayer.id} variant="inline" room={room} />
            }
            // Edward 2026-04-26 18:28 spec 3「game 下方牌譜砍 (#229 右上眼睛旁
            // 已有重複)」: 砍 CompactScoresheet — 同等 toggle 已在 gameTopSection
            // 的 ClipboardList icon (eye 旁) 提供, 點開後整個主畫面切到
            // FullScoresheetLayout. 留 chat panel 獨佔 center column 下半.
            scoresheetSlot={undefined}
          >
            {(isGameplayPhase || isEndedPhase) && gameCenterPanel}
          </GameBoard>
        )}
      </div>

      {/* ────────── BOTTOM TOOLBAR (phase-specific sticky panels) ──────────
          Edward 2026-04-26 17:05: 牌譜全展時也藏 sticky toolbar — 對齊「主畫面
          整個替換」精神; 收回後 sticky 自然回來. */}
      <AnimatePresence>
        {isLeaderPicking && !scoresheetExpanded && (
          <QuestTeamToolbar
            key="quest-team-toolbar"
            room={room}
            selectedTeamIds={selectedTeamIds}
            onClear={clearSelectedTeam}
            isSubmitting={isVoting}
            timer={teamSelectTimer}
            timerTotal={teamSelectBase}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {teamVotePhaseSticky && !scoresheetExpanded && (
          <VotePanel
            key="vote-panel-sticky"
            room={room}
            currentPlayer={currentPlayer}
            onVote={handleVote}
            isLoading={isVoting}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {questPhaseSticky && !scoresheetExpanded && (
          <QuestPanel
            key="quest-panel-sticky"
            room={room}
            currentPlayer={currentPlayer}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
