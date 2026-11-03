// DXF(ASCII)を読み、ezjwwの readDrawing と同じ形({ layers, line_types, entities, blocks, unsupported_entities })にする。
// 座標は用紙mm・Y上向き。DXFの図面単位($INSUNITS)がmm以外なら、mmに直す。原本は変更しない。
import { textWidth } from "./text.js";

const UNIT_TO_MM = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 10: 914.4 }; // inch, feet, mm, cm, m, yard
const ARC_STEP = Math.PI / 18; // 楕円を折れ線にするときの角度の刻み(10度)
const MAX_DEPTH = 16; // ブロックの入れ子の上限

// DXFの標準線種名を、このアプリが破線にできる線種名へ寄せる
const LINETYPE_MAP = {
  DASHED: "JWW_DASHED2", DASHED2: "JWW_DASHED1", DASHEDX2: "JWW_DASHED3", HIDDEN: "JWW_DASHED1", HIDDEN2: "JWW_DASHED1", HIDDENX2: "JWW_DASHED3",
  DASHDOT: "JWW_DASHDOT1", DASHDOT2: "JWW_DASHDOT1", DASHDOTX2: "JWW_DASHDOT2", CENTER: "JWW_DASHDOT2", CENTER2: "JWW_DASHDOT1", CENTERX2: "JWW_DASHDOT2",
  PHANTOM: "JWW_DIVIDE1", PHANTOM2: "JWW_DIVIDE1", PHANTOMX2: "JWW_DIVIDE2", DIVIDE: "JWW_DIVIDE1", DIVIDE2: "JWW_DIVIDE1", DIVIDEX2: "JWW_DIVIDE2",
  DOT: "JWW_DASHED1", DOT2: "JWW_DASHED1", DOTX2: "JWW_DASHED2",
};

/** バイト列がDXFらしいか(ASCIIのDXFは、最初の組が「0 / SECTION」、またはコメント「999」)。 */
export function looksLikeDxf(bytes) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 256));
  if (head.startsWith("AutoCAD Binary DXF")) return true;
  return /^\s*(0|999)\s*\r?\n/.test(head) && /SECTION/.test(head);
}

/** バイナリ形式のDXFか。 */
export function isBinaryDxf(bytes) {
  return new TextDecoder("latin1").decode(bytes.subarray(0, 20)) === "AutoCAD Binary DXF\r\n";
}

/** DXFの文字コードを判定して文字列にする。UTF-8で読めなければ、日本語のDXFに多い Shift_JIS とみなす。 */
export function decodeDxf(bytes) {
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("shift_jis").decode(body);
  }
}

/** 文字内の DXF の書き方(\U+XXXX、%%c など)を、ふつうの文字にする。 */
export function cleanText(s) {
  return s
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%%[cC]/g, "Ø").replace(/%%[dD]/g, "°").replace(/%%[pP]/g, "±")
    .replace(/%%[uUoO]/g, "");
}

