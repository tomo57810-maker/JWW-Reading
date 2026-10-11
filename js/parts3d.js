// 平面図の図形(線・円弧・円)を、3Dの部品にする。
// 部品は「どの図形を」「どの高さで」だけを持ち、形は、いまの図形(移動・編集後)から、そのつど作る。原本のJWWは変わらない。
//   壁・躯体: 線を、高さぶん押し出す(厚みを指定すると、箱になる)。円は円柱。
//   配管: 線を、円筒にする(中心の高さと外径を指定)。円は、その位置の立上り管。

export const PART_KINDS = { wall: "壁・躯体", pipe: "配管" };
const ARC_STEP_DEG = 10; // 円弧を、この角度ごとの直線に分ける

export class PartStore {
  constructor(onChange = () => {}) {
    this.list = [];
    this.onChange = onChange;
    this.onAdd = () => {};
  }

  #id() {
    return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  }

  add(part) {
    const p = { ...part, id: this.#id() };
    this.list.push(p);
    this.onAdd(p);
    this.onChange();
    return p;
  }

  remove(id) {
    const n = this.list.length;
    this.list = this.list.filter((p) => p.id !== id);
    if (this.list.length !== n) this.onChange();
    return this.list.length !== n;
  }

  /** 最後に足した部品を取り消す。 */
  undo() {
    if (this.list.length === 0) return false;
    this.list.pop();
    this.onChange();
    return true;
  }

  toJSON(baseCount) {
    return { baseCount, items: this.list };
  }

  /** 保存データを読み込む。図形の数が違うと、番号がずれるので読み込まない。 */
  load(data, baseCount) {
    this.list = [];
    if (!data || !Array.isArray(data.items) || data.items.length === 0) {
      this.onChange();
      return { ok: true, count: 0 };
    }
    if (data.baseCount !== baseCount) {
      this.onChange();
      return { ok: false, reason: "図形の数が一致しません" };
    }
    this.list = data.items.filter(isValidPart);
    this.onChange();
    return { ok: true, count: this.list.length };
  }
}

export function isValidPart(p) {
  return Boolean(
    p && typeof p.id === "string" && Object.hasOwn(PART_KINDS, p.kind) && Array.isArray(p.ids) && p.ids.every(Number.isInteger) &&
      Number.isFinite(p.z0) && (p.h === undefined || Number.isFinite(p.h)) && (p.dia === undefined || Number.isFinite(p.dia)) && (p.thick === undefined || Number.isFinite(p.thick))
  );
}

/** 3Dにできる図形か(線・円弧・円)。 */
export const isPartSource = (e) => Boolean(e) && (e.type === "LINE" || e.type === "ARC" || e.type === "CIRCLE");

/** 円弧を、折れ線(点の列)にする。 */
function arcPoints(e) {
  let a0 = e.start_angle;
  let a1 = e.end_angle;
  while (a1 <= a0) a1 += 360;
  const n = Math.max(2, Math.ceil((a1 - a0) / ARC_STEP_DEG));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    pts.push([e.center_x + e.radius * Math.cos(t), e.center_y + e.radius * Math.sin(t)]);
  }
  return pts;
}

/** 線と円弧を、直線の部分(用紙mm)の並びにする。円は含めない。 */
export function segmentsOf(e) {
  if (e.type === "LINE") return [[e.x1, e.y1, e.x2, e.y2]];
  if (e.type === "ARC") {
    const p = arcPoints(e);
    return p.slice(1).map((q, i) => [p[i][0], p[i][1], q[0], q[1]]);
  }
  return [];
}

/**
 * 部品から、3Dの形を作る。座標はメートル、Yが上(高さ)、Zは、平面図の下向き(平面図のYの逆)。
 * scale: 縮尺の分母(用紙mm → 実寸mm)。 entities: 編集後の図形(消した図形は null)。
 * 戻り値: { quads: [{c: [[x,y,z]×4], color, part}], cyls: [{a, b, r, color, part}], spheres: [{c, r, color, part}] }
 */
