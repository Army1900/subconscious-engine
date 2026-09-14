import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { InMemoryGrantStore } from "../src/grants.js";
import { clipboardSource } from "../src/sources/clipboard.js";
import { FakeInteract } from "./helpers.js";

describe("clipboardSource", () => {
  it("never reads before L1 consent and reuses the scoped grant", async () => {
    let reads = 0;
    const grants = new InMemoryGrantStore();
    const interact = new FakeInteract();
    interact.confirmResult = "no";
    const engine = createEngine({ sources: [clipboardSource], grants, interact });
    const env = { cwd: "/tmp", readClipboardText: async () => { reads += 1; return "secret"; } };

    const denied = await engine.enrich("使用剪贴板内容", env);
    expect(reads).toBe(0);
    expect(denied.resolvedRefs).toEqual([]);

    interact.confirmResult = "yes";
    const allowed = await engine.enrich("使用剪贴板内容", env);
    expect(reads).toBe(1);
    expect(allowed.context).toContain("secret");
    expect(await grants.has({ sourceId: "clipboard", scope: "clipboard:global" })).toBe(true);

    await engine.enrich("使用剪贴板内容", env);
    expect(reads).toBe(2);
    expect(interact.log.filter((entry) => entry.startsWith("confirm:"))).toHaveLength(2);
  });
});
