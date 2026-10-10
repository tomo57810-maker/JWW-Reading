// 図面の図形そのものの編集(移動・回転・拡大縮小・複製・削除)。
// 原本のJWWは書き換えず、「操作の記録」だけを保存して、表示のたびに原本の図形へ当てはめる(非破壊)。
//
// 変換は、相似変換(平行移動 + 回転 + 一様な拡大縮小)。基準点 c のまわりで、
//   p' = (c + d) + s・R(θ)・(p − c)
// d: 平行移動量 / θ: 回転角(ラジアン) / s: 倍率

const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export const IDENTITY = { cx: 0, cy: 0, dx: 0, dy: 0, theta: 0, s: 1 };

export function applyToPoint(xf, x, y) {
  const c = Math.cos(xf.theta);
  const sn = Math.sin(xf.theta);
  const px = (x - xf.cx) * xf.s;
  const py = (y - xf.cy) * xf.s;
  return { x: xf.cx + xf.dx + px * c - py * sn, y: xf.cy + xf.dy + px * sn + py * c };
}

const norm360 = (d) => ((d % 360) + 360) % 360;

/** 図形1つに相似変換をかけた、新しい図形を返す(元は変えない)。 */
export function transformEntity(e, xf) {
  const p = (x, y) => applyToPoint(xf, x, y);
  switch (e.type) {
    case "LINE": {
      const a = p(e.x1, e.y1);
      const b = p(e.x2, e.y2);
      return { ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }
    case "CIRCLE": {
      const c = p(e.center_x, e.center_y);
      return { ...e, center_x: c.x, center_y: c.y, radius: e.radius * xf.s };
    }
    case "ARC": {
      const c = p(e.center_x, e.center_y);
      const t = deg(xf.theta);
      return { ...e, center_x: c.x, center_y: c.y, radius: e.radius * xf.s, start_angle: norm360(e.start_angle + t), end_angle: norm360(e.end_angle + t) };
    }
    case "SOLID": {
      const a = p(e.x1, e.y1), b = p(e.x2, e.y2), c = p(e.x3, e.y3), d = p(e.x4, e.y4);
      return { ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y, x3: c.x, y3: c.y, x4: d.x, y4: d.y };
    }
    case "POINT": {
      const a = p(e.x, e.y);
      return { ...e, x: a.x, y: a.y };
    }
    case "TEXT": {
      const a = p(e.x, e.y);
      const b = p(e.end_x ?? e.x, e.end_y ?? e.y);
      return { ...e, x: a.x, y: a.y, end_x: b.x, end_y: b.y, height: e.height * xf.s, rotation: norm360((e.rotation ?? 0) + deg(xf.theta)) };
    }
    default:
      return e;
  }
}

/**
 * 伸縮(ストレッチ): 窓(四角)の中にある点だけを(dx, dy)動かす。
 * 線・立体は、窓に入っている端点だけが動く(窓の外の端点は動かない)ので、長さが変わる。
 * 円・円弧・文字・点は、中心(または基準点)が窓に入っていれば、まるごと動く。
 */
export function stretchEntity(e, win, dx, dy) {
  const inside = (x, y) => x >= win.x0 && x <= win.x1 && y >= win.y0 && y <= win.y1;
  switch (e.type) {
    case "LINE": {
      const a = inside(e.x1, e.y1);
      const b = inside(e.x2, e.y2);
      return a || b ? { ...e, x1: e.x1 + (a ? dx : 0), y1: e.y1 + (a ? dy : 0), x2: e.x2 + (b ? dx : 0), y2: e.y2 + (b ? dy : 0) } : e;
    }
    case "SOLID": {
      const out = { ...e };
      for (const k of [1, 2, 3, 4]) {
        if (inside(e[`x${k}`], e[`y${k}`])) {
          out[`x${k}`] = e[`x${k}`] + dx;
          out[`y${k}`] = e[`y${k}`] + dy;
        }
      }
      return out;
    }
    case "CIRCLE":
    case "ARC":
      return inside(e.center_x, e.center_y) ? { ...e, center_x: e.center_x + dx, center_y: e.center_y + dy } : e;
    case "POINT":
      return inside(e.x, e.y) ? { ...e, x: e.x + dx, y: e.y + dy } : e;
    case "TEXT":
      return inside(e.x, e.y) ? { ...e, x: e.x + dx, y: e.y + dy, end_x: (e.end_x ?? e.x) + dx, end_y: (e.end_y ?? e.y) + dy } : e;
    default:
      return e;
  }
}

/** 図形の外接する四角(用紙mm)。扱えない種類は null。 */
export function entityBounds(e) {
  switch (e.type) {
    case "LINE": return { x0: Math.min(e.x1, e.x2), y0: Math.min(e.y1, e.y2), x1: Math.max(e.x1, e.x2), y1: Math.max(e.y1, e.y2) };
    case "CIRCLE": return { x0: e.center_x - e.radius, y0: e.center_y - e.radius, x1: e.center_x + e.radius, y1: e.center_y + e.radius };
    case "ARC": {
      // 弧の両端と、弧が通る上下左右の端(0・90・180・270度)で囲む
      const pt = (a) => [e.center_x + e.radius * Math.cos(rad(a)), e.center_y + e.radius * Math.sin(rad(a))];
      const pts = [pt(e.start_angle), pt(e.end_angle)];
      for (const a of [0, 90, 180, 270]) if (angleIn(a, e.start_angle, e.end_angle)) pts.push(pt(a));
      return { x0: Math.min(...pts.map((q) => q[0])), y0: Math.min(...pts.map((q) => q[1])), x1: Math.max(...pts.map((q) => q[0])), y1: Math.max(...pts.map((q) => q[1])) };
    }
    case "SOLID": {
      const xs = [e.x1, e.x2, e.x3, e.x4];
      const ys = [e.y1, e.y2, e.y3, e.y4];
      return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    }
    case "POINT": return { x0: e.x, y0: e.y, x1: e.x, y1: e.y };
    case "TEXT": {
      // 文字は、始点から終点までの幅と、高さで囲む(回転も含めて、四隅の外接)
      const t = rad(e.rotation ?? 0);
      const w = Math.hypot((e.end_x ?? e.x) - e.x, (e.end_y ?? e.y) - e.y);
      const h = e.height ?? 0;
      const corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([u, v]) => [e.x + u * Math.cos(t) - v * Math.sin(t), e.y + u * Math.sin(t) + v * Math.cos(t)]);
      return { x0: Math.min(...corners.map((c) => c[0])), y0: Math.min(...corners.map((c) => c[1])), x1: Math.max(...corners.map((c) => c[0])), y1: Math.max(...corners.map((c) => c[1])) };
    }
    default: return null;
  }
}

