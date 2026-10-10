import { test } from "node:test";
import assert from "node:assert/strict";
import { applyToPoint, transformEntity, entityBounds, pickEntity, pickInRect, distanceToEntity, EditStore, unionBounds } from "../js/edits.js";

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
