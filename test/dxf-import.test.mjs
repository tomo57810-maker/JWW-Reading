import test from "node:test";
import assert from "node:assert/strict";
import { cleanMtext, cleanText, decodeDxf, isBinaryDxf, looksLikeDxf, readDxfDrawing } from "../js/dxf-import.js";
import { buildModel } from "../js/drawing.js";

/** [コード, 値] の並びを、DXFの文字列にする。 */
const dxf = (...sections) => sections.map(([name, body]) => `0\nSECTION\n2\n${name}\n${body}0\nENDSEC\n`).join("") + "0\nEOF\n";
const g = (...pairs) => pairs.map(([c, v]) => `${c}\n${v}\n`).join("");
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

const TABLES = ["TABLES", g([0, "TABLE"], [2, "LAYER"], [0, "LAYER"], [2, "壁"], [62, 3], [6, "CONTINUOUS"], [0, "LAYER"], [2, "DIM"], [62, -5], [0, "ENDTAB"])];

test("DXF: 判定と文字コード", () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.equal(looksLikeDxf(enc("0\r\nSECTION\r\n2\r\nHEADER\r\n")), true);
  assert.equal(looksLikeDxf(enc("999\nmade by x\n0\nSECTION\n")), true);
  assert.equal(looksLikeDxf(enc("JwwData.\u0000\u0000")), false);
  assert.equal(isBinaryDxf(enc("AutoCAD Binary DXF\r\n\u001a\u0000")), true);
  assert.equal(decodeDxf(enc("日本語")), "日本語");
  const sjis = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]); // 日本語(Shift_JIS)
  assert.equal(decodeDxf(sjis), "日本語");
  assert.equal(cleanText("\\U+65E5\\U+672C %%c100 45%%d"), "日本 Ø100 45°");
  assert.equal(cleanMtext("{\\fMS Gothic|b0;壁}\\P下"), "壁\n下");
});

test("DXF: 線・円・円弧・点・文字と、レイヤの色(レイヤ指定)", () => {
  const body = g([0, "LINE"], [8, "壁"], [10, 0], [20, 0], [11, 100], [21, 50])
    + g([0, "CIRCLE"], [8, "壁"], [62, 1], [10, 10], [20, 20], [40, 5])
    + g([0, "ARC"], [8, "壁"], [10, 0], [20, 0], [40, 10], [50, 0], [51, 90])
    + g([0, "POINT"], [8, "壁"], [10, 1], [20, 2])
    + g([0, "TEXT"], [8, "壁"], [10, 5], [20, 6], [40, 3], [1, "A\\U+3042"], [50, 90]);
  const d = readDxfDrawing(dxf(TABLES, ["ENTITIES", body]));
  assert.deepEqual(d.entities.map((e) => e.type), ["LINE", "CIRCLE", "ARC", "POINT", "TEXT"]);
  assert.equal(d.entities[0].color, 3); // レイヤの色
  assert.equal(d.entities[1].color, 1); // 図形に指定した色
  const t = d.entities[4];
  assert.equal(t.content, "Aあ");
  near(t.rotation, 90);
  near(t.end_x, 5, 1e-9);
  near(t.end_y, 6 + (0.5 + 1) * 3 * 1, 1e-9); // 半角1+全角1 = 1.5文字ぶん、上向きに伸びる
  // レイヤの表: オフ(色が負)のレイヤは、最初から隠す
  const model = buildModel(d, null);
  assert.equal(model.initiallyHidden.has("DIM"), true);
  assert.equal(model.initiallyHidden.has("壁"), false);
});

