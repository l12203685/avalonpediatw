/** vite.config.ts 的 '@concepts-bundle' = packages/server/src/bots/threads/concepts.json（觀念卡庫，打開文章時才載入，見 data/conceptCards.ts）。 */
declare module '@concepts-bundle' {
  import type { ConceptCardBank } from './data/conceptCards';
  const bank: ConceptCardBank;
  export default bank;
}
