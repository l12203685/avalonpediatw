/** vite.config.ts 的 '@wiki-bundle' = packages/server/wiki_data.json (百科文章備份，API 失敗時才載入)。 */
declare module '@wiki-bundle' {
  import type { WikiArticleApi } from './services/api';
  const articles: WikiArticleApi[];
  export default articles;
}
