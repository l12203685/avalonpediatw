/**
 * AI 擂台（站長 2026-11-26「提供個人AI的雛形 … 以後就可以是一堆自建AI對戰」）：社群機器人可以調的開關白名單。
 *
 * 一隻社群機器人 = 百科AI 的引擎（`HeuristicAgent`，正式預設 `DEFAULT_AGENT_TUNING`）＋ 作者在 profile.json 裡選的風格開關。
 * 只開放這裡列出的 `AgentTuning` 欄位，每個都有範圍；其餘三百多個欄位（邏輯防護、信念校準、量測用的開關）不開放，
 * 所以社群機器人永遠守 A0／A1 硬規則（例如好人上任務一律出成功），也不會改到網站上正在跑的百科AI。
 *
 * 每個開關都用 `arena:knobs` 量過「改了真的會改變打法」（docs/BOTS.md〈AI 擂台〉）；量不出差別的不放進來。
 * README 的開關表由 `arena:knobs --table` 從這份清單產生，改這裡就重產表格。
 */
import type { AgentTuning } from '../ai/AgentTuning';

export type KnobSide = 'good' | 'evil' | 'assassin';

interface KnobBase {
  key: keyof AgentTuning;
  /** 主要影響哪一邊（文件分組用；放在別的區塊不會錯，只是沒有作用）。 */
  side: KnobSide;
  /** 繁中一句話：白話、看得懂。 */
  zh: string;
  /** English, one line. */
  en: string;
  /** 往上調／打開會怎樣（繁中）。 */
  zhUp: string;
  /** 往下調／關掉會怎樣（繁中）。 */
  zhDown: string;
}

export interface NumberKnob extends KnobBase {
  kind: 'number';
  min: number;
  max: number;
}

export interface BooleanKnob extends KnobBase {
  kind: 'boolean';
}

export type Knob = NumberKnob | BooleanKnob;

