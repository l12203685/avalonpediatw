import { useState } from 'react';
import { motion } from 'framer-motion';
import { Play, Video, ExternalLink } from 'lucide-react';
import { type RoleVideo, videoUrl } from '../data/roleVideos';

interface RoleVideoCardProps {
  video: RoleVideo;
}

/**
 * Embedded short-video player for a single role.
 *
 * Behavior:
 * - When VITE_R2_PUBLIC_BASE is set: shows an HTML5 <video> player with
 *   R2-hosted mp4. Supports seek (Range headers configured in R2 CORS).
 * - When not set (pre-M0.4 bucket creation): shows a "video coming soon"
 *   placeholder so the page degrades gracefully.
 *
 * See docs/M0.5_r2_spike.md for upload checklist and CORS config.
 */
export default function RoleVideoCard({ video }: RoleVideoCardProps): JSX.Element {
  const [playing, setPlaying] = useState(false);
  const url = videoUrl(video.slug);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="bg-avalon-card/60 border border-yellow-500/30 rounded-lg overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-700/50">
        <Video size={16} className="text-yellow-400 shrink-0" />
        <span className="text-sm font-bold text-white flex-1 truncate">
          {video.title_zh}
        </span>
        <span className="text-[10px] text-gray-500 shrink-0">短影音 Shorts</span>
      </div>

      {/* Player or placeholder */}
      {url ? (
        <div className="relative bg-black aspect-[9/16] max-h-[420px] mx-auto">
          {!playing ? (
            /* Thumbnail overlay — click to start */
            <button
              onClick={() => setPlaying(true)}
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 hover:bg-black/50 transition-colors"
              aria-label={`播放 ${video.title_zh}`}
            >
              <div className="w-14 h-14 rounded-full bg-yellow-500/90 flex items-center justify-center shadow-lg">
                <Play size={28} className="text-black ml-1" fill="currentColor" />
              </div>
              <span className="text-white text-sm font-semibold">{video.title_zh}</span>
            </button>
          ) : (
            <video
              src={url}
              controls
              autoPlay
              playsInline
              className="w-full h-full object-contain"
            >
              您的瀏覽器不支援 HTML5 影片播放。(Your browser does not support HTML5 video.)
            </video>
          )}
        </div>
      ) : (
        /* R2 bucket not yet live — graceful placeholder */
        <div className="flex flex-col items-center justify-center gap-3 py-10 px-4 text-center bg-gray-900/40">
          <div className="w-12 h-12 rounded-full bg-gray-700 flex items-center justify-center">
            <Play size={22} className="text-gray-500 ml-0.5" />
          </div>
          <p className="text-gray-400 text-sm">影片即將上線 (Video coming soon)</p>
          <p className="text-gray-600 text-xs max-w-[200px]">
            短影音將於 R2 儲存桶建立後啟用 (Available after R2 bucket setup)
          </p>
          <a
            href={`https://www.youtube.com/@AvalonPediaTW`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-yellow-400 hover:text-yellow-300 text-xs transition-colors"
          >
            <ExternalLink size={12} />
            前往 YouTube 頻道
          </a>
        </div>
      )}

      {/* Footer note */}
      <div className="px-4 py-2 text-[10px] text-gray-600 text-center border-t border-gray-700/50">
        © Edward Lin · All Rights Reserved · @AvalonPediaTW
      </div>
    </motion.div>
  );
}
