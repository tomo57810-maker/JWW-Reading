import { test } from "node:test";
import assert from "node:assert/strict";
import { ObjectTool } from "../js/object-tool.js";
import { EditStore } from "../js/edits.js";
import { SnapIndex } from "../js/geometry.js";
import { ToolController } from "../js/tools.js";
import { AnnotationStore } from "../js/annotations.js";

const L = (x1, y1, x2, y2) => ({ type: "LINE", layer: "A", x1, y1, x2, y2 });

function setup() {
  const calls = { floatingEntities: 0 };
  const viewer = {
    view: { s: 10, tx: 0, ty: 0 }, hiddenLayers: new Set(), entities: null, tool: null, toolPointerId: null,
    setFloating() {}, setFloatTransform() {}, setFloatingEntities() { calls.floatingEntities++; }, setEntities(e) { this.entities = e; }, redraw() {},
  };
  // 幅12×奥行6の箱(用紙mm)と、右の排水口
  const base = [L(0, 0, 12, 0), L(0, 0, 0, 6), L(12, 0, 12, 6), L(0, 6, 12, 6), { type: "CIRCLE", layer: "A", center_x: 9, center_y: 3, radius: 1 },
    L(100, 0, 100, 10)]; // 別の図形(吸着の対象)
  const edits = new EditStore(base);
  let snap = new SnapIndex(edits.entities);
  const tool = new ObjectTool({ viewer, edits, getSnap: () => snap, getScale: () => 100, askOffset: async () => ({ dx: -300, dy: 0 }) });
  // 画面は10倍(1用紙mm = 10px)。画面の位置は、用紙mmの座標から作る
  const pt = (x, y) => ({ sx: x * 10, sy: -y * 10, world: { x, y } });
  return { viewer, edits, tool, pt, setSnap: (s) => (snap = s), calls };
}

test("基点移動: 動かす側の中点を指定し、移動先の端点にぴったり重ねる", () => {
  const { tool, edits, pt } = setup();
  tool.select([0, 1, 2, 3, 4]);
  tool.beginBaseMove();
  // 前面(0,0)-(12,0) の中点 (6,0) をタップ → 動かす側の基点
  tool.down(pt(6.3, 0.2));
  tool.up(pt(6.3, 0.2));
  assert.equal(tool.baseMove.stage, "dest");
  assert.deepEqual(tool.baseMove.base, { x: 6, y: 0 });
  // 別の図形(100,0)の端点の近くをタップ → 端点に吸着して、中点が(100,0)に移る
  tool.down(pt(99.5, 0.4));
  tool.up(pt(99.5, 0.4));
  assert.equal(tool.baseMove, null);
  const front = edits.entities[0];
  assert.deepEqual([front.x1, front.x2, front.y1], [94, 106, 0]);
  assert.equal(edits.entities[5].x1, 100); // 移動先の図形は動かない
});

test("移動の自動吸着: 動かす側の端点が、他の点の近くに来ると、ぴったり重なる(選択中の図形自身には吸着しない)", () => {
  const { tool, edits, pt } = setup();
  tool.select([0, 1, 2, 3, 4]);
  // 右下の角 (12,0) を (100,0) に近づける: 指の動きは +87.5 (本来は 99.5 に着く)
  tool.down(pt(6, 3)); // 枠の中
  tool.move(pt(6 + 87.5, 3 + 0.4));
  assert.deepEqual(tool.xf && [tool.xf.dx, tool.xf.dy], [88, 0]); // 補正されて、ちょうど 12+88=100
  tool.up(pt(6 + 87.5, 3 + 0.4));
  const front = edits.entities[0];
  assert.equal(front.x2, 100);
  assert.equal(front.y2, 0);
});

test("伸縮: 窓で囲んだ側を、数値(実寸mm)で動かして確定する", async () => {
  const { tool, edits, pt } = setup();
  tool.select([0, 1, 2, 3, 4]);
  tool.beginStretch();
  assert.equal(tool.stretch.stage, "window");
  // 右半分を囲む窓(x: 6〜13, y: -1〜7)をドラッグ
  tool.down(pt(6, -1));
  tool.move(pt(13, 7));
  tool.up(pt(13, 7));
  assert.equal(tool.stretch.stage, "offset");
  await tool.askStretchOffset(); // 横 -300 mm(実寸) → 縮尺1/100で、用紙 -3 mm
  assert.equal(tool.stretch.dx, -3);
  assert.equal(tool.finish(), true);
  assert.deepEqual([edits.entities[0].x1, edits.entities[0].x2], [0, 9]); // 幅12 → 9 (実寸 1200 → 900)
  assert.deepEqual([edits.entities[2].x1, edits.entities[2].x2], [9, 9]);
  assert.equal(edits.entities[4].center_x, 6); // 右の排水口も、左へ3
  assert.equal(edits.ops.at(-1).type, "stretch");
});

test("基準点: 基点から、横・縦の距離(実寸mm)の位置に、点を打つ", async () => {
  const viewer = { view: { s: 1, tx: 0, ty: 0 }, tool: null, toolPointerId: null, redraw() {} };
  const store = new AnnotationStore();
  const snap = new SnapIndex([L(0, 0, 50, 0)]);
  const tc = new ToolController({
    viewer, store, getScale: () => 100, getSnap: () => snap, askText: async () => "", askOffset: async () => ({ dx: 1000, dy: -500 }),
  });
  tc.setMode("mark");
  const p = { sx: 50.4, sy: 0.3, world: { x: 50.4, y: 0.3 } };
  tc.down(p);
  await tc.up(p);
  const mark = store.items.find((i) => i.kind === "mark");
  assert.deepEqual(mark.at, { x: 60, y: -5 }); // 端点(50,0) + (1000, -500)/100
  assert.equal(mark.note, "横1000 縦-500");
});