/** MTEXT の書式コード({\f…;}、\P、\~ など)を取り除く。 */
export function cleanMtext(s) {
  return cleanText(s)
    .replace(/\\\\/g, "\u0000").replace(/\\P/g, "\n").replace(/\\~/g, " ")
    .replace(/\\S([^;^/#]*)[\^/#]([^;]*);/g, "$1/$2")
    .replace(/\\[fFcCHWQTAa][^;]*;/g, "").replace(/\\[LlOoKk]/g, "")
    .replace(/[{}]/g, "").replace(/\u0000/g, "\\");
}

/** 「コード / 値」の組の並びにする。 */
function pairs(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    out.push([code, lines[i + 1]]);
  }
  return out;
}

/** 0 で区切って、{ type, g(組の並び) } の並びにする。 */
function records(arr) {
  const out = [];
  let cur = null;
  for (const p of arr) {
    if (p[0] === 0) {
      cur = { type: p[1].trim(), g: [] };
      out.push(cur);
    } else if (cur) cur.g.push(p);
  }
  return out;
}

/** 組の並びを { コード: [値…] } にする。 */
function bag(group) {
  const m = new Map();
  for (const [c, v] of group) {
    if (!m.has(c)) m.set(c, []);
    m.get(c).push(v);
  }
  return m;
}
const first = (m, c, d = undefined) => (m.has(c) ? m.get(c)[0] : d);
const numOf = (m, c, d = 0) => {
  const v = Number.parseFloat(first(m, c));
  return Number.isFinite(v) ? v : d;
};
const intOf = (m, c, d = 0) => {
  const v = Number.parseInt(first(m, c), 10);
  return Number.isNaN(v) ? d : v;
};

// ---- 2次元の変換(x' = a·x + c·y + e, y' = b·x + d·y + f) ----
const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
function placement(sx, sy, rotDeg, tx, ty) {
  const r = (rotDeg * Math.PI) / 180;
  const co = Math.cos(r), si = Math.sin(r);
  return { a: co * sx, b: si * sx, c: -si * sy, d: co * sy, e: tx, f: ty };
}
/** outer(inner(p)) */
function compose(o, i) {
  return {
    a: o.a * i.a + o.c * i.b, b: o.b * i.a + o.d * i.b,
    c: o.a * i.c + o.c * i.d, d: o.b * i.c + o.d * i.d,
    e: o.a * i.e + o.c * i.f + o.e, f: o.b * i.e + o.d * i.f + o.f,
  };
}
const pt = (t, x, y) => ({ x: t.a * x + t.c * y + t.e, y: t.b * x + t.d * y + t.f });
const dirDeg = (t, deg) => {
  const r = (deg * Math.PI) / 180;
  return (Math.atan2(t.b * Math.cos(r) + t.d * Math.sin(r), t.a * Math.cos(r) + t.c * Math.sin(r)) * 180) / Math.PI;
};
const norm360 = (a) => ((a % 360) + 360) % 360;
const scaleX = (t) => Math.hypot(t.a, t.b);
const det = (t) => t.a * t.d - t.b * t.c;

/** ふくらみ(bulge)つきの2点を、円弧の図形にする。ふくらみ0なら直線。 */
function segment(p, q, bulge, base) {
  if (!bulge) return [{ ...base, type: "LINE", x1: p.x, y1: p.y, x2: q.x, y2: q.y }];
  if (bulge < 0) return segment(q, p, -bulge, base); // 時計回りは、向きを逆にした反時計回りの円弧と同じ
  const theta = 4 * Math.atan(bulge);
  const dx = q.x - p.x, dy = q.y - p.y;
  const chord = Math.hypot(dx, dy);
  if (chord === 0) return [];
  const r = chord / (2 * Math.sin(theta / 2));
  const d = r * Math.cos(theta / 2); // 弦の中点から中心までの、左向きの距離(半円を超えると負)
  const cx = (p.x + q.x) / 2 + (-dy / chord) * d;
  const cy = (p.y + q.y) / 2 + (dx / chord) * d;
  const deg = (a) => norm360((a * 180) / Math.PI);
  return [{ ...base, type: "ARC", center_x: cx, center_y: cy, radius: r, start_angle: deg(Math.atan2(p.y - cy, p.x - cx)), end_angle: deg(Math.atan2(q.y - cy, q.x - cx)) }];
}

/**
 * DXFの文字列を読む。
 * @returns {{ layers, line_types, entities, blocks, unsupported_entities, unsupportedTypes, unitScale }}
 */
export function readDxfDrawing(text) {
  const all = pairs(text);
  const sections = new Map();
  for (let i = 0; i < all.length; i++) {
    if (all[i][0] === 0 && all[i][1].trim() === "SECTION" && all[i + 1]?.[0] === 2) {
      const name = all[i + 1][1].trim();
      let j = i + 2;
      while (j < all.length && !(all[j][0] === 0 && all[j][1].trim() === "ENDSEC")) j++;
      sections.set(name, all.slice(i + 2, j));
      i = j;
    }
  }
  if (!sections.has("ENTITIES") && !sections.has("BLOCKS")) throw new Error("DXFの図形の部分が見つかりません(ASCII形式のDXFではない可能性があります)");

  // 図面の単位
  let unitScale = 1;
  const header = sections.get("HEADER") ?? [];
  const hi = header.findIndex(([c, v]) => c === 9 && v.trim() === "$INSUNITS");
  if (hi >= 0) unitScale = UNIT_TO_MM[Number.parseInt(header[hi + 1]?.[1], 10)] ?? 1;

  // レイヤ・線種の表
  const layers = [];
  const layerInfo = new Map();
  const lineTypes = [];
  for (const rec of records(sections.get("TABLES") ?? [])) {
    const m = bag(rec.g);
    const name = (first(m, 2, "") ?? "").trim();
    if (rec.type === "LAYER" && name) {
      const c = intOf(m, 62, 7);
      const flags = intOf(m, 70, 0);
      const info = { name, color: Math.abs(c) || 7, line_type: (first(m, 6, "CONTINUOUS") ?? "CONTINUOUS").trim(), frozen: Boolean(flags & 1) || c < 0, locked: Boolean(flags & 4) };
      layerInfo.set(name, info);
      layers.push({ name, color: info.color, line_type: info.line_type, frozen: info.frozen, locked: info.locked });
    } else if (rec.type === "LTYPE" && name) lineTypes.push({ name });
  }

  // ブロック(BLOCK … ENDBLK の間の図形)
  const blocks = new Map();
  {
    let cur = null;
    for (const rec of records(sections.get("BLOCKS") ?? [])) {
      if (rec.type === "BLOCK") {
        const m = bag(rec.g);
        cur = { name: (first(m, 2, "") ?? "").trim(), base: { x: numOf(m, 10), y: numOf(m, 20) }, recs: [] };
        blocks.set(cur.name, cur);
      } else if (rec.type === "ENDBLK") cur = null;
      else if (cur) cur.recs.push(rec);
    }
  }

  const entities = [];
  const unsupported = [];
  const unsupportedTypes = new Set();
  const noteUnsupported = (type) => {
    unsupported.push({ type });
    unsupportedTypes.add(type);
  };

  const layerColor = (layer) => layerInfo.get(layer)?.color ?? 7;
  const lineTypeName = (name) => {
    const n = String(name ?? "").trim().toUpperCase();
    return LINETYPE_MAP[n] ?? "CONTINUOUS";
  };

  /** 図形の共通の項目(レイヤ・色・線種・線の太さ)。色と線種が「レイヤ指定」なら、レイヤの値にする。ブロック内の「ブロック指定」は、挿入した図形の値にする。 */
  function baseOf(m, inherit) {
    const layer = (first(m, 8, "0") ?? "0").trim() || "0";
    const c = intOf(m, 62, 256);
    const byLayerColor = c === 256 || Number.isNaN(c);
    const byBlockColor = c === 0;
    const color = byBlockColor && inherit ? inherit.color : byLayerColor || byBlockColor ? layerColor(layer) : Math.abs(c);
    const ltRaw = (first(m, 6) ?? "BYLAYER").trim().toUpperCase();
    const line_type = ltRaw === "BYBLOCK" && inherit ? inherit.line_type : ltRaw === "BYLAYER" || ltRaw === "BYBLOCK" ? lineTypeName(layerInfo.get(layer)?.line_type) : lineTypeName(ltRaw);
    const out = { layer: inherit && layer === "0" ? inherit.layer : layer, color, line_type };
    const lw = intOf(m, 370, -1);
    if (lw > 0) out.line_weight = lw;
    return out;
  }

  /** 図形の座標を変換 t で動かして、entities へ追加する。 */
  function push(e, t) {
    switch (e.type) {
      case "LINE": {
        const a = pt(t, e.x1, e.y1), b = pt(t, e.x2, e.y2);
        entities.push({ ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        break;
      }
      case "POINT": {
        const a = pt(t, e.x, e.y);
        entities.push({ ...e, x: a.x, y: a.y });
        break;
      }
      case "CIRCLE":
      case "ARC": {
        const sy = Math.abs(det(t)) / (scaleX(t) || 1);
        if (Math.abs(scaleX(t) - sy) > 1e-9 * Math.max(1, sy)) {
          // 縦横で拡大率が違うと楕円になる。折れ線で近似する
          const a0 = e.type === "ARC" ? (e.start_angle * Math.PI) / 180 : 0;
          let a1 = e.type === "ARC" ? (e.end_angle * Math.PI) / 180 : Math.PI * 2;
          if (a1 <= a0) a1 += Math.PI * 2;
          const n = 72;
          let prev = null;
          for (let i = 0; i <= n; i++) {
            const a = a0 + ((a1 - a0) * i) / n;
            const q = pt(t, e.center_x + e.radius * Math.cos(a), e.center_y + e.radius * Math.sin(a));
            if (prev) entities.push({ layer: e.layer, color: e.color, line_type: e.line_type, ...(e.line_weight ? { line_weight: e.line_weight } : {}), type: "LINE", x1: prev.x, y1: prev.y, x2: q.x, y2: q.y });
            prev = q;
          }
          break;
        }
        const c = pt(t, e.center_x, e.center_y);
        const out = { ...e, center_x: c.x, center_y: c.y, radius: e.radius * scaleX(t) };
        if (e.type === "ARC") {
          const s = norm360(dirDeg(t, e.start_angle)), en = norm360(dirDeg(t, e.end_angle));
          // 鏡像(向きが反転)のときは、反時計回りを保つため、始点と終点を入れ替える
          [out.start_angle, out.end_angle] = det(t) < 0 ? [en, s] : [s, en];
        }
        entities.push(out);
        break;
      }
      case "SOLID": {
        const [a, b, c, d] = [[e.x1, e.y1], [e.x2, e.y2], [e.x3, e.y3], [e.x4, e.y4]].map(([x, y]) => pt(t, x, y));
        entities.push({ ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y, x3: c.x, y3: c.y, x4: d.x, y4: d.y });
        break;
      }
      case "TEXT": {
        const a = pt(t, e.x, e.y);
        const rot = dirDeg(t, e.rotation);
        const sy = Math.abs(det(t)) / (scaleX(t) || 1);
        const h = e.height * sy;
        const wf = e.width_factor * (scaleX(t) / (sy || 1));
        const w = textWidth(e.content, h, wf);
        const r = (rot * Math.PI) / 180;
        entities.push({ ...e, x: a.x, y: a.y, height: h, width_factor: wf, rotation: rot, end_x: a.x + Math.cos(r) * w, end_y: a.y + Math.sin(r) * w });
        break;
      }
      default:
        break;
    }
  }

  /** TEXT・MTEXT の図形を作る(複数行は1行ごとに1つ)。 */
  function textEntities(m, base, mtext) {
    const raw = mtext ? (m.get(3) ?? []).join("") + (first(m, 1, "") ?? "") : first(m, 1, "") ?? "";
    const content = mtext ? cleanMtext(raw) : cleanText(raw);
    const lines = content.split("\n").map((s) => s.replace(/\s+$/, "")).filter((s) => s !== "");
    const height = numOf(m, 40, 2.5) || 2.5;
    const widthFactor = mtext ? 1 : numOf(m, 41, 1) || 1;
    const rot = mtext && m.has(11) ? (Math.atan2(numOf(m, 21), numOf(m, 11)) * 180) / Math.PI : numOf(m, 50);
    let x = numOf(m, 10), y = numOf(m, 20);
    // TEXTに位置合わせの指定(左下以外)があるときは、第2点が基準点になる
    if (!mtext && (intOf(m, 72) || intOf(m, 73)) && m.has(11)) {
      x = numOf(m, 11);
      y = numOf(m, 21);
    }
    const r = (rot * Math.PI) / 180;
    const ux = Math.cos(r), uy = Math.sin(r);
    const attach = intOf(m, 71, 1); // MTEXTの配置 1〜3:上、4〜6:中、7〜9:下
    const drop = mtext ? (attach <= 3 ? height : attach <= 6 ? height / 2 : 0) : 0;
    return lines.map((content_, i) => {
      const down = drop + height * 1.5 * i;
      return { ...base, type: "TEXT", x: x + uy * down, y: y - ux * down, end_x: 0, end_y: 0, height, width_factor: widthFactor, rotation: rot, content: content_, style: "STANDARD" };
    });
  }

  function addPolyline(verts, closed, base, t) {
    const n = verts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const p = verts[i];
      for (const seg of segment(p, verts[(i + 1) % n], p.b, base)) push(seg, t);
    }
  }

  /** 図形の記録1つを、変換 t をかけて追加する。vertices は POLYLINE の頂点。 */
  function addRecord(rec, t, inherit, depth, vertices) {
    const m = bag(rec.g);
    const base = baseOf(m, inherit);
    switch (rec.type) {
      case "LINE":
        push({ ...base, type: "LINE", x1: numOf(m, 10), y1: numOf(m, 20), x2: numOf(m, 11), y2: numOf(m, 21) }, t);
        break;
      case "POINT":
        push({ ...base, type: "POINT", x: numOf(m, 10), y: numOf(m, 20) }, t);
        break;
      case "CIRCLE":
        push({ ...base, type: "CIRCLE", center_x: numOf(m, 10), center_y: numOf(m, 20), radius: numOf(m, 40) }, t);
        break;
      case "ARC":
        push({ ...base, type: "ARC", center_x: numOf(m, 10), center_y: numOf(m, 20), radius: numOf(m, 40), start_angle: numOf(m, 50), end_angle: numOf(m, 51, 360) }, t);
        break;
      case "SOLID":
      case "TRACE": {
        const x = [0, 1, 2, 3].map((i) => numOf(m, 10 + i)), y = [0, 1, 2, 3].map((i) => numOf(m, 20 + i));
        if (!m.has(13)) { x[3] = x[2]; y[3] = y[2]; } // 3角形(第4点なし)
        push({ ...base, type: "SOLID", x1: x[0], y1: y[0], x2: x[1], y2: y[1], x3: x[2], y3: y[2], x4: x[3], y4: y[3] }, t);
        break;
      }
      case "TEXT":
      case "MTEXT":
      case "ATTRIB":
        for (const e of textEntities(m, base, rec.type === "MTEXT")) push(e, t);
        break;
      case "LWPOLYLINE": {
        const verts = [];
        for (const [c, v] of rec.g) {
          if (c === 10) verts.push({ x: Number.parseFloat(v), y: 0, b: 0 });
          else if (c === 20 && verts.length) verts[verts.length - 1].y = Number.parseFloat(v);
          else if (c === 42 && verts.length) verts[verts.length - 1].b = Number.parseFloat(v);
        }
        addPolyline(verts, Boolean(intOf(m, 70) & 1), base, t);
        break;
      }
      case "POLYLINE":
        addPolyline(vertices ?? [], Boolean(intOf(m, 70) & 1), base, t);
        break;
      case "ELLIPSE": {
        const cx = numOf(m, 10), cy = numOf(m, 20), mx = numOf(m, 11), my = numOf(m, 21), ratio = numOf(m, 40, 1);
        const a0 = numOf(m, 41, 0);
        let a1 = numOf(m, 42, Math.PI * 2);
        if (a1 <= a0) a1 += Math.PI * 2;
        const n = Math.max(8, Math.ceil((a1 - a0) / ARC_STEP));
        const pts = [];
        for (let i = 0; i <= n; i++) {
          const a = a0 + ((a1 - a0) * i) / n;
          const ca = Math.cos(a), sa = Math.sin(a);
          pts.push({ x: cx + mx * ca - my * ratio * sa, y: cy + my * ca + mx * ratio * sa, b: 0 });
        }
        addPolyline(pts, false, base, t);
        break;
      }
      case "SPLINE": {
        // 通過点(11/21)があればそれを、なければ制御点(10/20)を結ぶ(近似)
        const fx = [], fy = [], cx = [], cy = [];
        for (const [c, v] of rec.g) {
          if (c === 11) fx.push(Number.parseFloat(v));
          else if (c === 21) fy.push(Number.parseFloat(v));
          else if (c === 10) cx.push(Number.parseFloat(v));
          else if (c === 20) cy.push(Number.parseFloat(v));
        }
        const [px, py] = fx.length >= 2 ? [fx, fy] : [cx, cy];
        addPolyline(px.map((x, i) => ({ x, y: py[i] ?? 0, b: 0 })), false, base, t);
        break;
      }
      case "INSERT":
        insertBlock(m, t, base, depth);
        break;
      case "DIMENSION": {
        // 寸法は、DXFの中に描いた図形(ブロック)として入っている。それを置く
        const blk = blocks.get((first(m, 2, "") ?? "").trim());
        if (blk && depth < MAX_DEPTH) expandBlock(blk, t, base, depth + 1);
        else noteUnsupported("DIMENSION");
        break;
      }
      default:
        noteUnsupported(rec.type);
    }
  }

  function insertBlock(m, t, base, depth) {
    const blk = blocks.get((first(m, 2, "") ?? "").trim());
    if (!blk || depth >= MAX_DEPTH) {
      noteUnsupported(blk ? "INSERT(入れ子が深すぎる)" : "INSERT(ブロックなし)");
      return;
    }
    const sx = numOf(m, 41, 1), sy = numOf(m, 42, 1), rot = numOf(m, 50, 0);
    const ix = numOf(m, 10), iy = numOf(m, 20);
    const cols = Math.min(1000, Math.max(1, Math.round(numOf(m, 70, 1)))), rows = Math.min(1000, Math.max(1, Math.round(numOf(m, 71, 1))));
    const dc = numOf(m, 44), dr = numOf(m, 45);
    const r = (rot * Math.PI) / 180;
    for (let ci = 0; ci < cols; ci++) {
      for (let ri = 0; ri < rows; ri++) {
        // 配列の間隔は、ブロックの向きに合わせて回す
        const ox = ix + Math.cos(r) * dc * ci - Math.sin(r) * dr * ri;
        const oy = iy + Math.sin(r) * dc * ci + Math.cos(r) * dr * ri;
        expandBlock(blk, compose(t, placement(sx, sy, rot, ox, oy)), base, depth + 1);
      }
    }
  }

  /** ブロックの基点が挿入点に来るように置く。 */
  function expandBlock(blk, t, inherit, depth) {
    walk(blk.recs, compose(t, placement(1, 1, 0, -blk.base.x, -blk.base.y)), inherit, depth);
  }

  /** 記録の並びを順に追加する。POLYLINE は、続く VERTEX を集めてから処理する。 */
  function walk(recs, t, inherit, depth) {
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      if (rec.type === "VERTEX" || rec.type === "SEQEND") continue;
      if (rec.type !== "POLYLINE") {
        addRecord(rec, t, inherit, depth);
        continue;
      }
      const verts = [];
      let j = i + 1;
      for (; j < recs.length && recs[j].type !== "SEQEND"; j++) {
        if (recs[j].type !== "VERTEX") continue;
        const vm = bag(recs[j].g);
        if (!(intOf(vm, 70) & 16)) verts.push({ x: numOf(vm, 10), y: numOf(vm, 20), b: numOf(vm, 42) }); // 16: スプラインの制御点は除く
      }
      if (intOf(bag(rec.g), 70) & 64) noteUnsupported("POLYLINE(3Dメッシュ)");
      else addRecord(rec, t, inherit, depth, verts);
      i = j;
    }
  }

  walk(records(sections.get("ENTITIES") ?? []), unitScale === 1 ? IDENTITY : placement(unitScale, unitScale, 0, 0, 0), null, 0);

  // レイヤの表にない名前の図形があれば、一覧へ足す(見えなくならないように)
  const known = new Set(layers.map((l) => l.name));
  for (const e of entities) {
    if (!known.has(e.layer)) {
      known.add(e.layer);
      layers.push({ name: e.layer, color: 7, line_type: "CONTINUOUS", frozen: false, locked: false });
    }
  }

  return { layers, line_types: lineTypes, entities, blocks: [], unsupported_entities: unsupported, unsupportedTypes: [...unsupportedTypes], unitScale };
}
