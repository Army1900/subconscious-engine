import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileGrantStore } from "../src/file-grants.js";

async function pathFor(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "subconscious-grants-")), name);
}

describe("FileGrantStore", () => {
  it("persists grants and keeps scopes isolated", async () => {
    const file = await pathFor("grants.json");
    const first = new FileGrantStore(file);
    await first.grant({ sourceId: "clipboard", scope: "clipboard:global" });
    const restored = new FileGrantStore(file);
    await expect(restored.has({ sourceId: "clipboard", scope: "clipboard:global" })).resolves.toBe(true);
    await expect(restored.has({ sourceId: "clipboard" })).resolves.toBe(false);
  });

  it("treats expired and corrupt data as ungranted", async () => {
    const file = await pathFor("grants.json");
    const store = new FileGrantStore(file, () => Date.parse("2026-01-02T00:00:00.000Z"));
    await store.grant({ sourceId: "clipboard" }, { expiresAt: "2026-01-01T00:00:00.000Z" });
    await expect(store.has({ sourceId: "clipboard" })).resolves.toBe(false);
    await writeFile(file, "not json", "utf8");
    await expect(store.has({ sourceId: "clipboard" })).resolves.toBe(false);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("serializes concurrent grants", async () => {
    const store = new FileGrantStore(await pathFor("grants.json"));
    await Promise.all([store.grant({ sourceId: "a" }), store.grant({ sourceId: "b" })]);
    expect((await store.list()).map((entry) => entry.sourceId).sort()).toEqual(["a", "b"]);
  });
});