export function unionBounds(list) {
  let b = null;
  for (const r of list) {
    if (!r) continue;
    b = b ? { x0: Math.min(b.x0, r.x0), y0: Math.min(b.y0, r.y0), x1: Math.max(b.x1, r.x1), y1: Math.max(b.y1, r.y1) } : { ...r };
  }
  return b;
}

const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
  return dist(px, py, x1 + t * dx, y1 + t * dy);
}

function angleIn(a, start, end) {
  const x = norm360(a - start);
  const span = norm360(end - start);
  return x <= (span === 0 ? 360 : span);
}

/** 点(px,py)から図形までの距離(用紙mm)。近さの比較に使う。扱えない種類は Infinity。 */
export function distanceToEntity(e, px, py) {
  switch (e.type) {
    case "LINE": return distToSeg(px, py, e.x1, e.y1, e.x2, e.y2);
    case "CIRCLE": return Math.abs(dist(px, py, e.center_x, e.center_y) - e.radius);
    case "ARC": {
      const a = deg(Math.atan2(py - e.center_y, px - e.center_x));
      if (angleIn(a, e.start_angle, e.end_angle)) return Math.abs(dist(px, py, e.center_x, e.center_y) - e.radius);
      const pt = (ang) => [e.center_x + e.radius * Math.cos(rad(ang)), e.center_y + e.radius * Math.sin(rad(ang))];
      const [sx, sy] = pt(e.start_angle);
      const [ex, ey] = pt(e.end_angle);
      return Math.min(dist(px, py, sx, sy), dist(px, py, ex, ey));
    }
    case "POINT": return dist(px, py, e.x, e.y);
    case "SOLID": {
      const pts = [[e.x1, e.y1], [e.x2, e.y2], [e.x4, e.y4], [e.x3, e.y3]];
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return 0;
      return Math.min(...pts.map((a, i) => { const b = pts[(i + 1) % 4]; return distToSeg(px, py, a[0], a[1], b[0], b[1]); }));
    }
    case "TEXT": {
      const b = entityBounds(e);
      if (!b) return Infinity;
      const dx = Math.max(b.x0 - px, 0, px - b.x1);
      const dy = Math.max(b.y0 - py, 0, py - b.y1);
      return Math.hypot(dx, dy);
    }
    default: return Infinity;
  }
}

