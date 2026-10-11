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

function setupShapes(entities) {
  const added = [];
  const notices = [];
  const { tc, tap, pt, viewer } = setup();
  viewer.hiddenLayers = new Set();
  tc.objectTool = { edits: { entities }, addEntities: (list) => added.push(...list), clearSelection() {} };
  tc.getDrawStyle = () => ({ layer: "書込", color: 3 });
  tc.onNotice = (m) => notices.push(m);
  return { tc, tap, pt, added, notices, viewer };
}

const DASHED = { type: "LINE", layer: "L2", color: 5, line_type: "JWW_DASHED1", line_weight: 25, x1: 0, y1: 100, x2: 100, y2: 100 };
const SOLID = { type: "LINE", layer: "L3", color: 1, line_type: "CONTINUOUS", line_weight: -3, x1: 0, y1: 0, x2: 100, y2: 0 };

test("属性取得: 既存の線の線種・色・太さ・レイヤを取り、次に描く線に使う", async () => {
  const { tc, tap, added, notices } = setupShapes([SOLID, DASHED]);
  tc.setMode("line");
  await tap(10, 10);
  await tap(60, 10);
  assert.deepEqual([added[0].layer, added[0].color, added[0].line_type], ["書込", 3, "CONTINUOUS"]); // 取得前は既定
  tc.togglePick();
  assert.equal(tc.picking, true);
  await tap(50, 101); // 点線の近く
  assert.equal(tc.picking, false);
  assert.match(notices.at(-1), /点線1/);
  assert.equal(tc.draft, null); // 属性取得のタップで、点は置かれない
  await tap(10, 20);
  await tap(60, 20);
  assert.deepEqual(
    [added[1].layer, added[1].color, added[1].line_type, added[1].line_weight],
    ["L2", 5, "JWW_DASHED1", 25]
  );
  tc.resetAttr();
  await tap(10, 30);
  await tap(60, 30);
  assert.equal(added[2].line_type, "CONTINUOUS");
});

test("属性取得: 何もない所をタップしても取得待ちのまま。矩形・円にも属性が使われる", async () => {
  const { tc, tap, added, notices } = setupShapes([DASHED]);
  tc.setMode("rect");
  tc.togglePick();
  await tap(500, 500);
  assert.equal(tc.picking, true);
  assert.match(notices.at(-1), /見つかりません/);
  await tap(30, 99);
  assert.equal(tc.picking, false);
  await tap(10, 10);
  await tap(40, 30);
  assert.equal(added.length, 4);
  assert.ok(added.every((e) => e.line_type === "JWW_DASHED1" && e.layer === "L2"));
  tc.setMode("circle");
  await tap(100, 100);
  await tap(120, 100);
  assert.equal(added.at(-1).type, "CIRCLE");
  assert.equal(added.at(-1).line_type, "JWW_DASHED1");
});

test("属性取得: 非表示レイヤの線は取れない。文字モードでは線ではなく文字から取る", async () => {
  const text = { type: "TEXT", layer: "T", color: 2, x: 200, y: 200, end_x: 210, end_y: 200, height: 4.5, width_factor: 1.28, rotation: 0, content: "改修後", style: "STANDARD" };
  const { tc, tap, viewer, notices } = setupShapes([DASHED, text]);
  viewer.hiddenLayers = new Set(["L2"]);
  tc.setMode("line");
  tc.togglePick();
  await tap(50, 100);
  assert.equal(tc.lineAttr, null);
  tc.setMode("ctext");
  assert.equal(tc.picking, false); // モードを変えると取得待ちは解除
  tc.togglePick();
  await tap(50, 100); // 線は文字ではない
  assert.equal(tc.textAttr, null);
  await tap(205, 202);
  assert.deepEqual(tc.textAttr, { layer: "T", color: 2, style: "STANDARD", height: 4.5, width_factor: 1.28 });
  assert.match(notices.at(-1), /高さ4.5/);
});

test("文字: タップした所に、取得した属性でTEXTを描き足す。高さの入力は次回に引き継ぐ", async () => {
  const text = { type: "TEXT", layer: "T", color: 2, x: 200, y: 200, end_x: 210, end_y: 200, height: 4.5, width_factor: 1.28, rotation: 0, content: "A", style: "STANDARD" };
  const { tc, tap, added } = setupShapes([text]);
  tc.askDrawText = async ({ initial, height }) => ({ text: "給水管\nVP20", height });
  tc.setMode("ctext");
  await tap(10, 50);
  assert.equal(added.length, 2); // 2行 → 2つの文字
  assert.deepEqual([added[0].layer, added[0].height, added[0].width_factor], ["書込", 3, 0.9]); // 取得前は既定
  assert.equal(added[0].x, 10);
  assert.ok(added[1].y < added[0].y); // 2行目は下
  tc.togglePick();
  await tap(205, 202);
  tc.askDrawText = async () => ({ text: "弁", height: 6 });
  await tap(100, 100);
  const t = added.at(-1);
  assert.deepEqual([t.layer, t.color, t.height, t.width_factor], ["T", 2, 6, 1.28]);
  assert.equal(tc.textAttr.height, 6); // 次の文字にも、6mmを使う
});

