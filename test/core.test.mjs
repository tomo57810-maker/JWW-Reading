import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aciToCss } from "../js/aci.js";
import { boundsOf, dashFor, buildModel, explainNotDrawing, layerLabel } from "../js/drawing.js";

test("ACI: 基本色と、白/黒の背景反転", () => {
  assert.equal(aciToCss(1, false), "rgb(255,0,0)");
  assert.equal(aciToCss(4, false), "rgb(0,255,255)");
  assert.equal(aciToCss(7, false), "#000000");
  assert.equal(aciToCss(7, true), "#ffffff");
  assert.equal(aciToCss(10, false), "rgb(255,0,0)");
  assert.equal(aciToCss(32, false), "rgb(165,82,0)");
  assert.equal(aciToCss(undefined, false), "#000000");
});

test("線種: 破線は配列、未知の線種は実線(null)", () => {
  assert.deepEqual(dashFor("JWW_DASHED1"), [2, 1]);
  assert.equal(dashFor("CONTINUOUS"), null);
  assert.equal(dashFor("SXF_USER_20"), null);
});

test("範囲: 線・円・文字を含めて計算する", () => {
  const b = boundsOf([
    { type: "LINE", x1: 0, y1: 0, x2: 10, y2: 5 },
    { type: "CIRCLE", center_x: 20, center_y: 20, radius: 3 },
    { type: "TEXT", x: -4, y: 1 },
  ]);
  assert.deepEqual(b, { x0: -4, y0: 0, x1: 23, y1: 23 });
  assert.equal(boundsOf([]), null);
});

// 16グループ×16レイヤの表(ezjwwと同じ並び: グループ番号×16+レイヤ番号)を作る
function fakeLayers(namesByIndex) {
  return Array.from({ length: 256 }, (_, i) => ({ name: namesByIndex[i] ?? `ﾚｲﾔ${i}` }));
}
function fakeHeader(groupNames, layerNames = {}, states = {}) {
  return {
    layer_groups: Array.from({ length: 16 }, (_, g) => ({
      name: groupNames[g] ?? `${g}グル-プ`,
      state: states[`g${g}`] ?? 2,
      layers: Array.from({ length: 16 }, (_, l) => ({ name: layerNames[g * 16 + l] ?? `ﾚｲﾔ${l}`, state: states[g * 16 + l] ?? 2 })),
    })),
  };
}

test("レイヤ番号の表記は、Jw_cadと同じ16進(0〜9、A〜F)", () => {
  assert.equal(layerLabel(0, 0), "0-0");
  assert.equal(layerLabel(10, 3), "A-3");
  assert.equal(layerLabel(15, 15), "F-F");
});

test("モデル: 図形のレイヤを、グループ→レイヤの順に整理して数える", () => {
  const dxfLayers = fakeLayers({ 160: "給水_A-0", 161: "給湯" });
  const header = fakeHeader({ 10: "給排水衛生設備" }, { 160: "給水", 161: "給湯" });
  const m = buildModel(
    {
      layers: dxfLayers,
      entities: [
        { type: "LINE", layer: "給水_A-0", x1: 0, y1: 0, x2: 1, y2: 1 },
        { type: "LINE", layer: "給水_A-0", x1: 0, y1: 0, x2: 1, y2: 1 },
        { type: "TEXT", layer: "給湯", x: 0, y: 0 },
      ],
    },
    header
  );
  assert.equal(m.groups.length, 16);
  const g = m.groups[10];
  assert.equal(g.name, "給排水衛生設備");
  assert.equal(g.layers[0].name, "給水");
  assert.equal(g.layers[0].label, "A-0");
  assert.equal(g.layers[0].count, 2);
  assert.equal(g.layers[1].count, 1);
  assert.equal(m.layerCount, 2);
  assert.equal(m.writeGroup, null);
  assert.equal(m.typeCounts.get("TEXT"), 1);
});

