import { test } from "node:test";
import assert from "node:assert/strict";
import { applyToPoint, transformEntity, stretchEntity, entityBounds, pickEntity, pickInRect, distanceToEntity, EditStore, unionBounds } from "../js/edits.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("相似変換: 平行移動・回転(90度)・拡大が、基準点を中心に効く", () => {
  const xf = { cx: 10, cy: 10, dx: 5, dy: -2, theta: Math.PI / 2, s: 2 };
  // 基準点そのものは、平行移動だけ
  const c = applyToPoint(xf, 10, 10);
  near(c.x, 15); near(c.y, 8);
  // 基準点から右へ1の点は、2倍して90度回すと、上へ2
  const p = applyToPoint(xf, 11, 10);
  near(p.x, 15); near(p.y, 10);
});

test("図形の変換: 線・円・円弧・文字", () => {
  const xf = { cx: 0, cy: 0, dx: 0, dy: 0, theta: Math.PI / 2, s: 3 };
  const l = transformEntity({ type: "LINE", x1: 1, y1: 0, x2: 2, y2: 0 }, xf);
  near(l.x1, 0); near(l.y1, 3); near(l.x2, 0); near(l.y2, 6);
  const c = transformEntity({ type: "CIRCLE", center_x: 1, center_y: 0, radius: 2 }, xf);
  near(c.center_y, 3); near(c.radius, 6);
  const a = transformEntity({ type: "ARC", center_x: 0, center_y: 0, radius: 1, start_angle: 350, end_angle: 20 }, xf);
  near(a.start_angle, 80); near(a.end_angle, 110); near(a.radius, 3);
  const t = transformEntity({ type: "TEXT", x: 1, y: 0, end_x: 2, end_y: 0, height: 4, rotation: 10, content: "a" }, xf);
  near(t.x, 0); near(t.y, 3); near(t.height, 12); near(t.rotation, 100);
});

test("範囲と選択: 近い図形を選ぶ。四角の中に完全に入った図形だけを選ぶ", () => {
  const es = [
    { type: "LINE", x1: 0, y1: 0, x2: 10, y2: 0 },
    { type: "CIRCLE", center_x: 20, center_y: 20, radius: 5 },
    { type: "LINE", x1: 50, y1: 50, x2: 60, y2: 60 },
  ];
  assert.equal(pickEntity(es, 5, 1, 2), 0);
  assert.equal(pickEntity(es, 20, 25, 1), 1); // 円周の上
  assert.equal(pickEntity(es, 20, 20, 1), -1); // 円の中心は、円周からは遠い
  assert.deepEqual(pickInRect(es, { x0: -1, y0: -1, x1: 30, y1: 30 }), [0, 1]);
  assert.deepEqual(pickInRect(es, { x0: -1, y0: -1, x1: 8, y1: 8 }), []); // 線が一部はみ出す
  assert.equal(pickEntity(es, 5, 1, 2, (e) => e.type !== "LINE"), -1); // 見えない図形は選ばない
  near(distanceToEntity({ type: "ARC", center_x: 0, center_y: 0, radius: 10, start_angle: 0, end_angle: 90 }, 0, -10), Math.hypot(10, 10));
  assert.deepEqual(unionBounds([entityBounds(es[0]), entityBounds(es[1])]), { x0: 0, y0: 0, x1: 25, y1: 25 });
});

test("編集の記録: 変換・複製・削除を順に当てはめ、取り消しで元に戻る。原本は変わらない", () => {
  const base = [
    { type: "LINE", x1: 0, y1: 0, x2: 10, y2: 0 },
    { type: "LINE", x1: 0, y1: 5, x2: 10, y2: 5 },
  ];
  const s = new EditStore(base);
  s.add({ type: "xform", ids: [0], xf: { cx: 0, cy: 0, dx: 3, dy: 4, theta: 0, s: 1 } });
  assert.equal(s.entities[0].x1, 3);
  assert.equal(base[0].x1, 0); // 原本は不変
  s.add({ type: "copy", ids: [1], xf: { cx: 0, cy: 0, dx: 0, dy: -5, theta: 0, s: 1 } });
  assert.equal(s.entities.length, 3);
  assert.equal(s.entities[2].y1, 0);
  s.add({ type: "delete", ids: [0] });
  assert.equal(s.entities[0], null);
  s.undo();
  assert.equal(s.entities[0].x1, 3);
  // 保存と読み込み(同じ原本から、同じ結果になる)
  const saved = JSON.parse(JSON.stringify(s.toJSON()));
  const s2 = new EditStore(base);
  assert.deepEqual(s2.load(saved), { ok: true, count: 2 });
  assert.deepEqual(s2.entities, s.entities);
  // 図形の数が違う原本には、当てはめない
  const s3 = new EditStore(base.slice(0, 1));
  assert.equal(s3.load(saved).ok, false);
  assert.equal(s3.ops.length, 0);
  s.clear();
  assert.deepEqual(s.entities, base);
});

