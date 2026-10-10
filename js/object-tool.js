// 図面の図形そのものを選んで、移動・回転・拡大縮小・複製・削除するツール。
// 操作は EditStore に「記録」として積むだけで、原本のJWWは書き換えない。
import { applyToPoint, entityBounds, pickEntity, pickInRect, unionBounds } from "./edits.js";

const HANDLE_PX = 22; // 角の取っ手を押せる範囲(画面px、半径)
const ROTATE_OFFSET_PX = 34; // 回転の取っ手を、枠の上端から離す距離
const TAP_PX = 6; // これより小さいドラッグは、タップとみなす
const PICK_PX = 12; // タップで図形を選ぶときの許容距離
const SNAP_ANGLE = (15 * Math.PI) / 180;

export class ObjectTool {
  /**
   * @param {object} deps
   * @param {import("./viewer.js").Viewer} deps.viewer
   * @param {import("./edits.js").EditStore} deps.edits
   * @param {() => void} [deps.onState]
   */
  constructor({ viewer, edits, onState = () => {} }) {
    this.viewer = viewer;
    this.edits = edits;
    this.onState = onState;
    this.selection = []; // 選んでいる図形の番号(edits.entities の添字)
    this.additive = false; // 追加ボタン: 選び直さず、足す(すでに選んでいれば外す)
    this.drag = null; // { kind: "move"|"scale"|"rotate"|"marquee", ... }
    this.marquee = null; // 範囲選択中の四角(用紙mm)
    this.xf = null; // ドラッグ中の変換
  }

  get hasSelection() {
    return this.selection.length > 0;
  }

  #visible = (e) => !this.viewer.hiddenLayers.has(e.layer);

  /** 選んでいる図形を囲む四角(用紙mm)。 */
  bounds() {
    return unionBounds(this.selection.map((i) => entityBounds(this.edits.entities[i])));
  }

  select(indices) {
    this.selection = indices.filter((i) => this.edits.entities[i]);
    this.xf = null;
    this.viewer.setFloating(this.selection);
    this.onState();
  }

  clearSelection() {
    this.select([]);
  }

  /** 編集の記録が変わった(取り消しや読み込み)あとに、選択と表示を合わせる。 */
  refresh() {
    this.viewer.entities = this.edits.entities;
    this.select(this.selection);
  }