test("DXF: LWPOLYLINE(ふくらみつき)と POLYLINE/VERTEX", () => {
  // (0,0)→(10,0) 直線、(10,0)→(10,10) ふくらみ1(反時計回りの半円)、閉じる
  const lw = g([0, "LWPOLYLINE"], [8, "0"], [70, 1], [10, 0], [20, 0], [10, 10], [20, 0], [42, 1], [10, 10], [20, 10]);
  const d = readDxfDrawing(dxf(["ENTITIES", lw]));
  assert.deepEqual(d.entities.map((e) => e.type), ["LINE", "ARC", "LINE"]);
  const arc = d.entities[1];
  near(arc.radius, 5);
  near(arc.center_x, 10); // 半円: 中心は弦の中点(10,5)
  near(arc.center_y, 5);
  near(arc.start_angle, 270); // (10,0) は中心の真下
  near(arc.end_angle, 90); // (10,10) は中心の真上。反時計回りで右側(x>10)を通る
  const pl = g([0, "POLYLINE"], [8, "0"], [70, 0], [0, "VERTEX"], [10, 0], [20, 0], [0, "VERTEX"], [10, 5], [20, 0], [0, "VERTEX"], [10, 5], [20, 5], [0, "SEQEND"]);
  const d2 = readDxfDrawing(dxf(["ENTITIES", pl]));
  assert.equal(d2.entities.length, 2);
  assert.equal(d2.entities[1].y2, 5);
  // 時計回り(ふくらみが負)は、反時計回りに直した円弧になる
  const cw = g([0, "LWPOLYLINE"], [8, "0"], [70, 0], [10, 10], [20, 0], [42, -1], [10, 0], [20, 0]);
  const c = readDxfDrawing(dxf(["ENTITIES", cw])).entities[0];
  near(c.center_x, 5);
  near(c.center_y, 0);
  near(c.start_angle, 180);
  near(c.end_angle % 360, 0); // 0° (360°と同じ)
});

test("DXF: ブロックの挿入(拡大・回転・基点)と、ブロック内の色・レイヤ", () => {
  const blocks = ["BLOCKS", g([0, "BLOCK"], [2, "B1"], [10, 1], [20, 1])
    + g([0, "LINE"], [8, "0"], [62, 0], [10, 1], [20, 1], [11, 3], [21, 1]) // ブロック指定の色
    + g([0, "ENDBLK"])];
  const ins = g([0, "INSERT"], [8, "壁"], [62, 2], [2, "B1"], [10, 100], [20, 200], [41, 2], [42, 2], [50, 90]);
  const d = readDxfDrawing(dxf(TABLES, blocks, ["ENTITIES", ins]));
  assert.equal(d.entities.length, 1);
  const e = d.entities[0];
  // 基点(1,1)が挿入点(100,200)に来る。線は基点から右へ2 → 2倍 → 90度回転で上へ4
  near(e.x1, 100); near(e.y1, 200); near(e.x2, 100); near(e.y2, 204);
  assert.equal(e.color, 2); // ブロック指定の色は、挿入した図形の色
  assert.equal(e.layer, "壁"); // レイヤ0の図形は、挿入した図形のレイヤになる
});

test("DXF: 寸法はブロックとして置く。単位がmなら×1000でmmにする。未対応の種類は数える", () => {
  const blocks = ["BLOCKS", g([0, "BLOCK"], [2, "*D1"], [10, 0], [20, 0]) + g([0, "LINE"], [8, "0"], [10, 0], [20, 0], [11, 1], [21, 0]) + g([0, "ENDBLK"])];
  const body = g([0, "DIMENSION"], [8, "0"], [2, "*D1"]) + g([0, "HATCH"], [8, "0"]) + g([0, "LINE"], [8, "0"], [10, 0], [20, 0], [11, 2], [21, 0]);
  const d = readDxfDrawing(dxf(["HEADER", g([9, "$INSUNITS"], [70, 6])], blocks, ["ENTITIES", body]));
  assert.equal(d.unitScale, 1000);
  assert.equal(d.entities.length, 2);
  near(d.entities[0].x2, 1000);
  near(d.entities[1].x2, 2000);
  assert.deepEqual(d.unsupportedTypes, ["HATCH"]);
  assert.equal(d.unsupported_entities.length, 1);
});

test("DXF: 鏡像の挿入で円弧の向きを保つ。ASCIIでないDXFや図形のないDXFは、わけを添えて失敗する", () => {
  const blocks = ["BLOCKS", g([0, "BLOCK"], [2, "A"], [10, 0], [20, 0]) + g([0, "ARC"], [8, "0"], [10, 0], [20, 0], [40, 1], [50, 0], [51, 90]) + g([0, "ENDBLK"])];
  const ins = g([0, "INSERT"], [8, "0"], [2, "A"], [10, 0], [20, 0], [41, -1], [42, 1]);
  const a = readDxfDrawing(dxf(blocks, ["ENTITIES", ins])).entities[0];
  // x を反転すると、0〜90度の円弧は 90〜180度になる
  near(a.start_angle, 90);
  near(a.end_angle, 180);
  assert.throws(() => readDxfDrawing("これはDXFではありません"), /DXF/);
});
