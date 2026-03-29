import { useState, useEffect } from 'react';
import {
  ArrowLeft,
  Loader,
  Bot,
  Shield,
  Swords,
  Clock,
  Users,
  TrendingUp,
  AlertCircle,
} from 'lucide-react';
import { useGameStore } from '../store/gameStore';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

// ── Types ──────────────────────────────────────────────────────────────────

interface RoleWinRate {
  wins: number;
  total: number;
  rate: number;
}

interface DayCount {
  date: string;
  count: number;
}

interface AiStats {
  totalGames: number;
  goodWinRate: number;
  evilWinRate: number;
  avgRounds: number;
  roleWinRates: Record<string, RoleWinRate>;
  gamesLast7Days: DayCount[];
  playerCountBreakdown: Record<string, number>;
  scheduler?: unknown;
  message?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const ROLE_NAMES: Record<string, string> = {
  merlin:   '梅林 (Merlin)',
  percival: '派西維爾 (Percival)',
  loyal:    '忠臣 (Loyal)',
  assassin: '刺客 (Assassin)',
  morgana:  '莫甘娜 (Morgana)',
  mordred:  '莫德雷德 (Mordred)',
  oberon:   '奧伯倫 (Oberon)',
  minion:   '爪牙 (Minion)',
};

const GOOD_ROLES = new Set(['merlin', 'percival', 'loyal']);
const EVIL_ROLES = new Set(['assassin', 'morgana', 'mordred', 'oberon', 'minion']);

const ROLE_ORDER = ['merlin', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon', 'minion'];

// ── Fetch helper ───────────────────────────────────────────────────────────

async function fetchAiStats(): Promise<AiStats> {
  const res = await fetch(`${SERVER_URL}/api/ai/stats`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json() as Promise<AiStats>;
}

// ── Sub-components ─────────────────────────────────────────────────────────

function StatCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  color: string;
}): JSX.Element {
  return (
    <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4 text-center">
      <div className={`text-3xl font-black ${color}`}>{value}</div>
      <div className="text-xs text-gray-400 mt-1 flex items-center justify-center gap-1">
        {icon}
        {label}
      </div>
    </div>
  );
}

function GoodEvilBar({ goodRate, evilRate }: { goodRate: number; evilRate: number }): JSX.Element {
  // Ensure percentages fill 100% even if they don't sum perfectly
  const total = goodRate + evilRate;
  const goodPct = total > 0 ? (goodRate / total) * 100 : 50;
  const evilPct = 100 - goodPct;

  return (
    <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
      <p className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider">
        好人 vs 壞人勝率 (Good vs Evil Win Rate)
      </p>
      <div className="flex rounded-full overflow-hidden h-5 mb-2">
        <div
          className="bg-blue-600 flex items-center justify-center text-xs font-bold text-white transition-all"
          style={{ width: `${goodPct}%` }}
        >
          {goodRate > 15 ? `${goodRate}%` : ''}
        </div>
        <div
          className="bg-red-600 flex items-center justify-center text-xs font-bold text-white transition-all"
          style={{ width: `${evilPct}%` }}
        >
          {evilRate > 15 ? `${evilRate}%` : ''}
        </div>
      </div>
      <div className="flex justify-between text-xs">
        <span className="text-blue-400 font-semibold">好人方 {goodRate}%</span>
        <span className="text-red-400 font-semibold">壞人方 {evilRate}%</span>
      </div>
    </div>
  );
}

function RoleWinRates({
  roleWinRates,
}: {
  roleWinRates: Record<string, RoleWinRate>;
}): JSX.Element {
  const roles = ROLE_ORDER.filter(r => roleWinRates[r] && roleWinRates[r].total > 0);

  if (roles.length === 0) {
    return (
      <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
        <p className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider">角色勝率 (Role Win Rates)</p>
        <p className="text-center text-gray-500 text-sm py-4">尚無角色數據</p>
      </div>
    );
  }

  return (
    <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
      <p className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider">角色勝率 (Role Win Rates)</p>
      <div className="space-y-2.5">
        {roles.map(role => {
          const { wins, total, rate } = roleWinRates[role];
          const isGood = GOOD_ROLES.has(role);
          const isEvil = EVIL_ROLES.has(role);
          const barColor = isGood ? 'bg-blue-500' : isEvil ? 'bg-red-500' : 'bg-gray-500';
          const textColor = isGood ? 'text-blue-300' : isEvil ? 'text-red-300' : 'text-gray-300';
          const rateColor = rate >= 50 ? 'text-green-400' : 'text-red-400';

          return (
            <div key={role} className="flex items-center gap-2">
              <span className={`text-xs font-semibold w-36 truncate ${textColor}`}>
                {ROLE_NAMES[role] ?? role}
              </span>
              <div className="flex-1 bg-gray-800 rounded-full h-2">
                <div
                  className={`h-2 rounded-full ${barColor} transition-all`}
                  style={{ width: `${rate}%` }}
                />
              </div>
              <span className={`text-xs font-bold w-10 text-right ${rateColor}`}>{rate}%</span>
              <span className="text-xs text-gray-600 w-12 text-right">{wins}/{total}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlayerCountChart({
  breakdown,
}: {
  breakdown: Record<string, number>;
}): JSX.Element {
  const entries = [5, 6, 7, 8, 9, 10]
    .map(n => ({ pc: n, count: breakdown[String(n)] ?? 0 }))
    .filter(e => e.count > 0);

  if (entries.length === 0) {
    return (
      <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
        <p className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider">
          人數分佈 (Player Count Distribution)
        </p>
        <p className="text-center text-gray-500 text-sm py-4">尚無數據</p>
      </div>
    );
  }

  const maxCount = Math.max(...entries.map(e => e.count));
  const W = 300, H = 100, PAD_X = 10, PAD_Y = 10, BAR_GAP = 6;
  const barWidth = (W - PAD_X * 2 - BAR_GAP * (entries.length - 1)) / entries.length;

  return (
    <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
      <p className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider">
        人數分佈 (Player Count Distribution)
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 100 }}>
        {entries.map((e, i) => {
          const barH = maxCount > 0 ? ((e.count / maxCount) * (H - PAD_Y * 2 - 16)) : 0;
          const x = PAD_X + i * (barWidth + BAR_GAP);
          const y = H - PAD_Y - 14 - barH;
          return (
            <g key={e.pc}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barH}
                rx={3}
                fill="#3b82f6"
                opacity="0.8"
              />
              {/* Count label above bar */}
              <text
                x={x + barWidth / 2}
                y={y - 2}
                textAnchor="middle"
                fontSize="8"
                fill="#93c5fd"
              >
                {e.count}
              </text>
              {/* Player count label below bar */}
              <text
                x={x + barWidth / 2}
                y={H - PAD_Y}
                textAnchor="middle"
                fontSize="9"
                fill="#6b7280"
              >
                {e.pc}P
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ActivitySparkline({ days }: { days: DayCount[] }): JSX.Element {
  if (days.length < 2) return <></>;

  const counts = days.map(d => d.count);
  const maxCount = Math.max(...counts, 1);
  const W = 320, H = 80, PAD = 12;
  const toX = (i: number) => PAD + (i / (days.length - 1)) * (W - PAD * 2);
  const toY = (v: number) => PAD + (1 - v / maxCount) * (H - PAD * 2);

  const pathD = counts.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  const areaD =
    pathD +
    ` L${toX(days.length - 1).toFixed(1)},${(H - PAD).toFixed(1)}` +
    ` L${toX(0).toFixed(1)},${(H - PAD).toFixed(1)} Z`;

  const total7 = counts.reduce((a, b) => a + b, 0);

  return (
    <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">
          近 7 日活躍度 (Last 7 Days Activity)
        </p>
        <span className="text-xs text-purple-400 font-semibold">{total7} 局</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 80 }}>
        <defs>
          <linearGradient id="ai-sparkline-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a855f7" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#a855f7" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#ai-sparkline-fill)" />
        <path d={pathD} fill="none" stroke="#a855f7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {counts.map((v, i) => (
          <circle key={i} cx={toX(i)} cy={toY(v)} r="3" fill="#a855f7" />
        ))}
        {/* Date labels for first and last */}
        <text x={toX(0)} y={H - 2} textAnchor="middle" fontSize="8" fill="#6b7280">
          {days[0]?.date.slice(5)}
        </text>
        <text x={toX(days.length - 1)} y={H - 2} textAnchor="middle" fontSize="8" fill="#a855f7">
          {days[days.length - 1]?.date.slice(5)}
        </text>
      </svg>
      {/* Day-by-day mini labels */}
      <div className="flex justify-between mt-1">
        {days.map(d => (
          <div key={d.date} className="flex flex-col items-center gap-0.5">
            <span className="text-xs font-bold text-gray-300">{d.count}</span>
            <span className="text-[9px] text-gray-600">{d.date.slice(8)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function AiStatsPage(): JSX.Element {
  const { setGameState } = useGameStore();
  const [stats, setStats] = useState<AiStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchAiStats()
      .then(setStats)
      .catch(() => setError('無法載入 AI 統計資料'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen p-4">
      <div className="max-w-lg mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setGameState('home')}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-avalon-card/50 transition-all"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="flex items-center gap-2">
            <Bot size={22} className="text-purple-400" />
            <h1 className="text-2xl font-black text-white">AI 自對弈統計</h1>
          </div>
          <span className="text-sm text-gray-500 mt-0.5">(AI Self-Play Statistics)</span>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex justify-center pt-10">
            <Loader size={32} className="animate-spin text-purple-400" />
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-900/50 border border-red-600 rounded-xl p-4 flex items-center gap-3 text-red-200 text-sm">
            <AlertCircle size={18} className="flex-shrink-0" />
            {error}
          </div>
        )}

        {stats && (
          <>
            {/* Stats cards 2x2 */}
            <div className="grid grid-cols-2 gap-3">
              <StatCard
                icon={<Bot size={12} />}
                label="總對局數 (Total Games)"
                value={stats.totalGames.toLocaleString()}
                color="text-purple-400"
              />
              <StatCard
                icon={<Clock size={12} />}
                label="平均回合數 (Avg Rounds)"
                value={stats.avgRounds > 0 ? stats.avgRounds : '—'}
                color="text-yellow-400"
              />
              <StatCard
                icon={<Shield size={12} />}
                label="好人勝率 (Good Win Rate)"
                value={stats.totalGames > 0 ? `${stats.goodWinRate}%` : '—'}
                color="text-blue-400"
              />
              <StatCard
                icon={<Swords size={12} />}
                label="壞人勝率 (Evil Win Rate)"
                value={stats.totalGames > 0 ? `${stats.evilWinRate}%` : '—'}
                color="text-red-400"
              />
            </div>

            {/* Good vs Evil bar */}
            {stats.totalGames > 0 && (
              <GoodEvilBar goodRate={stats.goodWinRate} evilRate={stats.evilWinRate} />
            )}

            {/* Role win rates */}
            <RoleWinRates roleWinRates={stats.roleWinRates} />

            {/* Player count breakdown */}
            <PlayerCountChart breakdown={stats.playerCountBreakdown} />

            {/* Activity sparkline */}
            {stats.gamesLast7Days.length > 0 && (
              <ActivitySparkline days={stats.gamesLast7Days} />
            )}

            {/* No data message */}
            {stats.totalGames === 0 && (
              <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-6 text-center">
                <Users size={32} className="text-gray-600 mx-auto mb-3" />
                <p className="text-gray-400 text-sm">尚未有 AI 自對弈數據</p>
                <p className="text-gray-600 text-xs mt-1">No AI self-play data available yet</p>
              </div>
            )}

            {/* Footer note */}
            <div className="text-center">
              <p className="text-xs text-gray-600">
                <TrendingUp size={10} className="inline mr-1" />
                數據來自 AI 機器人自對弈訓練局 (Data from AI bot self-play training games)
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
