// 図面の図形そのものを選んで、移動・回転・拡大縮小・複製・削除するツール。
// 操作は EditStore に「記録」として積むだけで、原本のJWWは書き換えない。
import { applyToPoint, entityBounds, pickEntity, pickInRect, stretchEntity, unionBounds } from "./edits.js";
import { SnapIndex, snapPointsOfEntity } from "./geometry.js";

const HANDLE_PX = 22; // 角の取っ手を押せる範囲(画面px、半径)
const ROTATE_OFFSET_PX = 34; // 回転の取っ手を、枠の上端から離す距離
const TAP_PX = 6; // これより小さいドラッグは、タップとみなす
const PICK_PX = 12; // タップで図形を選ぶときの許容距離
const SNAP_ANGLE = (15 * Math.PI) / 180;
const SNAP_PX = 14; // 移動のとき、この距離(画面px)以内の点に吸着する
const MAX_KEYS = 300; // 吸着を調べる「動かす側の点」の上限

export class ObjectTool {
  /**
   * @param {object} deps
   * @param {import("./viewer.js").Viewer} deps.viewer
   * @param {import("./edits.js").EditStore} deps.edits
   * @param {() => (import("./geometry.js").SnapIndex | null)} [deps.getSnap] 吸着の対象(端点・中点・基準点など)
   * @param {() => number} [deps.getScale] 縮尺の分母(数値入力は実寸mmで受けるため、用紙mmに直す)
   * @param {(title: string, hint?: string) => Promise<{dx:number, dy:number} | null>} [deps.askOffset] 横・縦の移動量(実寸mm)を入力してもらう
   * @param {() => void} [deps.onState]
   */
  constructor({ viewer, edits, getSnap = () => null, getScale = () => 100, askOffset = async () => null, onState = () => {} }) {
    this.viewer = viewer;
    this.edits = edits;
    this.getSnap = getSnap;
    this.getScale = getScale;
    this.askOffset = askOffset;
    this.onState = onState;
    this.snapHit = null; // いま吸着している点(表示用)
    this.baseMove = null; // 基点移動: { stage: "base"|"dest", base }
    this.stretch = null; // 伸縮: { stage: "window"|"offset", win, dx, dy }
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

  get selectionSet() {
    return new Set(this.selection);
  }

  /** 動かす側の「吸着に使う点」: 図形の端点・中点・中心と、枠の角・辺の中点・中心。 */
  #keyPoints(onlyInside = null) {
    const pts = [];
    for (const i of this.selection) {
      const e = this.edits.entities[i];
      if (e) for (const p of snapPointsOfEntity(e)) pts.push(p);
    }
    const b = this.bounds();
    if (b) {
      const xs = [b.x0, (b.x0 + b.x1) / 2, b.x1];
      const ys = [b.y0, (b.y0 + b.y1) / 2, b.y1];
      for (const x of xs) for (const y of ys) pts.push({ x, y, kind: "bbox" });
    }
    const inside = onlyInside ? pts.filter((p) => p.x >= onlyInside.x0 && p.x <= onlyInside.x1 && p.y >= onlyInside.y0 && p.y <= onlyInside.y1) : pts;
    if (inside.length <= MAX_KEYS) return inside;
    const step = Math.ceil(inside.length / MAX_KEYS);
    return inside.filter((_, k) => k % step === 0);
  }