test("円弧の外接する四角: 90度の弧は、四分円の範囲(円全体ではない)", () => {
  const b = entityBounds({ type: "ARC", center_x: 0, center_y: 0, radius: 10, start_angle: 0, end_angle: 90 });
  near(b.x0, 0); near(b.y0, 0); near(b.x1, 10); near(b.y1, 10);
  // 350度→20度(0度をまたぐ弧)は、右端(x=10)を通る
  const c = entityBounds({ type: "ARC", center_x: 0, center_y: 0, radius: 10, start_angle: 350, end_angle: 20 });
  near(c.x1, 10);
  assert.ok(c.y0 < 0 && c.y1 > 0);
});

test("伸縮: 窓の中の端点だけが動き、長さが変わる(W1200 → W900)", () => {
  // 幅1200の流し台(用紙mm、縮尺1/1なら実寸と同じ)。右半分を囲んで、左へ300動かす
  const sink = [
    { type: "LINE", x1: 0, y1: 0, x2: 1200, y2: 0 }, // 前面
    { type: "LINE", x1: 0, y1: 0, x2: 0, y2: 600 }, // 左側面
    { type: "LINE", x1: 1200, y1: 0, x2: 1200, y2: 600 }, // 右側面
    { type: "LINE", x1: 0, y1: 600, x2: 1200, y2: 600 }, // 背面
    { type: "CIRCLE", center_x: 900, center_y: 300, radius: 50 }, // 右側の排水口(窓の中: 動く)
    { type: "CIRCLE", center_x: 300, center_y: 300, radius: 50 }, // 左側の排水口(窓の外: 動かない)
  ];
  const win = { x0: 800, y0: -10, x1: 1300, y1: 700 };
  const out = sink.map((e) => stretchEntity(e, win, -300, 0));
  assert.deepEqual([out[0].x1, out[0].x2], [0, 900]); // 前面は 1200 → 900
  assert.deepEqual([out[3].x1, out[3].x2], [0, 900]);
  assert.deepEqual([out[1].x1, out[1].x2], [0, 0]); // 左側面は動かない
  assert.deepEqual([out[2].x1, out[2].x2], [900, 900]); // 右側面は、まるごと左へ
  assert.equal(out[4].center_x, 600); // 右の排水口は動く
  assert.equal(out[5].center_x, 300); // 左は動かない
  // 記録として保存・復元しても、同じ結果
  const s = new EditStore(sink);
  s.add({ type: "stretch", ids: [0, 1, 2, 3, 4, 5], win, dx: -300, dy: 0 });
  const s2 = new EditStore(sink);
  s2.load(JSON.parse(JSON.stringify(s.toJSON())));
  assert.deepEqual(s2.entities, out);
  assert.equal(sink[0].x2, 1200); // 原本は不変
});

test("描き足し: 図形を末尾に足し、取り消し・保存・復元でも同じ番号になる", () => {
  const base = [{ type: "LINE", x1: 0, y1: 0, x2: 1, y2: 1 }];
  const s = new EditStore(base);
  const rect = [
    { type: "LINE", layer: "L", x1: 0, y1: 0, x2: 2, y2: 0 },
    { type: "LINE", layer: "L", x1: 2, y1: 0, x2: 2, y2: 1 },
  ];
  const op = s.add({ type: "add", entities: rect });
  assert.deepEqual(op.newIds, [1, 2]);
  assert.equal(s.entities.length, 3);
  s.add({ type: "add", entities: [{ type: "CIRCLE", layer: "L", center_x: 5, center_y: 5, radius: 1 }] });
  assert.equal(s.entities[3].type, "CIRCLE");
  // 描き足した図形も、あとから移動できる
  s.add({ type: "xform", ids: [3], xf: { cx: 5, cy: 5, dx: 1, dy: 0, theta: 0, s: 1 } });
  assert.equal(s.entities[3].center_x, 6);
  // 保存・復元
  const s2 = new EditStore(base);
  assert.deepEqual(s2.load(JSON.parse(JSON.stringify(s.toJSON()))), { ok: true, count: 3 });
  assert.deepEqual(s2.entities, s.entities);
  // 取り消し(末尾から)
  s.undo();
  s.undo();
  assert.equal(s.entities.length, 3);
  s.undo();
  assert.equal(s.entities.length, 1);
  assert.equal(base.length, 1); // 原本は不変
});
