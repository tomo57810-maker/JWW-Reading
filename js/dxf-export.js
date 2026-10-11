// 編集した図形を、DXFファイルにする。
// 原本から作ったDXF(レイヤ・線種・文字スタイルの表つき。ezjwwが作る)の「図形の部分」だけを、編集後の図形に差し替える。
// 原本のJWWは変更しない。コメントや寸法などの注釈(図面とは別の書き込み)は、含まれない。

const MARK_BEGIN = "  0\nSECTION\n  2\nENTITIES\n";
const MARK_END = "  0\nENDSEC\n";

/** DXFの文字列(ASCII)にする。ASCII以外は、\U+XXXX の形に直す(DXFの決まり)。 */
export function dxfText(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c < 0x20 || c > 0x7e ? `\\U+${c.toString(16).toUpperCase().padStart(4, "0")}` : s[i];
  }
  return out;
}

const num = (n) => (Number.isFinite(n) ? Number(n).toFixed(9) : "0.000000000");

/** 図形(DXF相当の項目)を、DXFの1図形ぶんの文字列にする。扱えない種類は null、書くものがなければ ""。 */
function entityText(e, handle, ctx) {
  const layer = ctx.layers.has(e.layer) ? e.layer : "0";
  const lt = ctx.linetypes.has(e.line_type) ? e.line_type : "CONTINUOUS";
  const color = Number.isInteger(e.color) && e.color >= 0 && e.color <= 256 ? e.color : 256;
  const g = [];
  const add = (code, value) => g.push(`${String(code).padStart(3, " ")}\n${value}`);
  const head = (type) => {
    add(0, type);
    add(5, handle.toString(16).toUpperCase());
    add(330, 1);
    add(8, dxfText(layer));
    add(62, color);
    add(6, lt);
  };
  const pt = (c, x, y) => {
    add(10 + c, num(x));
    add(20 + c, num(y));
    add(30 + c, num(0));
  };
  switch (e.type) {
    case "LINE":
      head("LINE");
      pt(0, e.x1, e.y1);
      pt(1, e.x2, e.y2);
      break;
    case "CIRCLE":
      head("CIRCLE");
      pt(0, e.center_x, e.center_y);
      add(40, num(e.radius));
      break;
    case "ARC":
      head("ARC");
      pt(0, e.center_x, e.center_y);
      add(40, num(e.radius));
      add(50, num(e.start_angle));
      add(51, num(e.end_angle));
      break;
    case "SOLID":
      head("SOLID");
      pt(0, e.x1, e.y1);
      pt(1, e.x2, e.y2);
      pt(2, e.x3, e.y3);
      pt(3, e.x4, e.y4);
      break;
    case "POINT":
      head("POINT");
      pt(0, e.x, e.y);
      break;
    case "TEXT":
      if (!e.content) return ""; // 空の文字は、書くものがない
      head("TEXT");
      pt(0, e.x, e.y);
      add(40, num(e.height));
      add(41, num(e.width_factor ?? 1));
      add(1, dxfText(e.content));
      add(50, num(e.rotation ?? 0));
      add(7, ctx.styles.has(e.style) ? dxfText(e.style) : "STANDARD");
      break;
    default:
      return null;
  }
  return g.join("\n") + "\n";
}

const names = (text, re) => new Set([...text.matchAll(re)].map((m) => m[1].trim()));

/**
 * baseDxf: 原本から作ったDXF(文字列)、entities: 編集後の図形の並び(消した図形は null)。
 * 戻り値: { text, count(書いた図形数), skipped(扱えず書かなかった図形数) }
 */
export function buildDxf(baseDxf, entities) {
  const a = baseDxf.indexOf(MARK_BEGIN);
  if (a < 0) throw new Error("原本のDXFに、図形の部分が見つかりません");
  const bodyStart = a + MARK_BEGIN.length;
  const b = baseDxf.indexOf(MARK_END, bodyStart);
  if (b < 0) throw new Error("原本のDXFの形式が想定と違います");
  const before = baseDxf.slice(0, bodyStart);
  const after = baseDxf.slice(b);
  const rest = before + after; // 図形の部分を除いた、表・ブロックなど
  // 表にある名前(レイヤ・線種・文字スタイル)を調べ、無い名前を書かないようにする
  const section = (name) => {
    const i = rest.indexOf(`  2\n${name}\n`);
    return i < 0 ? "" : rest.slice(i, rest.indexOf("  0\nENDTAB\n", i));
  };
  const ctx = {
    layers: names(section("LAYER"), /\n {2}0\nLAYER\n[\s\S]*?\n {2}2\n(.*)(?=\n)/g),
    linetypes: names(section("LTYPE"), /\n {2}0\nLTYPE\n[\s\S]*?\n {2}2\n(.*)(?=\n)/g),
    styles: names(section("STYLE"), /\n {2}0\nSTYLE\n[\s\S]*?\n {2}2\n(.*)(?=\n)/g),
  };
  // 表の名前はエスケープ済みの形。図形のレイヤ名も同じ形にして照合する
  const escapedLayers = ctx.layers;
  ctx.layers = { has: (n) => escapedLayers.has(dxfText(n ?? "")) };
  if (ctx.styles.size === 0) ctx.styles.add("STANDARD");
  let handle = 1;
  for (const m of rest.matchAll(/\n {2}5\n([0-9A-Fa-f]+)\n/g)) handle = Math.max(handle, parseInt(m[1], 16) + 1);
  const parts = [];
  let count = 0;
  let skipped = 0;
  for (const e of entities) {
    if (!e) continue;
    const t = entityText(e, handle, ctx);
    if (t === null) {
      skipped += 1;
      continue;
    }
    if (t === "") continue;
    parts.push(t);
    handle += 1;
    count += 1;
  }
  return { text: before + parts.join("") + after, count, skipped };
}