  /** 基準の四角の、四隅・回転の取っ手の位置(用紙mm)を、変換後の位置で返す。 */
  #frame(xf = this.xf) {
    const b = this.bounds();
    if (!b) return null;
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const s = this.viewer.view.s;
    const raw = {
      corners: [{ x: b.x0, y: b.y1 }, { x: b.x1, y: b.y1 }, { x: b.x1, y: b.y0 }, { x: b.x0, y: b.y0 }], // 左上・右上・右下・左下
      rotate: { x: cx, y: b.y1 + ROTATE_OFFSET_PX / s },
      top: { x: cx, y: b.y1 },
      center: { x: cx, y: cy },
    };
    const map = (p) => (xf ? applyToPoint(xf, p.x, p.y) : p); // ドラッグ中の変換は、枠の中心を基準にしている
    return {
      corners: raw.corners.map(map),
      rotate: map(raw.rotate),
      top: map(raw.top),
      center: map(raw.center),
      base: { cx, cy },
    };
  }

  /** 画面のpx座標で、取っ手のどれに触れたかを調べる。 */
  #hitHandle(point) {
    const f = this.#frame(null);
    if (!f) return null;
    const v = this.viewer.view;
    const scr = (p) => ({ x: p.x * v.s + v.tx, y: -p.y * v.s + v.ty });
    const near = (p) => Math.hypot(scr(p).x - point.sx, scr(p).y - point.sy) <= HANDLE_PX;
    if (near(f.rotate)) return { kind: "rotate", base: f.base, start: point.world };
    for (const c of f.corners) if (near(c)) return { kind: "scale", base: f.base, start: point.world, startDist: Math.hypot(c.x - f.base.cx, c.y - f.base.cy) };
    const b = this.bounds();
    if (point.world.x >= b.x0 && point.world.x <= b.x1 && point.world.y >= b.y0 && point.world.y <= b.y1) return { kind: "move", base: f.base, start: point.world };
    return null;
  }

  down(point) {
    const handle = this.hasSelection ? this.#hitHandle(point) : null;
    if (handle) {
      this.drag = { ...handle, moved: false, at: point };
      return;
    }
    this.drag = { kind: "marquee", start: point.world, startScreen: point, moved: false };
    this.marquee = { x0: point.world.x, y0: point.world.y, x1: point.world.x, y1: point.world.y };
  }

  move(point) {
    const d = this.drag;
    if (!d) return;
    const dxs = point.sx - (d.at?.sx ?? d.startScreen?.sx ?? point.sx);
    const dys = point.sy - (d.at?.sy ?? d.startScreen?.sy ?? point.sy);
    if (!d.moved && Math.hypot(dxs, dys) < TAP_PX) return;
    d.moved = true;
    const { cx, cy } = d.base ?? {};
    switch (d.kind) {
      case "move":
        this.xf = { cx, cy, dx: point.world.x - d.start.x, dy: point.world.y - d.start.y, theta: 0, s: 1 };
        break;
      case "scale": {
        const dist = Math.hypot(point.world.x - cx, point.world.y - cy);
        const s = Math.min(50, Math.max(0.05, dist / Math.max(d.startDist, 1e-9)));
        this.xf = { cx, cy, dx: 0, dy: 0, theta: 0, s };
        break;
      }
      case "rotate": {
        let theta = Math.atan2(point.world.y - cy, point.world.x - cx) - Math.atan2(d.start.y - cy, d.start.x - cx);
        const snapped = Math.round(theta / SNAP_ANGLE) * SNAP_ANGLE;
        if (Math.abs(theta - snapped) < (4 * Math.PI) / 180) theta = snapped; // 15度ごとに、吸い付く
        this.xf = { cx, cy, dx: 0, dy: 0, theta, s: 1 };
        break;
      }
      case "marquee":
        this.marquee = { x0: d.start.x, y0: d.start.y, x1: point.world.x, y1: point.world.y };
        break;
      default:
        break;
    }
    if (this.xf) this.viewer.setFloatTransform(this.xf);
  }

  up(point) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === "marquee") {
      const m = this.marquee;
      this.marquee = null;
      if (d.moved) this.#selectRect(m);
      else this.#tapSelect(point);
      this.viewer.redraw();
      return;
    }
    if (!d.moved && d.kind === "move") {
      this.#tapSelect(point); // 枠の中の、別の図形をタップしたときは、選び直す
      this.viewer.redraw();
      return;
    }
    if (d.moved && this.xf) this.#commit({ type: "xform", ids: this.selection, xf: this.xf });
    this.xf = null;
    this.viewer.setFloatTransform(null);
  }

  abort() {
    // 2本目の指が触れた: ドラッグ中の変換は取りやめ(元の位置に戻す)
    this.drag = null;
    this.marquee = null;
    this.xf = null;
    this.viewer.setFloatTransform(null);
  }

  #commit(op) {
    const ids = [...this.selection];
    this.edits.add({ ...op, ids });
    this.xf = null;
    this.viewer.entities = this.edits.entities; // 描き直しは、select() の中で1回だけ行う
    this.select(ids);
  }

  #selectRect(rect) {
    const hits = pickInRect(this.edits.entities, rect, this.#visible);
    this.#applySelection(hits);
  }

  #tapSelect(point) {
    const tol = PICK_PX / this.viewer.view.s;
    const i = pickEntity(this.edits.entities, point.world.x, point.world.y, tol, this.#visible);
    this.#applySelection(i >= 0 ? [i] : []);
  }

  #applySelection(hits) {
    if (!this.additive) return this.select(hits);
    const set = new Set(this.selection);
    for (const i of hits) {
      if (set.has(i)) set.delete(i);
      else set.add(i);
    }
    return this.select([...set]);
  }

  /** 選んだ図形を、中心のまわりに回す(度)。 */
  rotateBy(degrees) {
    const b = this.bounds();
    if (!b) return;
    this.#commit({ type: "xform", xf: { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, dx: 0, dy: 0, theta: (degrees * Math.PI) / 180, s: 1 } });
  }

  /** 選んだ図形を、中心を保って拡大縮小する。 */
  scaleBy(factor) {
    const b = this.bounds();
    if (!b) return;
    this.#commit({ type: "xform", xf: { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, dx: 0, dy: 0, theta: 0, s: factor } });
  }

  /** 選んだ図形を、少しずらして複製し、複製を選ぶ。 */
  copy() {
    if (!this.hasSelection) return;
    const off = 16 / this.viewer.view.s;
    const b = this.bounds();
    const op = this.edits.add({ type: "copy", ids: [...this.selection], xf: { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, dx: off, dy: -off, theta: 0, s: 1 } });
    this.viewer.entities = this.edits.entities;
    this.select(op.newIds);
  }

  delete() {
    if (!this.hasSelection) return;
    this.edits.add({ type: "delete", ids: [...this.selection] });
    this.viewer.entities = this.edits.entities;
    this.clearSelection();
  }

  /** 直前の編集を取り消す。取り消せたら true。 */
  undo() {
    if (!this.edits.undo()) return false;
    this.refresh();
    return true;
  }

  /** 画面の上に、選択の枠・取っ手・範囲選択の四角を描く。 */
  drawOverlay({ ctx, view, dpr, forExport }) {
    if (forExport) return;
    const scr = (p) => ({ x: p.x * view.s + view.tx, y: -p.y * view.s + view.ty });
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.marquee) {
      const a = scr({ x: this.marquee.x0, y: this.marquee.y0 });
      const b = scr({ x: this.marquee.x1, y: this.marquee.y1 });
      ctx.fillStyle = "rgba(30,136,229,0.12)";
      ctx.strokeStyle = "#1e88e5";
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }
    const f = this.hasSelection ? this.#frame() : null;
    if (f) {
      const pts = f.corners.map(scr);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#ef6c00";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      const top = scr(f.top);
      const rot = scr(f.rotate);
      // 回転の取っ手の位置は、変換後も「枠の上辺の外側」に保つ
      const dx = rot.x - top.x;
      const dy = rot.y - top.y;
      const len = Math.hypot(dx, dy) || 1;
      const rp = { x: top.x + (dx / len) * ROTATE_OFFSET_PX, y: top.y + (dy / len) * ROTATE_OFFSET_PX };
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(rp.x, rp.y);
      ctx.stroke();
      const handle = (p, round) => {
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#ef6c00";
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (round) ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
        else ctx.rect(p.x - 8, p.y - 8, 16, 16);
        ctx.fill();
        ctx.stroke();
      };
      pts.forEach((p) => handle(p, false));
      handle(rp, true);
    }
    ctx.restore();
  }
}
