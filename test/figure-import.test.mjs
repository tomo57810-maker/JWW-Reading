import test from "node:test";
import assert from "node:assert/strict";
import { prepareFigure } from "../js/figure-import.js";
import { makeJpegPdf, makeJpegPdfPages } from "../js/pdf.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const LINE = (x1, y1, x2, y2, extra = {}) => ({ type: "LINE", layer: "元", color: 3, line_type: "CONTINUOUS", x1, y1, x2, y2, ...extra });

test("図形の取り込み: 中心を置く位置に合わせ、レイヤを入れ先に替える。色・線種は残す", () => {
  const src = [LINE(0, 0, 10, 0), LINE(10, 0, 10, 20), { type: "CIRCLE", layer: "元", color: 5, line_type: "CONTINUOUS", center_x: 5, center_y: 10, radius: 2 }];
  const r = prepareFigure(src, { target: { x: 100, y: 200 }, layer: "書込" });
  assert.equal(r.entities.length, 3);
  assert.ok(r.entities.every((e) => e.layer === "書込"));
  assert.equal(r.entities[0].color, 3);
  // 元の範囲 (0,0)-(10,20) の中心 (5,10) が (100,200) に来る
  near(r.entities[0].x1, 95); near(r.entities[0].y1, 190);
  near(r.entities[2].center_x, 100); near(r.entities[2].center_y, 200);
  near((r.bounds.x0 + r.bounds.x1) / 2, 100); near((r.bounds.y0 + r.bounds.y1) / 2, 200);
  assert.equal(src[0].layer, "元"); // 元の図形は変えない
  assert.equal(src[0].x1, 0);
});

test("図形の取り込み: 倍率は中心を保って掛ける。文字は高さも倍になる", () => {
  const src = [LINE(0, 0, 10, 0), { type: "TEXT", layer: "元", color: 7, x: 0, y: 0, end_x: 4, end_y: 0, height: 2, width_factor: 1, rotation: 0, content: "WC", style: "STANDARD" }];
  const r = prepareFigure(src, { target: { x: 0, y: 0 }, factor: 2, layer: "L" });
  near(r.entities[0].x2 - r.entities[0].x1, 20);
  assert.equal(r.entities[1].height, 4);
  near(r.entities[1].end_x - r.entities[1].x, 8);
});

test("図形の取り込み: 取り込めない種類は数えて除く。取り込めるものがなければ空", () => {
  const poly = { type: "FILLED_POLYGON", layer: "元", color: 1, points: [] };
  const r = prepareFigure([null, LINE(0, 0, 1, 1), poly], { target: { x: 0, y: 0 }, layer: "L" });
  assert.equal(r.entities.length, 1);
  assert.equal(r.skipped, 1);
  const none = prepareFigure([poly], { target: { x: 0, y: 0 }, layer: "L" });
  assert.equal(none.entities.length, 0);
  assert.equal(none.bounds, null);
  assert.equal(prepareFigure([LINE(0, 0, 1, 1)], { target: { x: 0, y: 0 }, factor: 0, layer: "L" }).entities.length, 0);
});

test("複数ページのPDF: ページ数・ページごとの大きさ・参照の番号が合う", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const pages = [
    { jpeg, widthPx: 10, heightPx: 5, pageWidthMm: 420, pageHeightMm: 297 },
    { jpeg, widthPx: 5, heightPx: 10, pageWidthMm: 210, pageHeightMm: 297 },
    { jpeg, widthPx: 8, heightPx: 8, pageWidthMm: 100, pageHeightMm: 100 },
  ];
  const text = new TextDecoder("latin1").decode(makeJpegPdfPages(pages, "まとめ"));
  assert.match(text, /\/Count 3/);
  assert.match(text, /\/Kids \[3 0 R 6 0 R 9 0 R\]/);
  assert.equal([...text.matchAll(/\/Type \/Page /g)].length, 3);
  assert.match(text, /\/MediaBox \[0 0 1190\.55 841\.89\]/); // A3横
  assert.match(text, /\/MediaBox \[0 0 595\.28 841\.89\]/); // A4縦
  assert.match(text, /\/Info 12 0 R/);
  const xref = /xref\n0 (\d+)\n/.exec(text);
  assert.equal(Number(xref[1]), 13); // 1+Catalog+Pages+3*3+Info
  assert.throws(() => makeJpegPdfPages([], ""), /ページがありません/);
  assert.throws(() => makeJpegPdfPages([{ ...pages[0], jpeg: new Uint8Array([1, 2, 3, 4]) }], ""), /JPEG/);
  // 1ページ版は、従来どおり
  assert.match(new TextDecoder("latin1").decode(makeJpegPdf({ ...pages[0], title: "x" })), /\/Count 1/);
});
