// 図面に描き足す文字(TEXT図形)を作る。JWWの文字は「高さ」と「1文字の幅(全角)」で大きさが決まり、半角は全角の半分の幅になる。

export const DEFAULT_TEXT_ATTR = { height: 3, width_factor: 0.9, style: "STANDARD" };
const LINE_SPACING = 1.5; // 複数行のとき、行の間隔(文字の高さに対する倍率)

/** 半角の文字(ASCII・半角カナ)は、全角の半分の幅。 */
function isHalfWidth(ch) {
  const c = ch.codePointAt(0);
  return c <= 0x7e || (c >= 0xff61 && c <= 0xff9f);
}

/** 1行の文字の幅(用紙mm)。 */
export function textWidth(content, height, widthFactor) {
  let w = 0;
  for (const ch of content) w += isHalfWidth(ch) ? 0.5 : 1;
  return w * height * widthFactor;
}

/**
 * 入力された文字から、TEXT図形を作る。改行ごとに1つの図形にし、下の行は下へ並べる。
 * at は1行目の左下(用紙mm)。attr は { layer, color, height, width_factor, style }。
 */
export function makeTextEntities(content, at, attr, rotation = 0) {
  const a = { ...DEFAULT_TEXT_ATTR, ...attr };
  const t = (rotation * Math.PI) / 180;
  const ux = Math.cos(t), uy = Math.sin(t);
  const lines = String(content).split(/\r?\n/).map((s) => s.replace(/\s+$/, "")).filter((s) => s !== "");
  return lines.map((line, i) => {
    const w = textWidth(line, a.height, a.width_factor);
    const x = at.x + uy * a.height * LINE_SPACING * i; // 行送りは、文字の下向き(回転した向き)
    const y = at.y - ux * a.height * LINE_SPACING * i;
    return {
      type: "TEXT", layer: a.layer ?? "0", color: a.color ?? 7, line_type: "CONTINUOUS",
      x, y, end_x: x + ux * w, end_y: y + uy * w,
      height: a.height, width_factor: a.width_factor, rotation, content: line, style: a.style,
    };
  });
}
