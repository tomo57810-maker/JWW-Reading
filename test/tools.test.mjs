import { test } from "node:test";
import assert from "node:assert/strict";
import { distance, polylineLength, polygonArea, realLength, realArea, formatLength, formatArea, distanceToSegment, SnapIndex } from "../js/geometry.js";
import { AnnotationStore, isValidItem, hitTest, fingerprintOf, storageKey, centroid } from "../js/annotations.js";
import { makeJpegPdf } from "../js/pdf.js";

test("距離・折れ線の長さ・面積", () => {
  assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }]), 11);
  assert.equal(polygonArea([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }]), 50);
  // 三角形(頂点の回り方が逆でも、面積は正)
  assert.equal(polygonArea([{ x: 0, y: 0 }, { x: 0, y: 6 }, { x: 4, y: 0 }]), 12);
});

test("縮尺: 用紙の長さに分母、面積に分母の2乗をかける", () => {
  // 用紙上の10 mm は、1/100 なら実寸 1000 mm = 1 m
  assert.equal(realLength(10, 100), 1000);
  assert.equal(formatLength(realLength(10, 100)), "1 m");
  // 用紙上の 10 mm × 5 mm = 50 mm² は、1/100 なら実寸 0.5 m²
  assert.equal(formatArea(realArea(50, 100)), "0.50 m²");
  assert.equal(formatLength(850), "850 mm");
  assert.equal(formatLength(1234), "1.234 m");
});

test("線分までの距離", () => {
  assert.equal(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  assert.equal(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5); // 端の外側は、端点までの距離
});

test("吸着: 近い端点・中心点に寄せる。遠ければ null", () => {
  const idx = new SnapIndex([
    { type: "LINE", x1: 0, y1: 0, x2: 100, y2: 0 },
    { type: "CIRCLE", center_x: 50, center_y: 50, radius: 3 },
  ]);
  const xy = (q) => q && { x: q.x, y: q.y, kind: q.kind };
  assert.deepEqual(xy(idx.nearest({ x: 1, y: 1 }, 3)), { x: 0, y: 0, kind: "end" });
  assert.deepEqual(xy(idx.nearest({ x: 99, y: -1 }, 3)), { x: 100, y: 0, kind: "end" });
  assert.deepEqual(xy(idx.nearest({ x: 51, y: 49 }, 3)), { x: 50, y: 50, kind: "center" });
  assert.equal(idx.nearest({ x: 30, y: 30 }, 3), null);
  // 線の中点にも吸着する
  assert.deepEqual(xy(idx.nearest({ x: 49, y: 1 }, 3)), { x: 50, y: 0, kind: "mid" });
  // 選択中の図形(番号0)を対象から外すと、その点には吸着しない
  assert.equal(idx.nearest({ x: 1, y: 1 }, 3, { exclude: new Set([0]) }), null);
  // 基準点は、図形の点より優先され、どの図形にも属さない
  idx.setMarks([{ x: 10, y: 10 }]);
  assert.deepEqual(xy(idx.nearest({ x: 9, y: 9 }, 3, { exclude: new Set([0, 1]) })), { x: 10, y: 10, kind: "mark" });
});

test("注釈: 追加・取り消し・全消去・不正な項目の拒否", () => {
  let changes = 0;
  const s = new AnnotationStore(() => changes++);
  const d = s.add({ kind: "dim", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], scale: 100 });
  s.add({ kind: "text", at: { x: 1, y: 1 }, text: "バルブ追加" });
  assert.equal(s.items.length, 2);
  assert.equal(s.undo(), true); // 直前(コメントの追加)が取り消される
  assert.equal(s.items.length, 1);
  s.remove(d.id);
  assert.equal(s.items.length, 0);
  assert.equal(s.undo(), true); // 削除も取り消せる(寸法が戻る)
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].id, d.id);
  assert.throws(() => s.add({ kind: "dim", points: [{ x: 0, y: 0 }] }));
  assert.throws(() => s.add({ kind: "unknown" }));
  assert.ok(changes >= 3);
});

test("注釈: JSONの保存と読み込み(壊れた項目は読み飛ばす)", () => {
  const a = new AnnotationStore();
  a.settings.scale = 50;
  a.add({ kind: "area", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], scale: 50 });
  const json = JSON.parse(JSON.stringify(a.toJSON({ name: "x.jww", size: 1, sha256: "ab" })));
  json.items.push({ id: "bad", kind: "dim", points: [] });
  const b = new AnnotationStore();
  b.load(json);
  assert.equal(b.items.length, 1);
  assert.equal(b.settings.scale, 50);
  assert.equal(isValidItem(b.items[0]), true);
});

test("消す: いちばん近い注釈を選ぶ。面積は内側でも選べる", () => {
  const items = [
    { id: "1", kind: "dim", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    { id: "2", kind: "area", points: [{ x: 20, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 20, y: 10 }] },
    { id: "3", kind: "text", at: { x: 50, y: 50 }, text: "a" },
  ];
  assert.equal(hitTest(items, { x: 5, y: 1 }, 2).id, "1");
  assert.equal(hitTest(items, { x: 25, y: 5 }, 0.5).id, "2");
  assert.equal(hitTest(items, { x: 50.5, y: 50 }, 2).id, "3");
  assert.equal(hitTest(items, { x: 100, y: 100 }, 2), null);
  assert.deepEqual(centroid([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]), { x: 2, y: 2 });
});

test("指紋: 同じ内容なら同じ、違えば別。保存キーに使う", async () => {
  const a = await fingerprintOf("a.jww", new Uint8Array([1, 2, 3]));
  const b = await fingerprintOf("b.jww", new Uint8Array([1, 2, 3]));
  const c = await fingerprintOf("a.jww", new Uint8Array([1, 2, 4]));
  assert.equal(storageKey(a), storageKey(b)); // 名前を変えても、中身が同じなら同じ図面
  assert.notEqual(storageKey(a), storageKey(c));
  assert.match(storageKey(a), /^sha256:[0-9a-f]{64}$/);
});

test("PDF: JPEG以外は拒否し、1ページのPDFの骨組みを作る", () => {
  assert.throws(() => makeJpegPdf({ jpeg: new Uint8Array([1, 2, 3, 4]), widthPx: 1, heightPx: 1, pageWidthMm: 10, pageHeightMm: 10 }));
  const pdf = makeJpegPdf({ jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), widthPx: 10, heightPx: 5, pageWidthMm: 420, pageHeightMm: 297, title: "図面" });
  const text = new TextDecoder("latin1").decode(pdf);
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.match(text, /\/MediaBox \[0 0 1190\.55 841\.89\]/); // A3 横
  assert.ok(text.trimEnd().endsWith("%%EOF"));
  // xrefの位置が、実際の "xref" の位置と一致する
  const startxref = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.equal(text.slice(startxref, startxref + 4), "xref");
});

test("注釈の「戻す」: 移動(touch)のように、checkpointを積んだ変更も戻る", () => {
  const s = new AnnotationStore();
  const a = s.add({ kind: "mark", at: { x: 1, y: 1 } });
  s.checkpoint(); // 移動の直前
  a.at = { x: 5, y: 5 };
  s.touch();
  assert.deepEqual(s.items[0].at, { x: 5, y: 5 });
  s.undo();
  assert.deepEqual(s.items[0].at, { x: 1, y: 1 });
  s.undo(); // 追加の取り消し
  assert.equal(s.items.length, 0);
  assert.equal(s.undo(), false);
});