  /** 動かす量(dx, dy)で、動かす側のどれかの点が、他の図形の点に近づいたら、ぴったり重なるよう補正する。 */
  #snapMove(keys, dx, dy) {
    const snap = this.getSnap();
    if (!snap) return null;
    const tol = SNAP_PX / this.viewer.view.s;
    const exclude = this.selectionSet;
    let best = null;
    for (const k of keys) {
      const moved = { x: k.x + dx, y: k.y + dy };
      const t = snap.nearest(moved, tol, { exclude });
      if (!t) continue;
      const d = Math.hypot(t.x - moved.x, t.y - moved.y);
      if (!best || d < best.d) best = { d, ax: t.x - moved.x, ay: t.y - moved.y, target: t, from: k };
    }
    return best;
  }

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
    this.baseMove = null;
    this.stretch = null;
    this.snapHit = null;
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
    if (this.baseMove) {
      this.drag = { kind: "basetap", at: point };
      this.#showCandidate(point);
      return;
    }
    if (this.stretch?.stage === "offset") {
      const keys = this.#keyPoints(this.stretch.win);
      this.drag = { kind: "stretchdrag", start: point.world, at: point, base0: { dx: this.stretch.dx, dy: this.stretch.dy }, keys, moved: false };
      return;
    }
    if (this.stretch?.stage === "window") {
      this.drag = { kind: "marquee", start: point.world, startScreen: point, moved: false, forStretch: true };
      this.marquee = { x0: point.world.x, y0: point.world.y, x1: point.world.x, y1: point.world.y };
      return;
    }
    const handle = this.hasSelection ? this.#hitHandle(point) : null;
    if (handle) {
      this.drag = { ...handle, moved: false, at: point };
      return;
    }
    this.drag = { kind: "marquee", start: point.world, startScreen: point, moved: false };
    this.marquee = { x0: point.world.x, y0: point.world.y, x1: point.world.x, y1: point.world.y };
  }

  /** 基点移動で、指の下にある吸着の候補を、印として見せる。 */
  #showCandidate(point) {
    const snap = this.getSnap();
    const tol = (SNAP_PX * 1.3) / this.viewer.view.s;
    if (this.baseMove.stage === "base") {
      // 動かす側(選択中の図形)の端点・中点・中心から選ぶ
      const own = new SnapIndex(this.selection.map((i) => this.edits.entities[i]));
      this.snapHit = own.nearest(point.world, tol) ?? this.#nearestKey(point.world, tol);
    } else {
      this.snapHit = snap?.nearest(point.world, tol, { exclude: this.selectionSet }) ?? null;
    }
  }

  #nearestKey(p, tol) {
    let best = null;
    for (const k of this.#keyPoints()) {
      const d = Math.hypot(k.x - p.x, k.y - p.y);
      if (d <= tol && (!best || d < best.d)) best = { ...k, d };
    }
    return best;
  }

  move(point) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === "basetap") {
      this.#showCandidate(point);
      return;
    }
    if (d.kind === "stretchdrag") {
      let dx = d.base0.dx + (point.world.x - d.start.x);
      let dy = d.base0.dy + (point.world.y - d.start.y);
      const hit = this.#snapMove(d.keys, dx, dy);
      if (hit) {
        dx += hit.ax;
        dy += hit.ay;
      }
      this.snapHit = hit?.target ?? null;
      this.stretch.dx = dx;
      this.stretch.dy = dy;
      d.moved = true;
      this.#previewStretch();
      return;
    }
    const dxs = point.sx - (d.at?.sx ?? d.startScreen?.sx ?? point.sx);
    const dys = point.sy - (d.at?.sy ?? d.startScreen?.sy ?? point.sy);
    if (!d.moved && Math.hypot(dxs, dys) < TAP_PX) return;
    d.moved = true;
    const { cx, cy } = d.base ?? {};
    switch (d.kind) {
      case "move": {
        let dx = point.world.x - d.start.x;
        let dy = point.world.y - d.start.y;
        d.keys ??= this.#keyPoints();
        const hit = this.#snapMove(d.keys, dx, dy); // 動かす側の端点・中点が、他の点にぴったり重なるように補正
        if (hit) {
          dx += hit.ax;
          dy += hit.ay;
        }
        this.snapHit = hit?.target ?? null;
        this.xf = { cx, cy, dx, dy, theta: 0, s: 1 };
        break;
      }
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
    this.snapHit = d?.kind === "basetap" ? this.snapHit : null;
    if (!d) return;
    if (d.kind === "basetap") {
      this.#baseTap(point);
      this.viewer.redraw();
      return;
    }
    if (d.kind === "stretchdrag") {
      this.snapHit = null;
      this.onState();
      this.viewer.redraw();
      return;
    }
    if (d.kind === "marquee") {
      const m = this.marquee;
      this.marquee = null;
      if (d.forStretch) {
        if (d.moved && Math.abs(m.x1 - m.x0) > 0 && Math.abs(m.y1 - m.y0) > 0) {
          this.stretch = { stage: "offset", win: { x0: Math.min(m.x0, m.x1), y0: Math.min(m.y0, m.y1), x1: Math.max(m.x0, m.x1), y1: Math.max(m.y0, m.y1) }, dx: 0, dy: 0 };
          this.#previewStretch();
          this.onState();
        }
      } else if (d.moved) this.#selectRect(m);
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
    // 2本目の指が触れた: ドラッグ中の変換は取りやめ(元の位置に戻す)。基点移動・伸縮の途中経過は残す
    this.drag = null;
    this.marquee = null;
    this.xf = null;
    this.snapHit = null;
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

  // ---- 基点移動: 動かす側の点(端点・中点・中心)を指定し、移動先の点(他の図形の点・基準点)を指定する ----
  beginBaseMove() {
    if (!this.hasSelection) return;
    this.cancelModes();
    this.baseMove = { stage: "base", base: null };
    this.onState();
  }

  #baseTap(point) {
    const hit = this.snapHit;
    if (this.baseMove.stage === "base") {
      if (!hit) return; // 点に吸着できなかった: もう一度、選択中の図形の端点・中点をタップしてもらう
      this.baseMove = { stage: "dest", base: { x: hit.x, y: hit.y } };
      this.snapHit = null;
      this.onState();
      return;
    }
    const dest = this.snapHit ?? point.world; // 吸着できなければ、タップした位置そのまま
    const b = this.baseMove.base;
    this.baseMove = null;
    this.snapHit = null;
    const c = this.bounds();
    this.#commit({ type: "xform", xf: { cx: (c.x0 + c.x1) / 2, cy: (c.y0 + c.y1) / 2, dx: dest.x - b.x, dy: dest.y - b.y, theta: 0, s: 1 } });
    this.onState();
  }

  // ---- 伸縮(ストレッチ): 窓で囲んだ側の点だけを動かして、寸法を変える ----
  beginStretch() {
    if (!this.hasSelection) return;
    this.cancelModes();
    this.stretch = { stage: "window", win: null, dx: 0, dy: 0 };
    this.onState();
  }

  #stretched() {
    const st = this.stretch;
    return this.selection.map((i) => stretchEntity(this.edits.entities[i], st.win, st.dx, st.dy));
  }

  #previewStretch() {
    this.viewer.setFloatingEntities(this.#stretched());
  }

  /** 数値で、動かす量(実寸mm)を入力してもらう。 */
  async askStretchOffset() {
    if (this.stretch?.stage !== "offset") return;
    const scale = this.getScale();
    const r = await this.askOffset("伸縮する量(実寸mm)", "窓で囲んだ側を、横(→が+)・縦(↑が+)に動かします。例: 幅を1200→900にするなら、横 -300");
    if (!r) return;
    this.stretch.dx = r.dx / scale; // 実寸mm → 用紙mm
    this.stretch.dy = r.dy / scale;
    this.#previewStretch();
    this.onState();
  }

  /** 伸縮を確定する(窓の位置と動かした量を、記録として残す)。 */
  finish() {
    const st = this.stretch;
    if (!st || st.stage !== "offset" || (st.dx === 0 && st.dy === 0)) return false;
    const ids = [...this.selection];
    this.edits.add({ type: "stretch", ids, win: st.win, dx: st.dx, dy: st.dy });
    this.stretch = null;
    this.snapHit = null;
    this.viewer.entities = this.edits.entities;
    this.select(ids);
    return true;
  }

  /** 基点移動・伸縮の途中経過をやめる。 */
  cancelModes() {
    const had = this.baseMove || this.stretch;
    this.baseMove = null;
    this.stretch = null;
    this.snapHit = null;
    this.marquee = null;
    if (had) this.select(this.selection); // 伸縮のプレビューを、元の図形に戻す
    this.onState();
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
    if (this.stretch?.win) {
      const w = this.stretch.win;
      const a = scr({ x: w.x0, y: w.y1 });
      const b = scr({ x: w.x1, y: w.y0 });
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#2e7d32";
      ctx.fillStyle = "rgba(46,125,50,0.10)";
      ctx.lineWidth = 1.5;
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.setLineDash([]);
    }
    if (this.baseMove?.base) {
      const b = scr(this.baseMove.base);
      ctx.strokeStyle = "#d81b60";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(b.x, b.y, 9, 0, Math.PI * 2);
      ctx.moveTo(b.x - 14, b.y);
      ctx.lineTo(b.x + 14, b.y);
      ctx.moveTo(b.x, b.y - 14);
      ctx.lineTo(b.x, b.y + 14);
      ctx.stroke();
    }
    const f = this.hasSelection && !this.stretch && !this.baseMove ? this.#frame() : null;
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
