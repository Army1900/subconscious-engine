import type { EmbeddingProvider, EmbeddingVector } from "@subconscious/core";

/**
 * 确定性关键词 fixture provider：离线评估（npm run eval:embedding:fixture）与演示用。
 *
 * 纪律：纯函数、零依赖、零 node API、零网络；同文本必得同向量。
 * 向量空间：7 个类型轴 + 1 个噪声轴；中文关键词子串匹配，拉丁关键词整 token 匹配
 * （"lastIndexOf" 不命中 "last"，与规则检测器的词边界纪律一致）。
 */

export const FIXTURE_PROVIDER_ID = "fixture:keyword-v1";

const FIXTURE_TYPES: readonly string[] = [
  "code-symbol",
  "file",
  "image",
  "project",
  "history-event",
  "history-content",
  "text",
];

export const FIXTURE_DIMENSION = FIXTURE_TYPES.length + 1; // 末维 = 噪声

interface LexiconEntry {
  readonly type: string;
  readonly cjk: readonly string[];
  readonly latin: readonly string[];
}

const LEXICON: readonly LexiconEntry[] = [
  { type: "code-symbol", cjk: ["函数", "方法", "代码", "变量", "常量", "接口"], latin: ["function", "method", "code", "variable", "const", "symbol", "snippet", "chunk"] },
  { type: "file", cjk: ["文件", "目录", "文件夹"], latin: ["file", "directory", "folder", "module"] },
  { type: "image", cjk: ["图", "照片", "截图"], latin: ["image", "picture", "photo", "screenshot", "pic"] },
  { type: "project", cjk: ["项目", "工程", "仓库", "代码库"], latin: ["project", "repo", "codebase", "monorepo"] },
  { type: "history-event", cjk: ["上次", "上一", "前一", "刚才", "之前"], latin: ["last", "previous", "earlier"] },
  { type: "history-content", cjk: ["规矩", "套路", "办法", "做法", "照旧", "一样", "同样"], latin: ["usual", "same"] },
  { type: "text", cjk: ["剪贴板", "粘贴", "复制"], latin: ["clipboard", "copied", "pasted"] },
];

function normalize(v: readonly number[]): EmbeddingVector {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

/** 确定性关键词向量（one-hot 多类型叠加后归一化；无命中 → 噪声轴） */
export function fixtureEmbed(text: string): EmbeddingVector {
  const v = new Array<number>(FIXTURE_DIMENSION).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9._'-]+/).filter((t) => t.length > 0);
  let hit = false;
  for (const entry of LEXICON) {
    const idx = FIXTURE_TYPES.indexOf(entry.type);
    if (idx < 0) continue;
    if (entry.cjk.some((k) => text.includes(k)) || entry.latin.some((k) => tokens.includes(k))) {
      v[idx] = 1;
      hit = true;
    }
  }
  if (!hit) v[FIXTURE_DIMENSION - 1] = 1;
  return normalize(v);
}

export function createFixtureKeywordProvider(): EmbeddingProvider {
  return {
    id: FIXTURE_PROVIDER_ID,
    embed: async (text: string) => fixtureEmbed(text),
  };
}