test("モデル: Jw_cadで非表示(状態0)のグループ・レイヤは、最初から隠す", () => {
  const dxfLayers = fakeLayers({ 0: "A", 1: "B", 16: "C" });
  const header = fakeHeader({}, {}, { 1: 0, g1: 0 });
  const entity = (layer) => ({ type: "POINT", layer, x: 0, y: 0 });
  const m = buildModel({ layers: dxfLayers, entities: [entity("A"), entity("B"), entity("C")] }, header);
  assert.equal(m.initiallyHidden.has("A"), false);
  assert.equal(m.initiallyHidden.has("B"), true); // レイヤの状態が0
  assert.equal(m.initiallyHidden.has("C"), true); // グループの状態が0
});

test("モデル: 表にないレイヤ名の図形や、ヘッダがない場合も、見えなくならない", () => {
  const m = buildModel({ layers: [], entities: [{ type: "POINT", layer: "謎", x: 0, y: 0 }] }, null);
  assert.equal(m.groups.length, 1);
  assert.equal(m.groups[0].layers[0].name, "謎");
  assert.equal(m.groups[0].layers[0].count, 1);
});

test("wasm(ブラウザ用に変換したezjww)がNodeでも初期化でき、JWWを判定できる", async () => {
  const wasm = readFileSync(new URL("../vendor/ezjww_wasm_bg.wasm", import.meta.url));
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => wasm });
  const { init, isJwwFile, readDrawing } = await import("../vendor/ezjww.mjs");
  await init();
  assert.equal(isJwwFile(new TextEncoder().encode("not a jww file")), false);
  assert.throws(() => readDrawing(new TextEncoder().encode("not a jww file")));
});

test("共有されたのがリンク(URL)なら、そのことを案内する", () => {
  const url = new TextEncoder().encode("https://1drv.ms/u/s!abc");
  assert.match(explainNotDrawing(url), /リンク/);
  assert.equal(explainNotDrawing(new TextEncoder().encode("JwwData.")), null);
});

import { makeTextEntities, textWidth } from "../js/text.js";
import { lineTypeLabel } from "../js/drawing.js";

test("文字の幅: 全角は高さ×幅率、半角はその半分(実ファイルの「※B」「改修後」と同じ計算)", () => {
  assert.ok(Math.abs(textWidth("※B", 3, 0.9) - 4.05) < 1e-9);
  assert.ok(Math.abs(textWidth("改修後", 4.5, 1.28) - 17.28) < 1e-9);
  const [t] = makeTextEntities("VP20", { x: 10, y: 5 }, { layer: "L", color: 3, height: 3, width_factor: 0.9, style: "STANDARD" }, 90);
  assert.equal(t.type, "TEXT");
  assert.ok(Math.abs(t.end_x - 10) < 1e-9 && Math.abs(t.end_y - (5 + 4 * 1.35)) < 1e-9); // 90度なら、上向きに伸びる
});

test("線種の呼び名", () => {
  assert.equal(lineTypeLabel("JWW_DASHED1"), "点線1");
  assert.equal(lineTypeLabel("SXF_USER_21"), "ユーザー線種21");
  assert.equal(lineTypeLabel("CONTINUOUS"), "実線");
});

import { buildDxf, dxfText } from "../js/dxf-export.js";

