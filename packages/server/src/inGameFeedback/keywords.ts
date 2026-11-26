/**
 * 遊戲內回饋 — 哪些房間聊天算「對百科AI 玩法的回饋」（站長 2026-11-26：「遊戲中的對話你也記得讀取並學習
 * 有可能是玩家對你玩法的反饋」）。所有關鍵字都在這一個檔，測試在 __tests__/InGameFeedback.test.ts。
 *
 * 寧可漏掉也不要雜訊。只看有百科AI 坐的局（capture.ts 決定），一句話算回饋要符合下面其中一條：
 *   1. 直接講到機器人：百科AI／AI／電腦／機器人／bot。
 *   2. 講到一個百科AI 的座位（「3家」「3號」「#3」，10 家寫 0 家），而且同一句有評價（爛、亂打、好強、神…）
 *      或是在問為什麼（為什麼這樣派、怎麼會投…）。只有座位、沒有評價（「3家是梅林」）不算——那是一般推理。
 *   3. 沒講到誰，但有很明確的評價（亂打、看不懂、白痴、好強、神操作…）：局後聊天算；局中只在百科AI 佔桌上
 *      一半以上的座位時算（不然多半是在說真人）。
 *   4. 沒講到誰、只是問「為什麼這樣派／投／刺／湖」：只在局後聊天算，或問「派」時這一輪隊長是百科AI。
 * 指令（/ 開頭）、超過 300 字的話不算。純函式。
 */

/** 比這更長的話不當成回饋（多半在聊別的）。 */
export const IN_GAME_FEEDBACK_MAX_INPUT = 300;

/** 1. 直接講到機器人。「AI」要是獨立的英文字（不吃 email、main、said 這種）。 */
const BOT_WORD_PATTERNS: readonly RegExp[] = [
  /百科\s*ai|百科機器人|百科机器人/iu,
  /(?<![a-z])ai(?![a-z])/iu,
  /(?<![a-z])bots?(?![a-z])/iu,
  /電腦|电脑|機器人|机器人/u,
];

/** 2./3. 評價：抱怨或稱讚玩法（寫得很明確的才算）。 */
const JUDGEMENT_PATTERNS: readonly RegExp[] = [
  /亂打|乱打|亂玩|乱玩|亂派|乱派|亂投|乱投|亂刺|乱刺|亂湖|乱湖|亂出|乱出|亂丟|乱丢/u,
  /看不懂|搞不懂|不懂在|什麼鬼|什么鬼|傻眼|離譜|离谱|太扯|好扯|很扯|扯爆/u,
  /白痴|白癡|智障|弱智|腦殘|脑残|笨死|蠢/u,
  /(?:好|很|超|太|有夠|真)(?:爛|烂|雷|廢|废|弱|蠢|笨)|爛透|烂透|爛死|烂死|雷爆|好雷/u,
  /(?:好|很|超|太|有夠|真)(?:強|强|神|猛|厲害|厉害|聰明|聪明|會玩|会玩)|神操作|神預判|神预判|神刺|神湖|神派|強者|强者|大神/u,
  /打得(?:好|不錯|不错|很好|爛|烂|很爛|很烂)|玩得(?:好|不錯|不错|很好|爛|烂)|打法(?:怪|很怪|奇怪|有問題|有问题)/u,
];

/** 2./4. 問為什麼這樣玩。 */
const QUESTION_PATTERNS: readonly RegExp[] = [
  /(?:為什麼|为什么|為啥|为啥|幹嘛|干嘛|怎麼會|怎么会|怎麼|怎么)(?:要|會|会|又|還|还|都)?(?:這樣|这样|那樣|那样)?(?:派|投|出|刺|湖|驗|验|拒|否|贊成|赞成|失敗|失败|成功)/u,
  /(?:內黑|内黑|外白)(?:是|幹嘛|干嘛|為什麼|为什么|\?|？)|(?:為什麼|为什么|幹嘛|干嘛)(?:要)?(?:內黑|内黑|外白)/u,
  /(?:刺|湖)(?:這|这|那)?(?:家|個|个)?\s*(?:為什麼|为什么|\?|？)/u,
];

/** 「派」的問句（第 4 條：這一輪隊長是百科AI 時，局中也算）。 */
const PROPOSE_QUESTION = /(?:為什麼|为什么|為啥|为啥|幹嘛|干嘛|怎麼會|怎么会)(?:要|會|会|又)?(?:這樣|这样|那樣|那样)?派/u;

/** 座位：「3家」「3號」「#3」「3號位」；0 家 = 10 家。 */
const SEAT_PATTERN = /(?:#\s*(\d{1,2})(?!\d))|(?<!\d)(\d{1,2})\s*(?:家|號|号)/gu;

export type InGameFeedbackReason = 'bot-word' | 'bot-seat' | 'judgement' | 'question';

export interface InGameFeedbackContext {
  /** 這一局百科AI 坐的座位（1–10）。 */
  botSeats: readonly number[];
  /** 局後聊天（遊戲已結束）。 */
  postGame: boolean;
  /** 這一輪隊長是百科AI。 */
  leaderIsBot: boolean;
  /** 桌上幾個座位。 */
  seatCount: number;
}

export interface InGameFeedbackHit {
  reason: InGameFeedbackReason;
  /** 這句提到的百科AI 座位（1–10，由小到大；只講「AI」沒講座位時是空的）。 */
  botSeats: number[];
  /** 這句直接講到機器人（百科AI／AI／電腦／機器人／bot）。 */
  genericBot: boolean;
}

/** 這句提到的座位（1–10）。 */
export function seatsMentioned(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(SEAT_PATTERN)) {
    const n = Number(m[1] ?? m[2]);
    if (n === 0 || n === 10) out.add(10);
    else if (n >= 1 && n <= 9) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** 一句房間聊天是不是對百科AI 玩法的回饋；不是 → null。 */
export function classifyInGameFeedback(text: string, ctx: InGameFeedbackContext): InGameFeedbackHit | null {
  const t = (text ?? '').normalize('NFKC').trim();
  if (!t || [...t].length > IN_GAME_FEEDBACK_MAX_INPUT || /^[/／]/u.test(t)) return null;
  const botSet = new Set(ctx.botSeats);
  if (botSet.size === 0) return null;
  const botSeats = seatsMentioned(t).filter((s) => botSet.has(s));
  const genericBot = BOT_WORD_PATTERNS.some((re) => re.test(t));
  if (genericBot) return { reason: 'bot-word', botSeats, genericBot };
  const judged = JUDGEMENT_PATTERNS.some((re) => re.test(t));
  const asked = QUESTION_PATTERNS.some((re) => re.test(t));
  if (botSeats.length > 0 && (judged || asked)) return { reason: 'bot-seat', botSeats, genericBot };
  // 講到的都是真人座位（「4家亂打」而 4 家是真人）：不是在說百科AI。
  if (seatsMentioned(t).length > 0) return null;
  if (judged && (ctx.postGame || botSet.size * 2 >= ctx.seatCount)) return { reason: 'judgement', botSeats, genericBot };
  if (asked && (ctx.postGame || (ctx.leaderIsBot && PROPOSE_QUESTION.test(t)))) return { reason: 'question', botSeats, genericBot };
  return null;
}
