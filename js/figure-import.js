// 別のファイル(トイレなどの図形)の図形を、開いている図面へ取り込むときの、位置・大きさ・レイヤの整え方。
import { boundsOf } from "./drawing.js";
import { transformEntity } from "./edits.js";

/** 編集機能が扱える図形の種類(それ以外は、取り込めない)。 */
const SUPPORTED = new Set(["LINE", "CIRCLE", "ARC", "SOLID", "POINT", "TEXT"]);

/**
 * 取り込む図形を整える。元の図形は変えない。
 * @param entities 取り込み元の図形の並び(nullを含んでよい)
 * @param opts.target 置く位置(用紙mm。図形の中心がここに来る)
 * @param opts.factor 倍率(1=そのままの大きさ)
 * @param opts.layer 入れ先のレイヤ名(取り込み元のレイヤ名は、開いている図面にはないので、使わない)
 * @returns {{ entities, skipped, bounds }} bounds は、置いたあとの範囲。取り込める図形がなければ entities は空
 */
export function prepareFigure(entities, { target, factor = 1, layer }) {
  const usable = [];
  let skipped = 0;
  for (const e of entities) {
    if (!e) continue;
    if (SUPPORTED.has(e.type)) usable.push(e);
    else skipped += 1;
  }
  const b = boundsOf(usable);
  if (!b || !(factor > 0)) return { entities: [], skipped, bounds: null };
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const xf = { cx, cy, dx: target.x - cx, dy: target.y - cy, theta: 0, s: factor };
  const out = usable.map((e) => {
    const t = transformEntity(e, xf);
    if (layer !== undefined) t.layer = layer;
    return t;
  });
  return { entities: out, skipped, bounds: boundsOf(out) };
}
