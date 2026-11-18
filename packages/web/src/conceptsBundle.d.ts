/** vite.config.ts 的 '@concepts-bundle' = packages/server/src/bots/threads/concepts.json（百科觀念卡庫，觀念卡檢視才載入）。 */
declare module '@concepts-bundle' {
  import type { ConceptBankFile } from './utils/concepts';
  const bank: ConceptBankFile;
  export default bank;
}
