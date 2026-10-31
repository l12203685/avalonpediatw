import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { WIKI_ARTICLES, WIKI_CATEGORIES, WIKI_DATA_ARTICLE_ROLE, WIKI_ROLE_NAMES } from './src/data/wiki';
import { buildLlmsFiles, buildNoscriptHtml, type LlmsArticle, type LlmsOptions } from './src/utils/llmsTxt';

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

/**
 * 給 AI／爬蟲讀的純文字版本（2026-10-31，見 src/utils/llmsTxt.ts）：每次 build 從 wiki_data.json 與 data/wiki.ts
 * 產生 llms.txt、llms-full.txt、wiki-md/<id>.md、sitemap.xml，並在 index.html 放 <noscript> 目錄；dev server 也
 * 即時提供同樣的檔案。網址：SITE_URL（預設 Firebase 主站）、VITE_SERVER_URL（API；本機網址時改用正式 API）。
 */
const DEFAULT_SITE_URL = 'https://avalon-game-platform.web.app';
const DEFAULT_API_URL = 'https://avalon-server-z6c0-cs0s.onrender.com';
const REPO_URL = 'https://github.com/l12203685/avalonpediatw';
const WIKI_DATA = path.resolve(__dirname, '../server/wiki_data.json');

function llmsInputs(): { articles: LlmsArticle[]; opts: LlmsOptions } {
  const json = JSON.parse(fs.readFileSync(WIKI_DATA, 'utf-8')) as LlmsArticle[];
  const envApi = process.env.VITE_SERVER_URL ?? '';
  const apiUrl = /^https:\/\//.test(envApi) && !/localhost|127\.0\.0\.1/.test(envApi) ? envApi : DEFAULT_API_URL;
  const notes: Record<string, string> = {};
  for (const [id, role] of Object.entries(WIKI_DATA_ARTICLE_ROLE)) {
    notes[id] = `網站上本文開頭有「${WIKI_ROLE_NAMES[role] ?? role}實戰數據（即時）」數據卡，純文字版沒有；數字請讀 ${apiUrl.replace(/\/+$/, '')}/api/analysis/overview。`;
  }
  return {
    // 前端寫死的文章（角色數據、新手常見問題）在前，同 data/wiki.ts mergeWikiArticles
    articles: [...WIKI_ARTICLES.map(({ id, title, category, content, tags, excerpt, status }) => ({ id, title, category, content, tags, excerpt, status })), ...json],
    opts: {
      siteUrl: process.env.SITE_URL || DEFAULT_SITE_URL,
      apiUrl,
      repoUrl: REPO_URL,
      categories: WIKI_CATEGORIES,
      notes,
      sitePages: ['/', '/wiki', '/analysis', '/leaderboard'],
    },
  };
}

function llmsFilesPlugin(): Plugin {
  const contentType = (file: string): string =>
    file.endsWith('.md') ? 'text/markdown; charset=utf-8' : file.endsWith('.xml') ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8';
  return {
    name: 'avalon-llms-files',
    generateBundle() {
      const { articles, opts } = llmsInputs();
      const files = buildLlmsFiles(articles, opts);
      for (const [fileName, source] of Object.entries(files)) this.emitFile({ type: 'asset', fileName, source });
      // eslint-disable-next-line no-console
      console.log(`[llms] emitted ${Object.keys(files).length} files (llms.txt, llms-full.txt, sitemap.xml, wiki-md/*.md) for ${opts.siteUrl}`);
    },
    transformIndexHtml(html) {
      const { articles, opts } = llmsInputs();
      return html.replace('<!--llms-noscript-->', buildNoscriptHtml(articles, opts));
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\//, '');
        if (!/^(llms(-full)?\.txt|sitemap\.xml|wiki-md\/.+\.md)$/.test(url)) return next();
        const { articles, opts } = llmsInputs();
        const files = buildLlmsFiles(articles, { ...opts, siteUrl: `http://${req.headers.host ?? 'localhost'}` });
        const body = files[url] ?? files[url.replace(/^wiki-md\/(.+)\.md$/, (_m, id: string) => `wiki-md/${encodeURIComponent(id)}.md`)];
        if (body === undefined) return next();
        res.setHeader('Content-Type', contentType(url));
        res.end(body);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionTxtPlugin(), llmsFilesPlugin()],
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
      // 百科文章的備份 (Edward 2026-10-28：伺服器休眠或連不上時百科照樣能看)：伺服器的 wiki_data.json 打包成
      // 獨立的 chunk，只有 API 失敗時才載入 (型別見 src/wikiBundle.d.ts)。
      '@wiki-bundle': path.resolve(__dirname, '../server/wiki_data.json'),
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
