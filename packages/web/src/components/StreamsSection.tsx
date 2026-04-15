import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, Eye, Calendar, Clock, Youtube, ArrowDown, ArrowUp, LayoutGrid, List } from 'lucide-react';
import streamsData from '../data/streams.json';

interface Stream {
  videoId: string;
  title: string;
  duration: number;
  viewCount: number;
  uploadDate: string; // YYYYMMDD
  description: string;
}

interface StreamsFile {
  channel: string;
  channelUrl: string;
  fetchedAt: string;
  count: number;
  streams: Stream[];
}

type SortKey = 'date' | 'duration' | 'views';
type ViewMode = 'grid' | 'timeline';

const STREAMS = streamsData as StreamsFile;

// Extract season (S1/S2/S3/S4/S5) from a stream title. Returns 'Other' when none.
function extractSeason(title: string): string {
  const m = title.match(/S\s*([1-9])/i);
  if (m) return `S${m[1]}`;
  return 'Other';
}

// Extract EP number (EP01, EP 02, etc.) from title, returns null when absent.
function extractEpisode(title: string): number | null {
  const m = title.match(/EP\s*0*(\d+)/i);
  return m ? Number(m[1]) : null;
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDate(ymd: string): string {
  if (!ymd || ymd.length !== 8) return '';
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function formatViews(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}萬`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export default function StreamsSection(): JSX.Element {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDesc, setSortDesc] = useState(true);
  const [selected, setSelected] = useState<Stream | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const list = STREAMS.streams.filter((s) =>
      !q || s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
    const sorted = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'date') cmp = a.uploadDate.localeCompare(b.uploadDate);
      else if (sortKey === 'duration') cmp = a.duration - b.duration;
      else cmp = a.viewCount - b.viewCount;
      return sortDesc ? -cmp : cmp;
    });
    return sorted;
  }, [search, sortKey, sortDesc]);

  // Group by season for timeline view (keeps filtered/sorted order within each season).
  const bySeason = useMemo(() => {
    const groups: Record<string, Stream[]> = {};
    for (const s of filtered) {
      const key = extractSeason(s.title);
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    }
    // Order: S5, S4, S3, S2, S1, Other (newest season first)
    const order = ['S5', 'S4', 'S3', 'S2', 'S1', 'Other'];
    return order
      .filter((k) => groups[k] && groups[k].length > 0)
      .map((k) => ({ season: k, items: groups[k] }));
  }, [filtered]);

  const toggleSort = (key: SortKey): void => {
    if (sortKey === key) {
      setSortDesc((v) => !v);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  const SortButton = ({ label, myKey }: { label: string; myKey: SortKey }): JSX.Element => (
    <button
      onClick={() => toggleSort(myKey)}
      className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold transition-all border ${
        sortKey === myKey
          ? 'bg-yellow-500 text-black border-yellow-500'
          : 'bg-avalon-card/50 text-gray-300 border-gray-600 hover:border-yellow-500'
      }`}
    >
      {label}
      {sortKey === myKey && (sortDesc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
    </button>
  );

  return (
    <section className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-2">
          <Youtube size={26} className="text-red-500" />
          <h2 className="text-2xl font-bold text-white">直播回顧 (Past Live Streams)</h2>
          <span className="text-xs text-gray-400">· {STREAMS.count} 場</span>
        </div>
        <a
          href={STREAMS.channelUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-yellow-400 hover:text-yellow-300 underline"
        >
          {STREAMS.channel}
        </a>
      </div>

      {/* Search + sort */}
      <div className="flex flex-col md:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜尋直播標題或描述 (Search streams)..."
            className="w-full bg-avalon-card/50 border border-gray-600 rounded-lg pl-10 pr-10 py-2 text-white text-sm placeholder-gray-400 focus:border-yellow-400 focus:outline-none"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-400">排序:</span>
          <SortButton label="日期" myKey="date" />
          <SortButton label="長度" myKey="duration" />
          <SortButton label="觀看" myKey="views" />
          <span className="text-xs text-gray-400 ml-2">檢視:</span>
          <button
            onClick={() => setViewMode('grid')}
            aria-label="Grid view"
            className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold transition-all border ${
              viewMode === 'grid'
                ? 'bg-yellow-500 text-black border-yellow-500'
                : 'bg-avalon-card/50 text-gray-300 border-gray-600 hover:border-yellow-500'
            }`}
          >
            <LayoutGrid size={12} />
            格狀
          </button>
          <button
            onClick={() => setViewMode('timeline')}
            aria-label="Timeline view"
            className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold transition-all border ${
              viewMode === 'timeline'
                ? 'bg-yellow-500 text-black border-yellow-500'
                : 'bg-avalon-card/50 text-gray-300 border-gray-600 hover:border-yellow-500'
            }`}
          >
            <List size={12} />
            賽季時間線
          </button>
        </div>
      </div>

      {/* Grid / Timeline */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-400">沒有符合的直播 (No streams match)</div>
      ) : viewMode === 'timeline' ? (
        <div className="space-y-8">
          {bySeason.map(({ season, items }) => (
            <div key={season} className="relative">
              <div className="sticky top-0 z-10 bg-gradient-to-r from-yellow-500/20 to-transparent backdrop-blur-sm border-l-4 border-yellow-500 pl-3 py-2 mb-4">
                <h3 className="text-lg font-bold text-yellow-300">
                  {season === 'Other' ? '其他 (Other)' : `賽季 ${season} (Season ${season.slice(1)})`}
                  <span className="text-xs text-gray-400 ml-2 font-normal">· {items.length} 場</span>
                </h3>
              </div>
              <ol className="relative border-l-2 border-gray-700 ml-2 space-y-3">
                {items.map((s) => {
                  const ep = extractEpisode(s.title);
                  return (
                    <li key={s.videoId} className="ml-4">
                      <span className="absolute -left-2 w-3 h-3 bg-yellow-500 rounded-full mt-2 border-2 border-avalon-dark" />
                      <button
                        onClick={() => setSelected(s)}
                        className="w-full text-left bg-avalon-card/40 hover:bg-avalon-card/70 border border-gray-600 hover:border-yellow-400 rounded-lg p-3 transition-all flex gap-3 items-start"
                      >
                        <img
                          src={`https://i.ytimg.com/vi/${s.videoId}/default.jpg`}
                          alt=""
                          loading="lazy"
                          className="w-24 h-16 object-cover rounded shrink-0 bg-black"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            {ep !== null && (
                              <span className="inline-block bg-yellow-500/20 text-yellow-300 text-xs px-1.5 py-0.5 rounded font-mono">
                                EP{ep.toString().padStart(2, '0')}
                              </span>
                            )}
                            <span className="text-xs text-gray-400 inline-flex items-center gap-1">
                              <Calendar size={11} />
                              {formatDate(s.uploadDate)}
                            </span>
                          </div>
                          <h4 className="text-sm font-semibold text-white line-clamp-2">{s.title}</h4>
                          <div className="flex items-center gap-3 text-xs text-gray-400 mt-1">
                            <span className="inline-flex items-center gap-1">
                              <Clock size={11} />
                              {formatDuration(s.duration)}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Eye size={11} />
                              {formatViews(s.viewCount)}
                            </span>
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((s) => (
            <motion.button
              key={s.videoId}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => setSelected(s)}
              className="text-left bg-avalon-card/40 hover:bg-avalon-card/70 border border-gray-600 hover:border-yellow-400 rounded-lg overflow-hidden transition-all"
            >
              <div className="relative aspect-video bg-black">
                <img
                  src={`https://i.ytimg.com/vi/${s.videoId}/hqdefault.jpg`}
                  alt={s.title}
                  loading="lazy"
                  className="w-full h-full object-cover"
                />
                <div className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded">
                  {formatDuration(s.duration)}
                </div>
              </div>
              <div className="p-3">
                <h3 className="text-sm font-semibold text-white line-clamp-2 mb-2">{s.title}</h3>
                <div className="flex items-center gap-3 text-xs text-gray-400">
                  <span className="inline-flex items-center gap-1">
                    <Calendar size={12} />
                    {formatDate(s.uploadDate)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Eye size={12} />
                    {formatViews(s.viewCount)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock size={12} />
                    {formatDuration(s.duration)}
                  </span>
                </div>
              </div>
            </motion.button>
          ))}
        </div>
      )}

      {/* Player modal */}
      <AnimatePresence>
        {selected && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
            onClick={() => setSelected(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-avalon-card border border-yellow-500 rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-start justify-between p-4 border-b border-gray-700">
                <h3 className="text-base md:text-lg font-bold text-white flex-1 pr-4">{selected.title}</h3>
                <button
                  onClick={() => setSelected(null)}
                  className="text-gray-400 hover:text-white shrink-0"
                  aria-label="Close"
                >
                  <X size={22} />
                </button>
              </div>
              <div className="aspect-video bg-black">
                <iframe
                  src={`https://www.youtube-nocookie.com/embed/${selected.videoId}?rel=0`}
                  title={selected.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                  referrerPolicy="strict-origin-when-cross-origin"
                  className="w-full h-full border-0"
                />
              </div>
              <div className="p-4 space-y-3">
                <div className="flex flex-wrap gap-4 text-xs text-gray-400">
                  <span className="inline-flex items-center gap-1">
                    <Calendar size={14} />
                    {formatDate(selected.uploadDate)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Eye size={14} />
                    {selected.viewCount.toLocaleString()} 次觀看
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock size={14} />
                    {formatDuration(selected.duration)}
                  </span>
                  <a
                    href={`https://www.youtube.com/watch?v=${selected.videoId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-yellow-400 hover:text-yellow-300 underline ml-auto"
                  >
                    在 YouTube 觀看 ↗
                  </a>
                </div>
                {selected.description && (
                  <p className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                    {selected.description}
                  </p>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
