import { describe, expect, it } from "vitest";
import { createRuleDetector } from "../src/detector.js";
import type { DanglingRef } from "../src/types.js";

const detector = createRuleDetector();

function detect(prompt: string): readonly DanglingRef[] {
  return detector.detect(prompt);
}

describe("规则检测器：span 与输出形状", () => {
  it("span 与原文切片严格一致，id 唯一，区间有序不重叠", () => {
    const prompt = "把这个函数改成和上次一样的错误处理";
    const refs = detect(prompt);
    expect(refs.length).toBeGreaterThanOrEqual(3);
    const ids = new Set<string>();
    let lastEnd = -1;
    for (const ref of refs) {
      expect(prompt.slice(ref.span[0], ref.span[1])).toBe(ref.text);
      expect(ref.span[0]).toBeGreaterThanOrEqual(lastEnd);
      expect(ref.span[1]).toBeGreaterThan(ref.span[0]);
      expect(ids.has(ref.id)).toBe(false);
      ids.add(ref.id);
      expect(ref.confidence).toBeGreaterThan(0);
      expect(ref.confidence).toBeLessThanOrEqual(1);
      lastEnd = ref.span[1];
    }
  });

  it("Unicode（emoji 前缀）下 span 仍按码元精确", () => {
    const prompt = "🙂 这个文件还有问题";
    const refs = detect(prompt);
    expect(refs.map((r) => r.expectedType)).toEqual(["file"]);
    const ref = refs[0] as DanglingRef;
    expect(prompt.slice(ref.span[0], ref.span[1])).toBe("这个文件");
  });

  it("同一话语中同类多个指代分别成 ref", () => {
    const refs = detect("比较这个文件和那个文件");
    const fileRefs = refs.filter((r) => r.expectedType === "file");
    expect(fileRefs.length).toBeGreaterThanOrEqual(2);
    expect(fileRefs.map((r) => r.text)).toEqual(["这个文件", "那个文件"]);
  });
});

describe("规则检测器：中文显式指代", () => {
  it("这个函数 → code-symbol；上次 → history-event；一样… → history-content", () => {
    const refs = detect("把这个函数改成和上次一样的错误处理");
    expect(refs.map((r) => r.expectedType)).toEqual(["code-symbol", "history-event", "history-content"]);
  });

  it("参考上次的修改改这个文件 → history-event + file", () => {
    const refs = detect("参考上次的修改改这个文件");
    expect(refs.map((r) => r.expectedType)).toEqual(["history-event", "file"]);
  });

  it("那张图 → image", () => {
    expect(detect("看看那张图里面是什么").map((r) => r.expectedType)).toEqual(["image"]);
  });

  it("这个项目 / 当前项目 → project（cwd-context 可达入口）", () => {
    expect(detect("分析这个项目的结构").map((r) => r.expectedType)).toEqual(["project"]);
    expect(detect("当前项目用了哪些依赖").map((r) => r.expectedType)).toEqual(["project"]);
  });
});

describe("规则检测器：英文显式指代", () => {
  it("this function / the previous change", () => {
    const refs = detect("Fix this function using the previous change");
    const types = refs.map((r) => r.expectedType);
    expect(types).toContain("code-symbol");
    expect(types).toContain("history-event");
  });

  it("that image / this project", () => {
    expect(detect("What is in that image").map((r) => r.expectedType)).toEqual(["image"]);
    expect(detect("Refactor this project structure").map((r) => r.expectedType)).toEqual(["project"]);
  });

  it("same as last time → history-content", () => {
    expect(detect("Please fix it same as last time").map((r) => r.expectedType)).toEqual(["history-content"]);
  });
});

describe("规则检测器：负例（不得误检）", () => {
  const negatives: ReadonlyArray<[string, string]> = [
    ["普通中文", "你好"],
    ["无指代技术话题", "解释快速排序"],
    ["英文 this is", "This is a test"],
    ["that + 抽象名词", "I like that idea"],
    ["API 名含 last", "lastIndexOf 的复杂度是多少？"],
    ["变量名含 previous", "previousValue 是个变量名"],
    ["文件名含 this", "请创建一个名为 this-file.txt 的新文件"],
    ["空字符串", ""],
  ];

  for (const [name, prompt] of negatives) {
    it(`${name}："${prompt}" → 零指代`, () => {
      expect(detect(prompt)).toEqual([]);
    });
  }
});

describe("规则检测器：健壮性", () => {
  it("非字符串输入返回空且不抛出", () => {
    expect(detect(undefined as unknown as string)).toEqual([]);
    expect(detect(123 as unknown as string)).toEqual([]);
  });

  it("检测器无状态，可重复调用", () => {
    const a = detect("这个函数");
    const b = detect("这个函数");
    expect(a).toEqual(b);
  });
});
