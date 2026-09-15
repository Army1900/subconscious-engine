import type { EmbeddingExample } from "./embedding.js";

/**
 * 内置版化示例集（M3 embedding 训练原型；DESIGN §4.1）。
 *
 * 纪律：
 * - 中英文兼备；每类 ≥2 条正例；负例示例提供误检防线原型（negative 类）。
 * - 短语刻意与 EMBEDDING_EVAL_SET 的期望指代互不重叠（无相等/包含关系，
 *   由 embeddingEvalLeakErrors 程序化锁定，见 test/embedding-data.test.ts）。
 * - 变更示例集必须递增 EMBEDDING_EXAMPLES_VERSION 并重跑评估脚本。
 */
export const EMBEDDING_EXAMPLES_VERSION = 2;

export const DEFAULT_EMBEDDING_EXAMPLES: readonly EmbeddingExample[] = [
  // ---- code-symbol ----
  { text: "那个方法", type: "code-symbol" },
  { text: "那个常量", type: "code-symbol" },
  { text: "this method", type: "code-symbol" },
  { text: "that variable", type: "code-symbol" },
  // ---- file ----
  { text: "该目录", type: "file" },
  { text: "该文件夹", type: "file" },
  { text: "that module", type: "file" },
  { text: "the folder", type: "file" },
  // ---- image ----
  { text: "这幅图片", type: "image" },
  { text: "那张照片", type: "image" },
  { text: "this picture", type: "image" },
  { text: "the photo", type: "image" },
  // ---- project ----
  { text: "当前工程", type: "project" },
  { text: "本仓库", type: "project" },
  { text: "the current repo", type: "project" },
  // ---- history-event ----
  { text: "上一回", type: "history-event" },
  { text: "前一轮", type: "history-event" },
  { text: "the earlier commit", type: "history-event" },
  { text: "our previous discussion", type: "history-event" },
  // ---- history-content ----
  { text: "老办法", type: "history-content" },
  { text: "一贯的做法", type: "history-content" },
  { text: "the same as before", type: "history-content" },
  { text: "in the usual manner", type: "history-content" },
  // ---- history-content：头脑风暴模糊指代（v2 盲区补齐）----
  { text: "聊出来的结论", type: "history-content" },
  { text: "碰出来的点子", type: "history-content" },
  { text: "早前讨论的思路", type: "history-content" },
  { text: "咱们商量出的方案", type: "history-content" },
  // ---- history-content：定下的原则/哲学类（v2 盲区补齐）----
  { text: "定好的规范", type: "history-content" },
  { text: "当初的设计哲学", type: "history-content" },
  { text: "the principles we settled on", type: "history-content" },
  { text: "the ideas we bounced around", type: "history-content" },
  // ---- history-content：那套/惯用类（v2 追补：贴近"咱们那套做法"表述域）----
  { text: "咱们惯用的那套做法", type: "history-content" },
  { text: "说好的那套做法", type: "history-content" },
  { text: "沿用那套做法", type: "history-content" },
  { text: "our usual way of working", type: "history-content" },
  { text: "聊出来的那些思路", type: "history-content" },
  // ---- text（剪贴板）----
  { text: "剪贴板的内容", type: "text" },
  { text: "我复制的那段", type: "text" },
  { text: "the clipboard", type: "text" },
  { text: "what I copied", type: "text" },
  // ---- negative（非指代短语原型）----
  { text: "你好呀", type: "negative" },
  { text: "今天天气不错", type: "negative" },
  { text: "先跑一遍全部测试", type: "negative" },
  { text: "辛苦了", type: "negative" },
  { text: "this is fine", type: "negative" },
  { text: "sounds good to me", type: "negative" },
  { text: "please hold on", type: "negative" },
  { text: "无所谓继续吧", type: "negative" },
  // ---- negative：哲学闲聊/外部参照物（v2 误检防线）----
  { text: "读点哲学放松一下", type: "negative" },
  { text: "喜欢闲聊各种话题", type: "negative" },
  { text: "照着菜谱学做菜", type: "negative" },
  { text: "这个话题见仁见智", type: "negative" },
  // ---- negative：惯常讨论/读书感想/点子反应（v2 追补：压住低置信内容类误检；
  //      裸指示词误检已由 isTypeInfoFree 结构性防线处理，不再用负例对抗。
  //      数量克制：负例原型均值会整体移动，过多内容邻域负例会把 margin 门压到薄命中 TP 之下）----
  { text: "纯属闲聊的想法交流", type: "negative" },
  { text: "睡前翻翻哲学书", type: "negative" },
  { text: "great idea love it", type: "negative" },
];
