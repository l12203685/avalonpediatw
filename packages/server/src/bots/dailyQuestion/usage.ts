/**
 * /每日一題 在說明裡的寫法（沒有任何 import：stats/statsReplies 的 /指令 和 bots/help 都要列它，
 * 而 ./commands.ts 會一路 import 到 statsReplies，放在這裡才不會循環相依）。見 ./commands.ts。
 */

/** 指令寫法（說明裡用）。兩個平台一樣。 */
export const DAILY_QUESTION_USAGE = '/每日一題';

/** 說明裡的一行描述。 */
export const DAILY_QUESTION_HELP_TEXT = '今天的阿瓦隆每日一題：一句話的問題、牌譜連結、怎麼在這裡作答';

/** 昨天的題目和答案（2026-11-25 第二批）在說明裡的寫法：LINE 打字、Discord 選選項。 */
export const DAILY_QUESTION_YESTERDAY_USAGE = { line: '/每日一題 昨天', discord: '/每日一題 哪一天:昨天' } as const;
export const DAILY_QUESTION_YESTERDAY_HELP_TEXT = '昨天的題目和答案（真人怎麼做、結果），在群裡作答的人可以對答案；今天的答案明天才看得到';
