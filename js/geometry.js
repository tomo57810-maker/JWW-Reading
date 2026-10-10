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
 * 図面の端点・中心点を格子に入れておき、タップした位置に近い点へ吸着させる(寸法を正確に取るため)。
 */
export class SnapIndex {
  constructor(entities, cell = 5) {
    this.cell = cell;
    this.grid = new Map();
    const add = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
      let bucket = this.grid.get(key);
      if (!bucket) this.grid.set(key, (bucket = []));
      bucket.push({ x, y });
    };
    for (const e of entities) {
      switch (e.type) {
        case "LINE": add(e.x1, e.y1); add(e.x2, e.y2); break;
        case "ARC":
        case "CIRCLE": add(e.center_x, e.center_y); break;
        case "POINT": add(e.x, e.y); break;
        case "SOLID": add(e.x1, e.y1); add(e.x2, e.y2); add(e.x3, e.y3); add(e.x4, e.y4); break;
        default: break;
      }
    }
  }

  /** 半径radius(用紙mm)以内で、いちばん近い点を返す。なければnull。 */
  nearest(p, radius) {
    const c = this.cell;
    const x0 = Math.floor((p.x - radius) / c), x1 = Math.floor((p.x + radius) / c);
    const y0 = Math.floor((p.y - radius) / c), y1 = Math.floor((p.y + radius) / c);
    let best = null;
    let bestD = radius;
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const bucket = this.grid.get(`${gx},${gy}`);
        if (!bucket) continue;
        for (const q of bucket) {
          const d = distance(p, q);
          if (d <= bestD) { best = q; bestD = d; }
        }
      }
    }
    return best;
  }
}