export function buildScene(parts, entities, { scale = 100 } = {}) {
  const s = scale / 1000; // 用紙mm → 実寸m
  const P = (x, y, zmm) => [x * s, zmm / 1000, -y * s];
  const out = { quads: [], cyls: [], spheres: [] };
  for (const part of parts) {
    const color = part.color ?? 7;
    const meta = { color, part: part.id, kind: part.kind };
    const sources = part.ids.map((i) => entities[i]).filter(isPartSource);
    if (part.kind === "wall") {
      const z0 = part.z0;
      const z1 = part.z0 + (part.h ?? 2700);
      const half = (part.thick ?? 0) > 0 ? part.thick / scale / 2 : 0; // 厚みの半分(用紙mm)
      for (const e of sources) {
        if (e.type === "CIRCLE") {
          out.cyls.push({ a: P(e.center_x, e.center_y, z0), b: P(e.center_x, e.center_y, z1), r: e.radius * s, cap: true, ...meta });
          continue;
        }
        for (const [x1, y1, x2, y2] of segmentsOf(e)) {
          const len = Math.hypot(x2 - x1, y2 - y1);
          if (len === 0) continue;
          if (half === 0) {
            out.quads.push({ c: [P(x1, y1, z0), P(x2, y2, z0), P(x2, y2, z1), P(x1, y1, z1)], ...meta });
            continue;
          }
          const nx = (-(y2 - y1) / len) * half;
          const ny = ((x2 - x1) / len) * half;
          const b = [[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]];
          const lo = b.map(([x, y]) => P(x, y, z0));
          const hi = b.map(([x, y]) => P(x, y, z1));
          for (let k = 0; k < 4; k++) out.quads.push({ c: [lo[k], lo[(k + 1) % 4], hi[(k + 1) % 4], hi[k]], ...meta });
          out.quads.push({ c: hi, ...meta }, { c: lo, ...meta });
        }
      }
    } else {
      const r = (part.dia ?? 50) / 2 / 1000;
      const seen = new Set();
      const joint = (x, y, z) => {
        const key = `${x.toFixed(3)},${y.toFixed(3)},${z}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.spheres.push({ c: P(x, y, z), r, ...meta });
      };
      for (const e of sources) {
        if (e.type === "CIRCLE") {
          // 平面図の円は、その位置の立上り管(中心の高さから、立上りの長さぶん)
          out.cyls.push({ a: P(e.center_x, e.center_y, part.z0), b: P(e.center_x, e.center_y, part.z0 + (part.h ?? 1000)), r, cap: false, ...meta });
          joint(e.center_x, e.center_y, part.z0);
          joint(e.center_x, e.center_y, part.z0 + (part.h ?? 1000));
          continue;
        }
        for (const [x1, y1, x2, y2] of segmentsOf(e)) {
          if (x1 === x2 && y1 === y2) continue;
          out.cyls.push({ a: P(x1, y1, part.z0), b: P(x2, y2, part.z0), r, cap: false, ...meta });
          joint(x1, y1, part.z0);
          joint(x2, y2, part.z0);
        }
      }
    }
  }
  return out;
}

/** 部品が、いまの図形のどれにも対応しなくなったか(すべて消した、など)。 */
export function isEmptyPart(part, entities) {
  return !part.ids.some((i) => isPartSource(entities[i]));
}

/** 部品の説明(一覧に出す文)。 */
export function describePart(part) {
  const n = part.ids.length;
  if (part.kind === "wall") return `${part.label || "壁・躯体"}: ${n}図形、下端${part.z0}mm・高さ${part.h}mm${part.thick > 0 ? `・厚み${part.thick}mm` : ""}`;
  return `${part.label || "配管"}: ${n}図形、中心高さ${part.z0}mm・外径${part.dia}mm`;
}
