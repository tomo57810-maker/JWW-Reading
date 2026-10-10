// AutoCAD Color Index (ACI) → RGB。ezjwwはJWWの色をACI番号で返す。
const BASE = [
  [0, 0, 0], [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255],
  [0, 0, 255], [255, 0, 255], [255, 255, 255], [128, 128, 128], [192, 192, 192],
];
const GRAYS = [51, 91, 132, 173, 214, 255];
// AutoCADの表と同じく、明るさは最大値 255/165/127/76/38、彩度50%は最小値=最大値の半分(切り捨て)
const MAXES = [255, 165, 127, 76, 38];

function hue(h, max, min) {
  const f = (h % 60) / 60;
  const up = Math.floor(min + (max - min) * f);
  const down = Math.floor(max - (max - min) * f);
  const sector = Math.floor(h / 60);
  return [
    [max, up, min], [down, max, min], [min, max, up],
    [min, down, max], [up, min, max], [max, min, down],
  ][sector];
}

const TABLE = [];
for (let i = 0; i < 256; i++) {
  if (i < 10) TABLE.push(BASE[i]);
  else if (i < 250) {
    const block = Math.floor((i - 10) / 10);
    const k = (i - 10) % 10;
    const max = MAXES[k >> 1];
    TABLE.push(hue(block * 15, max, k % 2 === 0 ? 0 : Math.floor(max / 2)));
  } else TABLE.push([GRAYS[i - 250], GRAYS[i - 250], GRAYS[i - 250]]);
}

/** ACI番号をCSS色に変換する。白(7)/黒(0)は背景に合わせて反転する。 */
export function aciToCss(aci, darkBackground) {
  const n = Number.isInteger(aci) && aci >= 0 && aci < 256 ? aci : 7;
  if (n === 7 || n === 0) return darkBackground ? "#ffffff" : "#000000";
  const [r, g, b] = TABLE[n];
  return `rgb(${r},${g},${b})`;
}
