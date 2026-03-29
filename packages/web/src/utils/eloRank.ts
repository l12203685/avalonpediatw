/**
 * ELO rank tier system
 * Default starting ELO is 1000 (中堅 tier).
 * Ranks spread above/below based on win/loss history (+20/-15 per game).
 */

export interface EloRank {
  label: string;
  color: string;      // Tailwind text color class
  bgColor: string;    // Tailwind bg color class
  borderColor: string; // Tailwind border color class
  min: number;
}

export const ELO_RANKS: EloRank[] = [
  { label: '新手',  color: 'text-gray-400',   bgColor: 'bg-gray-700/50',    borderColor: 'border-gray-600',   min: 0    },
  { label: '見習',  color: 'text-green-400',  bgColor: 'bg-green-900/40',   borderColor: 'border-green-700',  min: 850  },
  { label: '中堅',  color: 'text-blue-400',   bgColor: 'bg-blue-900/40',    borderColor: 'border-blue-700',   min: 950  },
  { label: '老手',  color: 'text-purple-400', bgColor: 'bg-purple-900/40',  borderColor: 'border-purple-700', min: 1050 },
  { label: '精英',  color: 'text-yellow-400', bgColor: 'bg-yellow-900/40',  borderColor: 'border-yellow-700', min: 1150 },
  { label: '大師',  color: 'text-orange-400', bgColor: 'bg-orange-900/40',  borderColor: 'border-orange-700', min: 1300 },
  { label: '傳奇',  color: 'text-red-400',    bgColor: 'bg-red-900/40',     borderColor: 'border-red-700',    min: 1500 },
];

export function getEloRank(elo: number): EloRank {
  let rank = ELO_RANKS[0];
  for (const r of ELO_RANKS) {
    if (elo >= r.min) rank = r;
  }
  return rank;
}