export const ARENA_KNOBS: readonly Knob[] = [
  // ── 紅方 ──────────────────────────────────────────────
  {
    key: 'redHideHuman', kind: 'boolean', side: 'evil',
    zh: '第 1、2 局自己是隊上唯一看得到的紅時，照強者紅方的比例偶爾出成功藏身。',
    en: 'Rounds 1-2, sole visible red on the team: sometimes play success to hide, at strong human rates.',
    zhUp: '開（預設）：早期偶爾藏牌，比較不容易被讀出來。',
    zhDown: '關：改走舊規則（第 1 局刺客／莫甘娜落單一律出成功藏身）。',
  },
  {
    key: 'redNormalVote', kind: 'number', side: 'evil', min: 0, max: 1,
    zh: '第 3 局起不在隊上時，照「只看公開紀錄的忠臣」那樣投票的比例（偽裝成雜魚）。',
    en: 'From round 3, off the team: share of votes cast like a public-info loyal would (camouflage).',
    zhUp: '1（預設）：票看起來像好人，難抓。',
    zhDown: '越低越常照紅方利益投（有隊友的隊投白、沒隊友的投黑），比較衝也比較好認。',
  },
  {
    key: 'redCleanWhite', kind: 'number', side: 'evil', min: 0, max: 1,
    zh: '偽裝投票時，隊上沒有自己看得到的紅、忠臣會投黑的隊，改投白的比例。',
    en: 'While camouflaging: chance to approve a clean-looking team that a loyal would reject.',
    zhUp: '越高越常放行乾淨的隊，看起來比較隨和。',
    zhDown: '0（預設）：照忠臣的票。',
  },
  {
    key: 'redCleanApprove', kind: 'number', side: 'evil', min: 0, max: 1,
    zh: '第 3 局起不在隊上、隊上沒有看得到的紅時贊成的機率。',
    en: 'From round 3, off the team and no visible red on it: chance to approve.',
    zhUp: '越高越常放行沒有隊友的隊。',
    zhDown: '0（預設）：不額外贊成。',
  },
  {
    key: 'redStackRate65', kind: 'number', side: 'evil', min: 0, max: 1,
    zh: '第 3、5 局紅方當隊長時，多帶一位隊友上任務的比例。',
    en: 'Rounds 3 and 5 as red leader: how often to bring one extra teammate.',
    zhUp: '越高越常疊隊友（失敗牌比較穩，但隊伍比較好認）。',
    zhDown: '0：不多帶隊友。預設 0.5。',
  },
  {
    key: 'redR1Teammate', kind: 'boolean', side: 'evil',
    zh: '紅方第 1 局當隊長時，前四次提議有時（約一半）放一位隊友。',
    en: 'Red leader in round 1: about half of the first four proposals include a teammate.',
    zhUp: '開（預設）：像真人，偶爾帶隊友。',
    zhDown: '關：第 1 局一律不帶隊友。',
  },
  {
    key: 'oberonR1AlwaysFail64', kind: 'number', side: 'evil', min: 0, max: 1,
    zh: '奧伯倫第 1 局上任務一律出失敗（0 = 關、1 = 開）。',
    en: 'Oberon always fails a round-1 mission (0 = off, 1 = on).',
    zhUp: '1：奧伯倫開局就搶失敗。',
    zhDown: '0（預設）：照一般規則。',
  },
  // ── 藍方 ──────────────────────────────────────────────
  {
    key: 'goodCleanVote', kind: 'number', side: 'good', min: 0, max: 0.9,
    zh: '第 3 局起，忠臣和派西估「這隊沒有紅」的機率低於這個門檻就投黑。',
    en: 'From round 3, loyals and Percival reject when the chance the team is clean is below this.',
    zhUp: '越高越嚴格、越常否決。',
    zhDown: '越低越寬鬆；0 = 不用這條。預設 0.3。',
  },
  {
    key: 'goodKeyVote', kind: 'number', side: 'good', min: 0, max: 0.9,
    zh: '紅方已拿兩局（再一個紅就輸）時，忠臣和派西的投黑門檻。',
    en: 'When red has two fails already: the clean-chance bar below which loyals and Percival reject.',
    zhUp: '越高越不敢放行，關鍵局更保守。',
    zhDown: '越低越願意賭；0 = 不用這條。預設 0.3。',
  },
  {
    key: 'goodTailVote', kind: 'number', side: 'good', min: 0, max: 0.95,
    zh: '第 3 局起忠臣和派西不在隊上時預設投黑，這隊乾淨的機率達到這個門檻才投白。',
    en: 'From round 3, loyals and Percival off the team reject unless the clean chance reaches this.',
    zhUp: '越高越常投黑。',
    zhDown: '越低越常放行；0 = 不用這條。預設 0.7。',
  },
  {
    key: 'merlinNormalVote', kind: 'number', side: 'good', min: 0, max: 1,
    zh: '梅林第 3 局起照「只看公開紀錄的忠臣」那樣投票的比例（只在會直接輸掉時才擋）。',
    en: 'From round 3, share of Merlin votes cast like a public-info loyal (blocks only when a red team would win outright).',
    zhUp: '1（預設）：梅林藏得深，不容易被刺中。',
    zhDown: '越低梅林越常照自己看到的紅投票，任務比較穩，但比較容易被刺。',
  },
  {
    key: 'merlinCover77', kind: 'number', side: 'good', min: 0, max: 1,
    zh: '第 1、2 局幾乎不會出任務的提議裡，梅林照「只看公開紀錄的忠臣」會派的隊來派的比例（看得到的紅在不在隊上照公開局勢）。',
    en: 'Rounds 1-2, in proposals that will not go: share of Merlin proposals that copy what a public-info loyal would pick.',
    zhUp: '越高梅林早期派隊越像忠臣，比較難被刺中。',
    zhDown: '0（預設）：梅林照自己看到的派。',
  },
  {
    key: 'percivalNoThumbsR1', kind: 'boolean', side: 'good',
    zh: '派西第 1 局當隊長時，兩根拇指（梅林／莫甘娜）都不放進隊。',
    en: 'Percival as leader in round 1 leaves both thumbs (Merlin / Morgana) out.',
    zhUp: '開（預設）：沒資訊時先不派拇指。',
    zhDown: '關：第 1 局就會放一根拇指。',
  },
  // ── 刺客 ──────────────────────────────────────────────
  {
    key: 'assassinModel', kind: 'boolean', side: 'assassin',
    zh: '刺殺用牌譜訓練的模型；關掉改用舊的經驗規則。',
    en: 'Assassinate with the model trained on human games; off = the older rule of thumb.',
    zhUp: '開（預設）：用模型。',
    zhDown: '關：用經驗規則。',
  },
];

export const ARENA_KNOB_KEYS: ReadonlySet<string> = new Set(ARENA_KNOBS.map((k) => k.key));

export function knobFor(key: string): Knob | undefined {
  return ARENA_KNOBS.find((k) => k.key === key);
}
