/** vite.config.ts 的 '@wiki-bundle' = packages/server/wiki_data.json (百科文章備份，一進百科就先載入，API 回來後換成 API 的版本)。 */
declare module '@wiki-bundle' {
  import type { WikiArticleApi } from './services/api';
  const articles: WikiArticleApi[];
  export default articles;
}
