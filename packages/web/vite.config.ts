import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Build-time VERSION.txt emitter (2026-04-24).
 *
 * Writes a `VERSION.txt` file into the final `dist/` output so the deployed
 * bundle carries a verifiable build marker that can be retrieved via plain
 * HTTP (e.g. `curl https://avalon.pediatw.com/VERSION.txt`).
 *
 * Format (Taipei timezone +08):
 *   dev-YYYYMMDDHHMM<newline>hash=<short-hash><newline>tz=+08<newline>
 *
 * Subagent completion reports cite this value as the "上線版本號" to prove the
 * bundle actually shipped matches what was claimed. Matches the backend
 * `/api/version` dev fallback format (`dev-${boot-time}`) so front/back stay
 * aligned when no CI-injected hash is present.
 */
function versionTxtPlugin(): Plugin {
  // Compute build stamp once at config load so Vite's generateBundle can emit
  // it via the asset pipeline (more reliable than closeBundle + fs.writeFile,
  // which can race with Vite's own output finalization).
  const now = new Date();
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const yyyy = taipei.getUTCFullYear();
  const mm = String(taipei.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(taipei.getUTCDate()).padStart(2, '0');
  const hh = String(taipei.getUTCHours()).padStart(2, '0');
  const mi = String(taipei.getUTCMinutes()).padStart(2, '0');
  const stamp = `${yyyy}${mm}${dd}${hh}${mi}`;

  const hash =
    process.env.BUILD_HASH ||
    process.env.RENDER_GIT_COMMIT ||
    process.env.SOURCE_COMMIT ||
    'local';
  const shortHash = hash.slice(0, 12);

  const content =
    `dev-${stamp}\n` +
    `hash=${shortHash}\n` +
    `builtAt=${yyyy}-${mm}-${dd}T${hh}:${mi}:00+08:00\n` +
    `tz=+08\n`;

  return {
    name: 'avalon-version-txt',
    apply: 'build',
    generateBundle() {
      // Use Rollup's native asset emit so the file lands next to index.html
      // through the normal output pipeline — survives outDir overrides and
      // works on both Windows and POSIX.
      this.emitFile({
        type: 'asset',
        fileName: 'VERSION.txt',
        source: content,
      });
    },
    closeBundle() {
      // Surface to build log so operators (and subagent reports) can grab it
      // without opening the file.
      // eslint-disable-next-line no-console
      console.log(`[version] emitted VERSION.txt -> dev-${stamp} (${shortHash})`);
    },
  };
}

export default defineConfig({
  plugins: [react(), versionTxtPlugin()],
  base: process.env.VITE_BASE || '/',
  define: {
    // Injected at build time so the client bundle can read its own build stamp
    // (e.g. for a version banner or diagnostic tooltip).
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared/src'),
      '@avalon/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
});
