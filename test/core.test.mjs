import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aciToCss } from "../js/aci.js";
import { boundsOf, dashFor, buildModel } from "../js/drawing.js";

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

test("モデル: レイヤ別・種類別の個数を数える", () => {
  const m = buildModel({
    entities: [
      { type: "LINE", layer: "A", x1: 0, y1: 0, x2: 1, y2: 1 },
      { type: "LINE", layer: "A", x1: 0, y1: 0, x2: 1, y2: 1 },
      { type: "TEXT", layer: "B", x: 0, y: 0 },
    ],
  });
  assert.equal(m.layerCounts.get("A"), 2);
  assert.equal(m.typeCounts.get("TEXT"), 1);
});

test("wasm(ブラウザ用に変換したezjww)がNodeでも初期化でき、JWWを判定できる", async () => {
  const wasm = readFileSync(new URL("../vendor/ezjww_wasm_bg.wasm", import.meta.url));
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => wasm });
  const { init, isJwwFile, readDrawing } = await import("../vendor/ezjww.mjs");
  await init();
  assert.equal(isJwwFile(new TextEncoder().encode("not a jww file")), false);
  assert.throws(() => readDrawing(new TextEncoder().encode("not a jww file")));
});
