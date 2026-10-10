import { test } from "node:test";
import assert from "node:assert/strict";
import { FileLibrary, MAX_FILES } from "../js/library.js";

// IndexedDBの代わりに、メモリ上の入れ物で動作を確かめる
class MemStorage {
  constructor() { this.m = new Map(); }
  async get(k, s = "annotations") { return this.m.get(`${s}/${k}`) ?? null; }
  async set(k, v, s = "annotations") { this.m.set(`${s}/${k}`, v); return true; }
  async delete(k, s = "annotations") { this.m.delete(`${s}/${k}`); return true; }
  async entries(s) { return [...this.m].filter(([k]) => k.startsWith(`${s}/`)).map(([k, v]) => [k.slice(s.length + 1), v]); }
}

test("控え: 入れた図面を、最後に開いた図面として取り出せる(中身も同じ)", async () => {
  const lib = new FileLibrary(new MemStorage());
  const bytes = new Uint8Array([74, 119, 119, 68]);
  assert.equal(await lib.remember("sha256:a", "M-38.jww", bytes), true);
  const last = await lib.last();
  assert.equal(last.name, "M-38.jww");
  assert.deepEqual([...last.bytes], [74, 119, 119, 68]);
  assert.equal((await lib.list()).length, 1);
});

test("控え: 5件を超えたら、古いものから消える(いま開いたものは残る)", async () => {
  const lib = new FileLibrary(new MemStorage());
  for (let i = 0; i < MAX_FILES + 2; i++) {
    await lib.remember(`k${i}`, `f${i}.jww`, new Uint8Array([i]));
    await new Promise((r) => setTimeout(r, 2));
  }
  const names = (await lib.list()).map((f) => f.name);
  assert.equal(names.length, MAX_FILES);
  assert.equal(names[0], `f${MAX_FILES + 1}.jww`); // いちばん新しい
  assert.ok(!names.includes("f0.jww"));
  assert.equal((await lib.last()).name, `f${MAX_FILES + 1}.jww`);
});

test("控え: 削除すると、最後に開いた図面からも外れる", async () => {
  const lib = new FileLibrary(new MemStorage());
  await lib.remember("k1", "a.jww", new Uint8Array([1]));
  await lib.remove("k1");
  assert.equal(await lib.last(), null);
  assert.equal((await lib.list()).length, 0);
});