const BASE_DXF = [
  "  0", "SECTION", "  2", "HEADER", "  9", "$ACADVER", "  1", "AC1015", "  0", "ENDSEC",
  "  0", "SECTION", "  2", "TABLES",
  "  0", "TABLE", "  2", "LTYPE", "  0", "LTYPE", "  5", "6", "  2", "CONTINUOUS", "  0", "LTYPE", "  5", "7", "  2", "JWW_DASHED1", "  0", "ENDTAB",
  "  0", "TABLE", "  2", "LAYER", "  0", "LAYER", "  5", "15", "  2", "0", "  0", "LAYER", "  5", "16", "  2", "\\U+7D66\\U+6C34", "  0", "ENDTAB",
  "  0", "TABLE", "  2", "STYLE", "  0", "STYLE", "  5", "20", "  2", "STANDARD", "  0", "ENDTAB",
  "  0", "ENDSEC",
  "  0", "SECTION", "  2", "ENTITIES", "  0", "LINE", "  5", "99", "  8", "0", "  0", "ENDSEC",
  "  0", "SECTION", "  2", "OBJECTS", "  0", "DICTIONARY", "  5", "A4E7", "  0", "ENDSEC", "  0", "EOF", "",
].join("\n");

test("DXF: 文字は\\U+XXXXに直す。ASCIIはそのまま", () => {
  assert.equal(dxfText("VP20 給水"), "VP20 \\U+7D66\\U+6C34");
});

test("DXF書き出し: 図形の部分だけを編集後の図形に差し替え、表(レイヤ・線種)は残す。消した図形は書かない", () => {
  const ents = [
    { type: "LINE", layer: "給水", color: 3, line_type: "JWW_DASHED1", x1: 0, y1: 0, x2: 10, y2: 5 },
    null, // 消した図形
    { type: "CIRCLE", layer: "未登録のレイヤ", color: 1, line_type: "未登録の線種", center_x: 1, center_y: 2, radius: 3 },
    { type: "TEXT", layer: "0", color: 7, line_type: "CONTINUOUS", x: 5, y: 6, height: 3, width_factor: 0.9, rotation: 90, content: "給水管", style: "STANDARD" },
    { type: "ARC", layer: "0", color: 7, line_type: "CONTINUOUS", center_x: 0, center_y: 0, radius: 2, start_angle: 0, end_angle: 90 },
    { type: "SOLID", layer: "0", color: 7, line_type: "CONTINUOUS", x1: 0, y1: 0, x2: 1, y2: 0, x3: 0, y3: 1, x4: 0, y4: 1 },
    { type: "TEXT", layer: "0", content: "", height: 3 }, // 空の文字は書かない(数には入れない)
    { type: "INSERT", layer: "0" }, // 扱えない種類
  ];
  const { text, count, skipped } = buildDxf(BASE_DXF, ents);
  assert.equal(count, 5);
  assert.equal(skipped, 1);
  assert.ok(text.includes("JWW_DASHED1") && text.includes("\\U+7D66\\U+6C34")); // 表は残る
  assert.ok(text.includes("  0\nOBJECTS\n") || text.includes("  2\nOBJECTS\n")); // 図形の後ろも残る
  assert.ok(!text.includes("  5\n99\n")); // 原本の図形(ダミー)は差し替わっている
  const body = text.slice(text.indexOf("  2\nENTITIES\n"), text.indexOf("  2\nOBJECTS\n"));
  assert.ok(body.includes("  8\n\\U+7D66\\U+6C34\n 62\n3\n  6\nJWW_DASHED1")); // 線のレイヤ・色・線種
  assert.ok(body.includes("  8\n0\n 62\n1\n  6\nCONTINUOUS")); // 未登録のレイヤ・線種は、"0"・実線に
  assert.ok(body.includes("  1\n\\U+7D66\\U+6C34\\U+7BA1")); // 文字
  assert.ok(body.includes(" 50\n90.000000000")); // 回転
  const handles = [...body.matchAll(/\n {2}5\n([0-9A-F]+)\n/g)].map((m) => m[1]);
  assert.equal(new Set(handles).size, handles.length); // ハンドルは重複しない
  assert.ok(handles.every((h) => parseInt(h, 16) > 0x20)); // 表のハンドルと重ならない
});

test("DXF書き出し: 原本のDXFに図形の部分がなければ、わかりやすい例外", () => {
  assert.throws(() => buildDxf("  0\nEOF\n", []), /図形の部分/);
});
