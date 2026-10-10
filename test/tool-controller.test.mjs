import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolController } from "../js/tools.js";
import { AnnotationStore } from "../js/annotations.js";

function setup() {
  const viewer = { view: { s: 1, tx: 0, ty: 0 }, tool: null, toolPointerId: null, redraw() {} };
  const store = new AnnotationStore();
  const tc = new ToolController({
    viewer, store, getScale: () => 100, getSnap: () => null,
    askText: async (_at, initial) => initial || "メモ", getTextRect: () => null,
  });
  const pt = (x, y) => ({ sx: x, sy: y, world: { x, y } });
  const tap = async (x, y) => { tc.down(pt(x, y)); await tc.up(pt(x, y)); };
  return { tc, store, tap, pt, viewer };
}

test("回帰: 点を置いたあとの2本指操作(abort)で、作図中の点は消えない", async () => {
  const { tc, tap } = setup();
  tc.setMode("route");
  await tap(10, 10);
  await tap(50, 10);
  assert.equal(tc.draft.item.points.length, 2);
  tc.abort(); // 2本目の指が触れたとき、画面側から呼ばれる
  assert.equal(tc.draft.item.points.length, 2);
  tc.cancel(); // 「取消」ボタン
  assert.equal(tc.draft, null);
});

test("寸法: 2点で完成し、縮尺が記録される。吸着用の点そのものは持たない", async () => {
  const snapPoint = { x: 10, y: 10 };
  const { tc, store, tap } = setup();
  const snapPoint2 = { x: 20, y: 10 };
  tc.getSnap = () => ({ nearest: (p) => (p.x < 15 ? snapPoint : snapPoint2) });
  tc.setMode("dim");
  await tap(11, 11);
  await tap(21, 11);
  assert.equal(store.items.length, 1);
  assert.equal(store.items[0].scale, 100);
  assert.notEqual(store.items[0].points[0], snapPoint);
});

test("選択: ドラッグで移動、複製は少しずらして選択、削除", async () => {
  const { tc, store, pt } = setup();
  const a = store.add({ kind: "route", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], scale: 100 });
  tc.setMode("select");
  tc.down(pt(50, 2)); // 線の近く
  assert.equal(tc.selectedId, a.id);
  tc.move(pt(70, 22));
  await tc.up(pt(70, 22));
  assert.deepEqual(store.items[0].points, [{ x: 20, y: 20 }, { x: 120, y: 20 }]);
  const copy = tc.copySelected();
  assert.notEqual(copy.id, a.id);
  assert.equal(store.items.length, 2);
  assert.equal(tc.selectedId, copy.id);
  assert.equal(store.items[0].points[0].x, 20); // 元は動かない
  tc.deleteSelected();
  assert.equal(store.items.length, 1);
  assert.equal(tc.selectedId, null);
});

test("コメント: 置くと選択に切り替わる。文字を直せる", async () => {
  const { tc, store, tap } = setup();
  tc.setMode("text");
  await tap(30, 30);
  assert.equal(tc.mode, "select");
  assert.equal(tc.selected.text, "メモ");
  await tc.editSelectedText(); // askTextは、現在の文字をそのまま返す(ここでは動作の確認のみ)
  assert.equal(store.items.length, 1);
});