test("文字: キャンセルや空文字では何も描かない", async () => {
  const { tc, tap, added } = setupShapes([]);
  tc.askDrawText = async () => null;
  tc.setMode("ctext");
  await tap(10, 10);
  tc.askDrawText = async () => ({ text: "  \n", height: 3 });
  await tap(10, 10);
  assert.equal(added.length, 0);
});

test("矢印: 根元と先端の2点で、軸の線と塗りつぶしの頭(三角形)を描き足す。属性取得も使われる", async () => {
  const { tc, tap, added } = setupShapes([DASHED]);
  tc.setMode("arrow");
  await tap(0, 0);
  await tap(40, 0);
  assert.equal(added.length, 2);
  const [shaft, head] = added;
  assert.equal(shaft.type, "LINE");
  assert.equal(head.type, "SOLID");
  assert.deepEqual([head.x1, head.y1], [40, 0]); // 先端
  assert.ok(Math.abs(shaft.x2 - 37) < 1e-9); // 頭は3mm。軸は頭の根元まで
  assert.ok(Math.abs(head.y2 + head.y3) < 1e-9 && head.y2 !== head.y3); // 頭は軸の左右対称
  assert.deepEqual([head.x3, head.y3], [head.x4, head.y4]);
  tc.togglePick();
  await tap(50, 100);
  await tap(0, 20);
  await tap(4, 20); // 短い矢印(4mm): 頭は全長の半分(2mm)まで
  assert.equal(added.at(-1).line_type, "JWW_DASHED1");
  assert.ok(Math.abs(added.at(-2).x2 - 2) < 1e-9);
});

test("選択: 図面の図形の操作と、注釈の操作を、1つのモードで振り分ける", async () => {
  const calls = [];
  const sub = {
    hasSelection: false, baseMove: null, stretch: null, edits: { entities: [] },
    hitsCornerHandle: () => false, clearSelection() { this.hasSelection = false; },
    down: () => calls.push("down"), move: () => calls.push("move"), up: () => calls.push("up"), abort: () => calls.push("abort"),
  };
  const { tc, store, pt, tap } = setup();
  tc.objectTool = sub;
  const note = store.add({ kind: "mark", at: { x: 100, y: 100 } });
  tc.setMode("select");
  // 注釈の上: 注釈を選ぶ(図面の図形のツールには渡さない)
  tc.down(pt(100, 101));
  assert.equal(tc.selectedId, note.id);
  await tc.up(pt(100, 101));
  assert.deepEqual(calls, []);
  // 何もない所: 図面の図形のツールに預け、注釈の選択は外す
  tc.down(pt(300, 300));
  assert.equal(tc.selectedId, null);
  tc.move(pt(310, 310));
  await tc.up(pt(310, 310));
  assert.deepEqual(calls, ["down", "move", "up"]);
  // 図形を選んでいる間の、角の取っ手は、注釈より優先
  sub.hasSelection = true;
  sub.hitsCornerHandle = () => true;
  tc.down(pt(100, 101));
  assert.equal(tc.selectedId, null);
  tc.abort();
  assert.equal(calls.at(-1), "abort");
  // 注釈を選ぶと、図形の選択は外れる
  sub.hitsCornerHandle = () => false;
  tc.down(pt(100, 101));
  assert.equal(tc.selectedId, note.id);
  assert.equal(sub.hasSelection, false);
  await tc.up(pt(100, 101));
});

test("壁3D: 点を順にタップして「完了」で、なぞった点が壁として渡る。最初の点にもう一度触れると閉じる", async () => {
  const walls = [];
  const { tc, tap } = setup();
  tc.onWall = (w) => walls.push(w);
  tc.getWallParams = () => ({ height: 2700, thick: 200, z0: 0, align: "center" });
  tc.setMode("wall");
  await tap(0, 0);
  assert.equal(tc.draft.item.thick, 200); // 作図中の帯の太さ
  assert.equal(tc.finish(), false); // 1点では完了できない
  await tap(100, 0);
  await tap(100, 100);
  assert.equal(tc.finish(), true);
  assert.deepEqual(walls[0], { path: [[0, 0], [100, 0], [100, 100]], closed: false });
  assert.equal(tc.draft, null);
  // 輪を閉じる
  await tap(0, 0);
  await tap(100, 0);
  await tap(100, 100);
  await tap(0, 100);
  await tap(2, 3); // 最初の点の近く(14px以内)
  assert.deepEqual(walls[1], { path: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true });
  assert.equal(tc.draft, null);
});
