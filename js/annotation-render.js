// 注釈を、図面の上に描く。図面の座標(用紙mm)を画面の座標に変換して、線の太さや文字の大きさは画面の大きさで決める。
import { COLORS, centroid } from "./annotations.js";
import { polylineLength, polygonArea, realLength, realArea, formatLength, formatArea, distance } from "./geometry.js";

const SNAP_NAMES = { end: "端点", mid: "中点", center: "中心", quad: "四半点", mark: "基準点", point: "点" };
const FONT = '"BIZ UDPGothic", "Noto Sans JP", "Yu Gothic", sans-serif';

/** 寸法・ルートの文字(実寸の長さ)。 */
export function lengthLabel(item) {
  return formatLength(realLength(polylineLength(item.points), item.scale ?? 1));
}

export function areaLabel(item) {
  return formatArea(realArea(polygonArea(item.points), item.scale ?? 1));
}

/**
 * @param {{ ctx: CanvasRenderingContext2D, view: {s:number,tx:number,ty:number}, dpr: number, width: number, height: number, forExport?: boolean }} frame
 * @param {{ items: any[], draft?: any, snap?: {x:number,y:number}|null, selectedId?: string|null, rects?: Map<string, {x:number,y:number,w:number,h:number}>|null }} content
 */
export function drawAnnotations(frame, { items, draft = null, snap = null, selectedId = null, rects = null }) {
  const { ctx, view, dpr, width, height, forExport = false } = frame;
  // 書き出し(PDF)では画面より細かい座標で描くので、線や文字を大きくする
  const ui = forExport ? Math.max(1, Math.min(width, height) / 1000) : 1;
  const px = (n) => n * ui;
  const toScreen = (p) => ({ x: p.x * view.s + view.tx, y: -p.y * view.s + view.ty });

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const label = (text, at, color) => {
    ctx.font = `bold ${px(13)}px ${FONT}`;
    const w = ctx.measureText(text).width;
    const h = px(18);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillRect(at.x - w / 2 - px(4), at.y - h / 2, w + px(8), h);
    ctx.strokeStyle = color;
    ctx.lineWidth = px(1);
    ctx.strokeRect(at.x - w / 2 - px(4), at.y - h / 2, w + px(8), h);
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(text, at.x, at.y);
  };
  const path = (pts, close = false) => {
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    if (close) ctx.closePath();
  };
  const dot = (p, color, r = 3.5) => {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(p.x, p.y, px(r + 1.5), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, px(r), 0, Math.PI * 2);
    ctx.fill();
  };

  const drawItem = (item, { isDraft = false, cursor = null } = {}) => {
    const color = COLORS[item.kind];
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.setLineDash(isDraft ? [px(6), px(4)] : []);
    if (item.kind === "mark") {
      // 基準点: 十字と丸(吸着の対象になる)。選択中は、黄色い丸を敷く
      const at = toScreen(item.at);
      if (item.id === selectedId && !forExport) {
        ctx.fillStyle = "rgba(255,214,0,0.6)";
        ctx.beginPath();
        ctx.arc(at.x, at.y, 16, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = px(2);
      ctx.setLineDash([]);
      const r = px(9);
      path([{ x: at.x - r, y: at.y }, { x: at.x + r, y: at.y }]);
      ctx.stroke();
      path([{ x: at.x, y: at.y - r }, { x: at.x, y: at.y + r }]);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(at.x, at.y, px(4), 0, Math.PI * 2);
      ctx.stroke();
      if (item.note) label(item.note, { x: at.x, y: at.y - px(18) }, color);
      return;
    }
    if (item.kind === "text") {
      const at = toScreen(item.at);
      ctx.font = `bold ${px(15)}px ${FONT}`;
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      const lines = item.text.split("\n");
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const lh = px(19);
      const box = { x: at.x - px(3), y: at.y - px(15), w: w + px(8), h: lh * lines.length + px(2) };
      if (rects && !forExport) rects.set(item.id, box); // 選ぶときの当たり判定に使う(画面px)
      if (item.id === selectedId && !forExport) {
        ctx.fillStyle = "rgba(255,214,0,0.55)";
        ctx.fillRect(box.x - 5, box.y - 5, box.w + 10, box.h + 10);
      }
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.fillRect(at.x - px(3), at.y - px(15), w + px(8), lh * lines.length + px(2));
      ctx.strokeStyle = color;
      ctx.lineWidth = px(1);
      ctx.strokeRect(at.x - px(3), at.y - px(15), w + px(8), lh * lines.length + px(2));
      ctx.fillStyle = color;
      lines.forEach((l, i) => ctx.fillText(l, at.x, at.y + i * lh));
      ctx.setLineDash([]);
      return;
    }
    const pts = item.points.map(toScreen);
    const all = cursor ? [...pts, toScreen(cursor)] : pts;
    if (item.id === selectedId && !forExport) {
      // 選んでいる注釈の下に、黄色い太い線を敷く
      ctx.save();
      ctx.setLineDash([]);
      ctx.strokeStyle = "rgba(255,214,0,0.6)";
      ctx.lineWidth = 12;
      path(all, item.kind === "area" && all.length >= 3);
      ctx.stroke();
      ctx.restore();
    }
    if (item.kind === "pen") {
      ctx.lineWidth = px(2.5);
      path(all);
      ctx.stroke();
    } else if (item.kind === "area") {
      ctx.lineWidth = px(2);
      if (all.length >= 3) {
        path(all, true);
        ctx.globalAlpha = 0.18;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      path(all, all.length >= 3);
      ctx.stroke();
      pts.forEach((p) => dot(p, color));
      if (item.points.length >= 3) label(areaLabel(item), toScreen(centroid(item.points)), color);
    } else if (item.kind === "route") {
      ctx.lineWidth = px(3.5);
      path(all);
      ctx.stroke();
      pts.forEach((p) => dot(p, color));
      const mid = all[Math.floor(all.length / 2) - (all.length % 2 === 0 ? 1 : 0)] ?? all[0];
      const total = polylineLength(cursor ? [...item.points, cursor] : item.points);
      label(formatLength(realLength(total, item.scale ?? 1)), { x: mid.x, y: mid.y - px(16) }, color);
    } else if (item.kind === "line" || item.kind === "rect" || item.kind === "circle") {
      // 作図中の予告(破線)。確定すると、図面の図形になる
      const w0 = item.points[0];
      const sc = item.scale ?? 1;
      ctx.lineWidth = px(1.5);
      if (cursor && item.kind === "line") {
        path(all);
        ctx.stroke();
        label(formatLength(realLength(distance(w0, cursor), sc)), { x: (all[0].x + all[1].x) / 2, y: (all[0].y + all[1].y) / 2 - px(14) }, color);
      } else if (cursor && item.kind === "rect") {
        const a = all[0];
        const b = all[1];
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        const w = formatLength(realLength(Math.abs(cursor.x - w0.x), sc));
        const h = formatLength(realLength(Math.abs(cursor.y - w0.y), sc));
        label(`${w} × ${h}`, { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - px(14) }, color);
      } else if (cursor && item.kind === "circle") {
        const c = all[0];
        const r = Math.hypot(all[1].x - c.x, all[1].y - c.y);
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.stroke();
        path([c, all[1]]);
        ctx.stroke();
        label(`R ${formatLength(realLength(distance(w0, cursor), sc))}`, { x: c.x, y: c.y - r - px(14) }, color);
      } else {
        dot(all[0], color);
      }
    } else if (item.kind === "dim") {
      const a = all[0];
      const b = all[1];
      if (b) {
        ctx.lineWidth = px(2);
        path([a, b]);
        ctx.stroke();
        // 両端に、寸法線の端の印(線に直角の短い線)
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const nx = (-(b.y - a.y) / len) * px(7);
        const ny = ((b.x - a.x) / len) * px(7);
        for (const p of [a, b]) {
          path([{ x: p.x - nx, y: p.y - ny }, { x: p.x + nx, y: p.y + ny }]);
          ctx.stroke();
        }
        const total = polylineLength(cursor ? [item.points[0], cursor] : item.points);
        label(formatLength(realLength(total, item.scale ?? 1)), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - px(14) }, color);
      } else {
        dot(a, color);
      }
    }
    ctx.setLineDash([]);
  };

  for (const item of items) drawItem(item);
  if (draft) drawItem(draft.item, { isDraft: true, cursor: draft.cursor });
  if (draft?.item.points?.length && draft.item.kind !== "pen") draft.item.points.forEach((p) => dot(toScreen(p), COLORS[draft.item.kind]));

  if (snap && !forExport) {
    // 吸着の印: 端点=四角、中点=三角、中心・四半点=丸、基準点=十字つきの丸。横に種類の名前を出す
    const sp = toScreen(snap);
    ctx.strokeStyle = "#00acc1";
    ctx.fillStyle = "#00acc1";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    if (snap.kind === "mid") {
      ctx.beginPath();
      ctx.moveTo(sp.x, sp.y - 8);
      ctx.lineTo(sp.x + 8, sp.y + 6);
      ctx.lineTo(sp.x - 8, sp.y + 6);
      ctx.closePath();
      ctx.stroke();
    } else if (snap.kind === "center" || snap.kind === "quad" || snap.kind === "mark") {
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 7, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeRect(sp.x - 6, sp.y - 6, 12, 12);
    }
    const name = SNAP_NAMES[snap.kind];
    if (name) {
      ctx.font = `bold 12px ${FONT}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(name, sp.x + 12, sp.y - 12);
    }
  }
  ctx.restore();
}
