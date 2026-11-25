/**
 * 遊戲規則與角色介紹的文字（2026-11-25）— Discord 的 /rules、/roles，和兩邊的 /help 規則、/help 角色 共用，純函式。
 *
 * 之前 Discord 的 /rules、/roles 是英文 embed，而且寫錯：寫「梅林看不到莫甘娜」（其實看不到的是莫德雷德）、
 * 沒有莫德雷德、寫「5 次否決壞人贏」（這個社群第 5 次派隊是直接出發、不投票）。
 * 這裡照站上統計與模擬瓦用的同一套 10 人局規則寫：
 *   - 角色與誰看得到誰：discord/roleReveal.ts（梅林看得到刺客、莫甘娜、奧伯倫，看不到莫德雷德）；
 *   - 五局人數 3、4、4、5、5、第 4 局要 2 張失敗：shared/src/types/game.ts 的 10 人設定；
 *   - 第 5 次派隊不投票：shared/src/stats（「尾家強制、不投票」）；
 *   - 湖中女神：開局在 0家、第 2～4 局任務後用、被驗的人接湖：threads/concepts.ts lakeHolderOf。
 * 只寫規則本身，不寫打法。座位寫「N家」，第十個座位是「0家」。
 */

import { PLAY_PLATFORM_URL } from '@avalon/shared';

/** 說明裡的指令寫法（只有 Discord 有這兩個斜線指令；LINE 用 /help 規則、/help 角色）。 */
export const RULES_USAGE = '/rules /roles';

export type RulesPlatform = 'line' | 'discord';

/**
 * 說明裡「去哪裡開局」的那一行（對局在 signage-cloud，這裡不開房）。
 * Discord 的網址用 <> 包起來：照樣可以點，但不會在說明下面多出一大塊登入頁的預覽。
 */
export function playPlatformLine(platform: RulesPlatform): string {
  return `🎲 開局、對局：signage-cloud ${platform === 'discord' ? `<${PLAY_PLATFORM_URL}>` : PLAY_PLATFORM_URL}`;
}

/** 另一份怎麼看：Discord 有斜線指令，LINE 用 /help 主題。 */
function pointer(to: 'rules' | 'roles', platform: RulesPlatform): string {
  if (to === 'roles') return platform === 'discord' ? '角色介紹：/roles' : '角色介紹：/help 角色';
  return platform === 'discord' ? '規則：/rules' : '規則：/help 規則';
}

/** 10 人局的規則，一行一件事。 */
export function rulesText(platform: RulesPlatform = 'discord'): string {
  return [
    '📜 阿瓦隆規則（10 人局）',
    '陣營：藍方（好人）6 人＝梅林、派西維爾、忠臣 4 人；紅方（壞人）4 人＝刺客、莫甘娜、莫德雷德、奧伯倫',
    '一局怎麼走：隊長派隊 → 全員投票，贊成過半才出發 → 上隊的人出任務牌（成功或失敗）',
    '五局的任務人數：3、4、4、5、5',
    '任務失敗：有 1 張失敗就算失敗；第 4 局要 2 張',
    '同一局前四次派隊都沒過：第 5 次派的隊直接出發，不投票',
    '湖中女神：第 2、3、4 局任務後，拿湖的人驗一位玩家是好人還是壞人，湖交給被驗的人；開局湖在 0家',
    '勝負：藍方先拿 3 局成功 → 刺客指認梅林，刺中紅方贏、沒刺中藍方贏；紅方先拿 3 局失敗就贏',
    pointer('roles', platform),
  ].join('\n');
}

/** 七個角色各知道什麼，一行一個。 */
export function rolesText(platform: RulesPlatform = 'discord'): string {
  return [
    '🎭 阿瓦隆角色（10 人局）',
    '🔵 梅林：知道刺客、莫甘娜、奧伯倫是壞人，看不到莫德雷德；被刺客刺中藍方就輸',
    '🔵 派西維爾：知道哪兩個人是梅林和莫甘娜，但分不出誰是誰',
    '🔵 忠臣（4 人）：沒有額外的資訊',
    '🔴 刺客：藍方拿到 3 局成功後指認一個人是梅林，刺中紅方贏',
    '🔴 莫甘娜：在派西維爾眼中跟梅林一樣',
    '🔴 莫德雷德：梅林看不到他',
    '🔴 奧伯倫：不知道隊友是誰，隊友也不知道他；梅林看得到他',
    '刺客、莫甘娜、莫德雷德三個人互相知道。',
    pointer('rules', platform),
  ].join('\n');
}
