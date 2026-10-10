// 測定のための計算(用紙mm単位)。実寸への換算は、縮尺(分母)をかける。

export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** 折れ線の全長。 */
export function polylineLength(points) {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += distance(points[i - 1], points[i]);
  return sum;
}

/** 多角形の面積(靴ひも公式)。頂点は順番に並んでいればよく、閉じる点は自動で補う。 */
export function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** 用紙mmの長さを、縮尺(分母)をかけて実寸mmにする。 */
export function realLength(paperMm, scale) {
  return paperMm * scale;
}

/** 用紙mm²の面積を、縮尺(分母)の2乗をかけて実寸mm²にする。 */
export function realArea(paperMm2, scale) {
  return paperMm2 * scale * scale;
}

/** 実寸mmの長さを、読みやすい文字にする。例: 1234 → "1.234 m"、850 → "850 mm" */
export function formatLength(mm) {
  if (!Number.isFinite(mm)) return "";
  if (Math.abs(mm) >= 1000) return `${(mm / 1000).toFixed(mm >= 100000 ? 1 : 3).replace(/\.?0+$/, "")} m`;
  return `${Math.round(mm)} mm`;
}

/** 実寸mm²の面積を、m²の文字にする。 */
export function formatArea(mm2) {
  if (!Number.isFinite(mm2)) return "";
  const m2 = mm2 / 1e6;
  return `${m2 >= 100 ? m2.toFixed(1) : m2.toFixed(2)} m²`;
}

/** 点pから線分abまでの距離。 */
export function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/**
 * 図形の、吸着できる点(端点・中点・中心・四半点)。
 * kind: "end"(端点) / "mid"(中点) / "center"(中心) / "quad"(四半点) / "point"(点)
 */
export function snapPointsOfEntity(e) {
  const out = [];
  const add = (x, y, kind) => {
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y, kind });
  };
  switch (e.type) {
    case "LINE":
      add(e.x1, e.y1, "end");
      add(e.x2, e.y2, "end");
      add((e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2, "mid");
      break;
    case "ARC": {
      const rad = (d) => (d * Math.PI) / 180;
      const at = (a) => [e.center_x + e.radius * Math.cos(rad(a)), e.center_y + e.radius * Math.sin(rad(a))];
      add(...at(e.start_angle), "end");
      add(...at(e.end_angle), "end");
      const span = (((e.end_angle - e.start_angle) % 360) + 360) % 360;
      add(...at(e.start_angle + span / 2), "mid");
      add(e.center_x, e.center_y, "center");
      break;
    }
    case "CIRCLE":
      add(e.center_x, e.center_y, "center");
      add(e.center_x + e.radius, e.center_y, "quad");
      add(e.center_x - e.radius, e.center_y, "quad");
      add(e.center_x, e.center_y + e.radius, "quad");
      add(e.center_x, e.center_y - e.radius, "quad");
      break;
    case "POINT": add(e.x, e.y, "point"); break;
    case "SOLID":
      add(e.x1, e.y1, "end");
      add(e.x2, e.y2, "end");
      add(e.x3, e.y3, "end");
      add(e.x4, e.y4, "end");
      break;
    default: break;
  }
  return out;
}

/**
 * 図面の端点・中点・中心点を格子に入れておき、タップした位置に近い点へ吸着させる(寸法や移動を正確にするため)。
 * 点には、元の図形の番号(idx)を付けておき、選択中の図形(動かす側)を吸着の対象から外せるようにする。
 */
export class SnapIndex {
  constructor(entities, cell = 5) {
    this.cell = cell;
    this.grid = new Map();
    this.marks = []; // ユーザーが打った基準点(数が少ないので、並べて持つ)
    entities.forEach((e, idx) => {
      if (!e) return;
      for (const p of snapPointsOfEntity(e)) this.#add(p.x, p.y, p.kind, idx);
    });
  }

  #add(x, y, kind, idx) {
    const key = `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
    let bucket = this.grid.get(key);
    if (!bucket) this.grid.set(key, (bucket = []));
    bucket.push({ x, y, kind, idx });
  }

  /** 基準点(注釈の「点」)を差し替える。 */
  setMarks(points) {
    this.marks = points.map((p) => ({ x: p.x, y: p.y, kind: "mark", idx: -1 }));
  }

  /**
   * 半径radius(用紙mm)以内で、いちばん近い点を返す。なければnull。
   * @param {{ exclude?: Set<number> }} [opts] exclude: 対象から外す図形の番号
   */
  nearest(p, radius, { exclude = null } = {}) {
    const c = this.cell;
    const x0 = Math.floor((p.x - radius) / c), x1 = Math.floor((p.x + radius) / c);
    const y0 = Math.floor((p.y - radius) / c), y1 = Math.floor((p.y + radius) / c);
    let best = null;
    let bestD = radius;
    const consider = (q) => {
      if (exclude && exclude.has(q.idx)) return;
      const d = distance(p, q);
      if (d < bestD || (d === bestD && best && q.kind === "mark")) { best = q; bestD = d; }
    };
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const bucket = this.grid.get(`${gx},${gy}`);
        if (bucket) for (const q of bucket) consider(q);
      }
    }
    for (const m of this.marks) consider(m);
    return best;
  }
}