/** 点に最も近い図形の番号(許容距離tol以内)。見えている図形だけを対象にする。 */
export function pickEntity(entities, px, py, tol, isVisible = () => true) {
  let best = -1;
  let bestD = tol;
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (!e || !isVisible(e)) continue;
    const b = entityBounds(e);
    if (!b || px < b.x0 - tol || px > b.x1 + tol || py < b.y0 - tol || py > b.y1 + tol) continue;
    const d = distanceToEntity(e, px, py);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/** 四角の中に完全に入っている図形の番号(Jw_cadの範囲選択と同じ)。 */
export function pickInRect(entities, rect, isVisible = () => true) {
  const x0 = Math.min(rect.x0, rect.x1), x1 = Math.max(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1), y1 = Math.max(rect.y0, rect.y1);
  const out = [];
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (!e || !isVisible(e)) continue;
    const b = entityBounds(e);
    if (b && b.x0 >= x0 && b.x1 <= x1 && b.y0 >= y0 && b.y1 <= y1) out.push(i);
  }
  return out;
}

/**
 * 編集の記録。原本の図形の並び(base)に、操作を順に当てはめた結果(entities)を作る。
 *   { type: "xform", ids: [...], xf }  図形を相似変換する
 *   { type: "stretch", ids: [...], win: {x0,y0,x1,y1}, dx, dy }  窓の中の点だけを動かす(伸縮)
 *   { type: "delete", ids: [...] }     図形を消す
 *   { type: "copy", ids: [...], xf, newIds: [...] }  変換した複製を、末尾に追加する
 */
export class EditStore {
  constructor(base, onChange = () => {}) {
    this.base = base;
    this.ops = [];
    this.entities = base.slice();
    this.onChange = onChange;
  }

  get baseCount() {
    return this.base.length;
  }

  #apply(op) {
    switch (op.type) {
      case "xform":
        for (const id of op.ids) if (this.entities[id]) this.entities[id] = transformEntity(this.entities[id], op.xf);
        break;
      case "stretch":
        for (const id of op.ids) if (this.entities[id]) this.entities[id] = stretchEntity(this.entities[id], op.win, op.dx, op.dy);
        break;
      case "delete":
        for (const id of op.ids) this.entities[id] = null;
        break;
      case "copy":
        op.newIds.forEach((nid, k) => {
          const src = this.entities[op.ids[k]];
          if (src) this.entities[nid] = transformEntity(src, op.xf);
        });
        break;
      default:
        break;
    }
  }

  add(op) {
    if (op.type === "copy") op = { ...op, newIds: op.ids.map((_, k) => this.entities.length + k) };
    this.ops.push(op);
    this.#apply(op);
    this.onChange(this);
    return op;
  }

  undo() {
    if (this.ops.length === 0) return null;
    const last = this.ops.pop();
    this.#replay();
    this.onChange(this);
    return last;
  }

  clear() {
    if (this.ops.length === 0) return;
    this.ops = [];
    this.#replay();
    this.onChange(this);
  }

  #replay() {
    this.entities = this.base.slice();
    for (const op of this.ops) this.#apply(op);
  }

  toJSON() {
    return { baseCount: this.base.length, ops: this.ops };
  }

  /** 保存データを読み込む。図形の数が違う(別の版で読んだ)ときは、番号がずれるので、読み込まない。 */
  load(data) {
    this.ops = [];
    this.entities = this.base.slice();
    if (!data || !Array.isArray(data.ops) || data.ops.length === 0) {
      this.onChange(this);
      return { ok: true, count: 0 };
    }
    if (data.baseCount !== this.base.length) {
      this.onChange(this);
      return { ok: false, reason: "図形の数が一致しません" };
    }
    for (const op of data.ops) {
      if (!["xform", "delete", "copy", "stretch"].includes(op?.type) || !Array.isArray(op.ids)) continue;
      if ((op.type === "xform" || op.type === "copy") && !(op.xf && Number.isFinite(op.xf.s) && Number.isFinite(op.xf.theta))) continue;
      if (op.type === "stretch" && !(op.win && [op.win.x0, op.win.y0, op.win.x1, op.win.y1, op.dx, op.dy].every(Number.isFinite))) continue;
      this.ops.push(op);
      this.#apply(op);
    }
    this.onChange(this);
    return { ok: true, count: this.ops.length };
  }
}
