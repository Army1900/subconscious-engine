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

describe("规则检测器：内容指代的自然表述（盲区补齐轮）", () => {
  // ---- 按老规矩/照老规矩（前缀动词必需，裸"老规矩"不触发）----
  it("按老规矩/照老规矩/沿用老规矩 → history-content", () => {
    expect(detect("还是按老规矩，先把测试补上").map((r) => r.text)).toEqual(["按老规矩"]);
    expect(detect("照老规矩处理这段代码").map((r) => r.text)).toEqual(["照老规矩"]);
    expect(detect("沿用老规矩来命名").map((r) => r.text)).toEqual(["沿用老规矩"]);
    expect(detect("照老规矩处理这段代码").map((r) => r.expectedType)).toEqual(["history-content"]);
  });

  it("近义负例：无前缀动词的\"老规矩\"（习俗义，无历史指向）不触发", () => {
    expect(detect("咱们组的老规矩是周五聚餐")).toEqual([]);
    expect(detect("老规矩先跑测试再说话")).toEqual([]);
  });

  // ---- 照旧（惯例/历史指向几乎唯一）----
  it("照旧 → history-content", () => {
    expect(detect("照旧处理错误").map((r) => r.text)).toEqual(["照旧"]);
    expect(detect("这个模块照旧来就行").map((r) => r.expectedType)).toEqual(["history-content"]);
  });

  // ---- 照着 X 弄/改/清理（宾语只能是代词性成分或直接动词）----
  it("照着清理/照着弄/照着那个改 → history-content", () => {
    const refs = detect("把这个文件也照着清理一遍");
    expect(refs.map((r) => r.text)).toEqual(["这个文件", "照着清理"]);
    expect(refs.map((r) => r.expectedType)).toEqual(["file", "history-content"]);
    expect(detect("不知道怎么改，照着弄就行").map((r) => r.text)).toEqual(["照着弄"]);
    expect(detect("照着那个改一版").map((r) => r.text)).toEqual(["照着那个改"]);
  });

  it("近义负例：照着说明书装家具（外部参照物，非历史内容）不触发", () => {
    expect(detect("照着说明书装家具挺解压的")).toEqual([]);
    expect(detect("照着视频教程学一遍")).toEqual([]);
  });

  // ---- 定下的 X（原则/哲学/规矩/约定）----
  it("定下的设计哲学/定好的编码约定/说定的规矩 → history-content", () => {
    expect(detect("把上次定下的设计哲学落实到这个模块").map((r) => r.expectedType)).toEqual([
      "history-event",
      "history-content",
    ]);
    expect(detect("把上次定下的设计哲学落实到这个模块").map((r) => r.text)).toEqual([
      "上次",
      "定下的设计哲学",
    ]);
    expect(detect("沿用定好的编码约定").map((r) => r.text)).toEqual(["定好的编码约定"]);
    expect(detect("按说定的规矩提交").map((r) => r.text)).toEqual(["说定的规矩"]);
  });

  it("近义负例：定下的目标/方案定下来了（名词不在封闭表）不触发", () => {
    expect(detect("定下的目标是先跑通主流程")).toEqual([]);
    expect(detect("方案定下来了，原则保持不变")).toEqual([]);
  });

  // ---- （之前/上次）聊过的/讨论过的/碰撞出的（想法/思路/方案/点子）----
  it("之前聊过的那些想法 → 之前(history-event) + 聊过的那些想法(history-content)", () => {
    const refs = detect("结合咱们之前聊过的那些想法再发散一下");
    expect(refs.map((r) => r.expectedType)).toEqual(["history-event", "history-content"]);
    expect(refs.map((r) => r.text)).toEqual(["之前", "聊过的那些想法"]);
  });

  it("讨论过的方案/碰撞出的点子 → history-content（可分别与上次/之前事件共存）", () => {
    expect(detect("上次讨论过的方案再看看").map((r) => r.text)).toEqual(["上次", "讨论过的方案"]);
    expect(detect("用咱们碰撞出的点子做原型").map((r) => r.text)).toEqual(["碰撞出的点子"]);
  });

  it("近义负例：无体验态\"过/出\"的讨论（我喜欢讨论那些想法）不触发", () => {
    expect(detect("我喜欢讨论那些想法")).toEqual([]);
    expect(detect("咱们聊聊新想法吧")).toEqual([]);
  });

  it("\"之前\"仅在紧邻讨论动词时构成 history-event（\"和之前一样处理\"不变式保持）", () => {
    expect(detect("和之前一样处理").map((r) => r.expectedType)).toEqual(["history-content"]);
    expect(detect("出发之前记得保存")).toEqual([]);
  });

  // ---- 那个/这个 X 的 改造（历史工作内容的名词化指代）----
  it("上次那个错误处理的改造 → 上次(event) + 错误处理的改造(content)", () => {
    const refs = detect("上次那个错误处理的改造也一起做了");
    expect(refs.map((r) => r.expectedType)).toEqual(["history-event", "history-content"]);
    expect(refs.map((r) => r.text)).toEqual(["上次", "错误处理的改造"]);
  });

  it("与封闭名词模板同现时模板优先：那个方法的修改保留 code-symbol", () => {
    expect(detect("那个方法的修改在哪里").map((r) => r.expectedType)).toEqual(["code-symbol"]);
  });

  it("近义负例：这个报错的修复（后缀不在封闭表）不触发", () => {
    expect(detect("看一下这个报错的修复进展")).toEqual([]);
  });
});

describe("规则检测器：会话内\"刚才\"降噪", () => {
  it("裸\"刚才\"仍检出但置信度低于默认引擎阈值 0.5（会话内指代留给模型）", () => {
    const refs = detect("还是用刚才讨论的方案吧");
    expect(refs.length).toBe(1);
    const ref = refs[0] as DanglingRef;
    expect(ref.text).toBe("刚才");
    expect(ref.expectedType).toBe("history-event");
    expect(ref.confidence).toBeLessThan(0.5);
  });

  it("跨会话继续语境（接着/回到/从 + 刚才）保留高置信 history-event", () => {
    const a = detect("接着刚才的继续做");
    expect(a.length).toBe(1);
    expect((a[0] as DanglingRef).text).toBe("接着刚才");
    expect((a[0] as DanglingRef).confidence).toBeGreaterThanOrEqual(0.5);
    const b = detect("回到刚才没讲完的地方");
    expect((b[0] as DanglingRef).text).toBe("回到刚才");
    const c = detect("新会话里说继续刚才那个话题");
    expect((c[0] as DanglingRef).text).toBe("刚才");
    expect((c[0] as DanglingRef).confidence).toBeGreaterThanOrEqual(0.5);
  });
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
