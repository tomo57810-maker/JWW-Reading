// Canvasに図面を描き、指(ピンチ・ドラッグ)やマウスで拡大・移動できるようにする。
import { aciToCss } from "./aci.js";
import { dashFor } from "./drawing.js";
import { transformEntity } from "./edits.js";

const MIN_LINE_PX = 0.8; // どこまで拡大縮小しても、線はこの太さ(CSS px)以上で描く
const MIN_TEXT_PX = 3.5; // これより小さい文字は描かない
const MAX_ZOOM_OVER_FIT = 400;

export class Viewer {
  constructor(canvas, onChange = () => {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onChange = onChange;
    this.model = null;
    this.hiddenLayers = new Set();
    this.dark = false;
    this.view = { s: 1, tx: 0, ty: 0 }; // 画面x = 図x*s + tx、画面y = -図y*s + ty
    this.fitScale = 1;
    this.entities = null; // 編集を当てはめた図形の並び(nullを含む)。未設定なら、原本をそのまま使う
    this.excluded = new Set(); // 選択中で、いま別に描いている図形の番号(通常の描画から外す)
    this.floating = null; // 選択中の図形: { entities, scene, xf }。変換をかけて描く
    this.batches = [];
    this.texts = [];
    this.pointers = new Map();
    this.raf = 0;
    this.tool = null; // 注釈・測定のツール(down/move/up/cancel/hover を持つ)。nullなら、指で動かすだけ
    this.toolPointerId = null;
    this.overlay = null; // 図面の上に、注釈などを描く関数 ({ ctx, view, dpr, width, height }) => void
    this.#bindEvents();
    new ResizeObserver(() => this.#resize()).observe(canvas);
    this.#resize();
  }

  /** 読み込んだ図面を表示する。 */
  setModel(model, hiddenLayers = new Set()) {
    this.model = model;
    this.entities = model.entities;
    this.excluded = new Set();
    this.floating = null;
    this.hiddenLayers = hiddenLayers;
    this.#rebuild();
    this.fit();
  }

  setHiddenLayers(set) {
    this.hiddenLayers = set;
    this.#rebuild();
    this.#schedule();
  }

  setDark(dark) {
    this.dark = dark;
    this.#rebuild();
    this.#schedule();
  }

  /** 図面全体が画面に収まる表示にする。 */
  fit() {
    const b = this.model?.bounds;
    const { width: w, height: h } = this.#cssSize();
    if (!b || w === 0 || h === 0) return;
    const margin = 12;
    const bw = Math.max(b.x1 - b.x0, 1e-6);
    const bh = Math.max(b.y1 - b.y0, 1e-6);
    const s = Math.min((w - margin * 2) / bw, (h - margin * 2) / bh);
    this.fitScale = s;
    this.view = {
      s,
      tx: (w - bw * s) / 2 - b.x0 * s,
      ty: (h + bh * s) / 2 + b.y0 * s,
    };
    this.#schedule();
  }

  /** 画面上の点(sx, sy)を中心に、倍率をfactor倍する。 */
  zoomAt(sx, sy, factor) {
    const v = this.view;
    const s = Math.min(Math.max(v.s * factor, this.fitScale * 0.5), this.fitScale * MAX_ZOOM_OVER_FIT);
    const k = s / v.s;
    this.view = { s, tx: sx - (sx - v.tx) * k, ty: sy - (sy - v.ty) * k };
    this.#schedule();
  }

  /** 編集を当てはめた図形の並びに差し替える(nullは消された図形)。 */
  setEntities(list) {
    this.entities = list;
    this.#rebuild();
    this.#schedule();
  }

  /** 選択中の図形を、通常の描画から外して、別に(変換をかけて)描く。indicesが空なら解除。 */
  setFloating(indices) {
    this.excluded = new Set(indices);
    this.floating = indices.length
      ? { entities: indices.map((i) => this.entities[i]).filter(Boolean), xf: null, scene: null }
      : null;
    this.#rebuild(); // 選択中の図形の描画データも、ここで作られる
    this.#schedule();
  }

  /** 選択中の図形にかける変換(ドラッグ中の見た目)。nullなら、そのまま。 */
  setFloatTransform(xf) {
    if (this.floating) this.floating.xf = xf;
    this.#schedule();
  }

  /** 注釈などを変えたあとに、描き直す。 */
  redraw() {
    this.#schedule();
  }

  /** 画面の点を図面の座標(用紙mm)に変換する。 */
  toWorld(sx, sy) {
    const v = this.view;
    return { x: (sx - v.tx) / v.s, y: (v.ty - sy) / v.s };
  }

  #cssSize() {
    const r = this.canvas.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }

  #resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.#cssSize();
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.#schedule();
  }

  #schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.#draw();
      this.onChange(this.view);
    });
  }

  /** 表示中のレイヤの図形を、色・太さ・線種ごとにまとめたPath2Dにする(拡大縮小のたびに作り直さない)。 */
  #rebuild() {
    const built = this.#build(this.dark, this.entities ?? this.model?.entities ?? [], this.excluded);
    this.batches = built.batches;
    this.texts = built.texts;
    if (this.floating) this.floating.scene = this.#build(this.dark, this.floating.entities, null);
  }

  /** 図形の並びから、色・太さ・線種ごとのPath2Dと、文字の一覧を作る。skipは、描かない図形の番号。 */
  #build(dark, entities, skip) {
    const batches = [];
    const texts = [];
    if (!this.model) return { batches, texts };
    const strokes = new Map();
    const fills = new Map();
    const strokeOf = (e) => {
      const lw = e.line_weight > 0 ? e.line_weight / 100 : 0;
      const key = `${e.color}|${lw}|${e.line_type}`;
      let b = strokes.get(key);
      if (!b) {
        b = { kind: "stroke", css: aciToCss(e.color, dark), lw, dash: dashFor(e.line_type), path: new Path2D() };
        strokes.set(key, b);
      }
      return b.path;
    };
    const fillOf = (e) => {
      let b = fills.get(e.color);
      if (!b) {
        b = { kind: "fill", css: aciToCss(e.color, dark), path: new Path2D() };
        fills.set(e.color, b);
      }
      return b.path;
    };
    for (let idx = 0; idx < entities.length; idx++) {
      const e = entities[idx];
      if (!e || (skip && skip.has(idx)) || this.hiddenLayers.has(e.layer)) continue;
      switch (e.type) {
        case "LINE": {
          const p = strokeOf(e);
          p.moveTo(e.x1, e.y1);
          p.lineTo(e.x2, e.y2);
          break;
        }
        case "ARC": {
          const p = strokeOf(e);
          const a0 = (e.start_angle * Math.PI) / 180;
          const a1 = (e.end_angle * Math.PI) / 180;
          p.moveTo(e.center_x + e.radius * Math.cos(a0), e.center_y + e.radius * Math.sin(a0));
          p.arc(e.center_x, e.center_y, e.radius, a0, a1, false);
          break;
        }
        case "CIRCLE": {
          const p = strokeOf(e);
          p.moveTo(e.center_x + e.radius, e.center_y);
          p.arc(e.center_x, e.center_y, e.radius, 0, Math.PI * 2);
          break;
        }
        case "SOLID": {
          // DXFのSOLIDは頂点の順が 1,2,4,3 で四角形になる
          const p = fillOf(e);
          p.moveTo(e.x1, e.y1);
          p.lineTo(e.x2, e.y2);
          p.lineTo(e.x4, e.y4);
          p.lineTo(e.x3, e.y3);
          p.closePath();
          break;
        }
        case "TEXT":
          if (e.content) {
            texts.push({
              x: e.x, y: e.y, ex: e.end_x, ey: e.end_y, h: e.height,
              rot: e.rotation ?? 0, content: e.content, css: aciToCss(e.color, dark),
            });
          }
          break;
        default:
          break;
      }
    }
    return { batches: [...fills.values(), ...strokes.values()], texts };
  }

  #draw() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.#cssSize();
    this.#renderScene(this.ctx, { view: this.view, dpr, width, height, dark: this.dark, scene: this });
    if (this.model && this.overlay) this.overlay({ ctx: this.ctx, view: this.view, dpr, width, height });
  }

  /**
   * 図面を、指定した大きさのcanvasに描く(PDF出力用)。画面の表示とは別に、白い紙・通常の色で描く。
   * @param {HTMLCanvasElement} canvas 描き込み先(widthとheightは呼び出し側で設定済み)
   */
  renderToCanvas(canvas, { bounds = this.model?.bounds, withOverlay = true, marginPx = null } = {}) {
    if (!this.model || !bounds) throw new Error("図面が開かれていません");
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const bw = Math.max(bounds.x1 - bounds.x0, 1e-6);
    const bh = Math.max(bounds.y1 - bounds.y0, 1e-6);
    const m = marginPx ?? Math.min(w, h) * 0.02;
    const s = Math.min((w - m * 2) / bw, (h - m * 2) / bh);
    const view = { s, tx: (w - bw * s) / 2 - bounds.x0 * s, ty: (h + bh * s) / 2 + bounds.y0 * s };
    const scene = this.#build(false, this.entities ?? this.model.entities, null);
    this.#renderScene(ctx, { view, dpr: 1, width: w, height: h, dark: false, scene });
    if (withOverlay && this.overlay) this.overlay({ ctx, view, dpr: 1, width: w, height: h, forExport: true });
    return view;
  }

  #renderScene(ctx, { view, dpr, width, height, dark, scene }) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = dark ? "#111111" : "#ffffff";
    ctx.fillRect(0, 0, Math.round(width * dpr), Math.round(height * dpr));
    if (!this.model) return;

    ctx.setTransform(dpr * view.s, 0, 0, -dpr * view.s, dpr * view.tx, dpr * view.ty);
    ctx.lineCap = "butt";
    ctx.lineJoin = "round";
    const minLine = MIN_LINE_PX / view.s;
    for (const b of scene.batches) {
      if (b.kind === "fill") {
        ctx.fillStyle = b.css;
        ctx.fill(b.path);
      } else {
        ctx.strokeStyle = b.css;
        ctx.lineWidth = Math.max(b.lw, minLine);
        ctx.setLineDash(b.dash ?? []);
        ctx.stroke(b.path);
      }
    }
    ctx.setLineDash([]);
    this.#drawTexts(ctx, scene.texts, { view, dpr, width, height });
    if (scene === this) this.#drawFloating(ctx, { view, dpr, width, height });
  }

  /** 選択中の図形を、変換(移動・回転・拡大縮小)をかけて描く。 */
  #drawFloating(ctx, { view, dpr, width, height }) {
    const f = this.floating;
    if (!f?.scene) return;
    const xf = f.xf;
    const minLine = MIN_LINE_PX / view.s;
    ctx.setTransform(dpr * view.s, 0, 0, -dpr * view.s, dpr * view.tx, dpr * view.ty);
    ctx.save();
    if (xf) {
      ctx.translate(xf.cx + xf.dx, xf.cy + xf.dy);
      ctx.rotate(xf.theta);
      ctx.scale(xf.s, xf.s);
      ctx.translate(-xf.cx, -xf.cy);
    }
    const k = xf ? xf.s : 1;
    for (const b of f.scene.batches) {
      if (b.kind === "fill") {
        ctx.fillStyle = b.css;
        ctx.fill(b.path);
      } else {
        ctx.strokeStyle = b.css;
        ctx.lineWidth = Math.max(b.lw, minLine) / k;
        ctx.setLineDash((b.dash ?? []).map((d) => d));
        ctx.stroke(b.path);
      }
    }
    ctx.restore();
    ctx.setLineDash([]);
    const texts = xf
      ? f.scene.texts.map((t) => {
          const m = transformEntity({ type: "TEXT", x: t.x, y: t.y, end_x: t.ex, end_y: t.ey, height: t.h, rotation: t.rot }, xf);
          return { ...t, x: m.x, y: m.y, ex: m.end_x, ey: m.end_y, h: m.height, rot: m.rotation };
        })
      : f.scene.texts;
    this.#drawTexts(ctx, texts, { view, dpr, width, height });
  }

  #drawTexts(ctx, texts, { view, dpr, width: cw, height: ch }) {
    ctx.textBaseline = "alphabetic";
    for (const t of texts) {
      const px = t.h * view.s;
      if (px < MIN_TEXT_PX) continue;
      const sx = t.x * view.s + view.tx;
      const sy = -t.y * view.s + view.ty;
      if (sx < -px * 40 || sx > cw + px * 40 || sy < -px * 40 || sy > ch + px * 40) continue;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.translate(sx, sy);
      ctx.rotate((-t.rot * Math.PI) / 180);
      ctx.font = `${px}px "BIZ UDPGothic", "Noto Sans JP", "Yu Gothic", sans-serif`;
      ctx.fillStyle = t.css;
      // JWWの文字は幅が決まっているので、横方向を伸縮して合わせる
      const target = Math.hypot(t.ex - t.x, t.ey - t.y) * view.s;
      const natural = ctx.measureText(t.content).width;
      if (target > 0 && natural > 0) ctx.scale(Math.min(Math.max(target / natural, 0.3), 3), 1);
      ctx.fillText(t.content, 0, 0);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  #bindEvents() {
    const c = this.canvas;
    c.style.touchAction = "none";
    const local = (ev) => {
      const r = c.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    const toolPoint = (p) => ({ sx: p.x, sy: p.y, world: this.toWorld(p.x, p.y) });
    c.addEventListener("pointerdown", (ev) => {
      c.setPointerCapture(ev.pointerId);
      const p = local(ev);
      this.pointers.set(ev.pointerId, p);
      if (this.tool && this.pointers.size === 1) {
        this.toolPointerId = ev.pointerId;
        this.tool.down(toolPoint(p));
        this.#schedule();
      } else if (this.pointers.size >= 2 && this.toolPointerId !== null) {
        this.tool?.abort?.();
        this.toolPointerId = null;
      }
    });
    c.addEventListener("pointermove", (ev) => {
      const prev = this.pointers.get(ev.pointerId);
      const cur = local(ev);
      if (!prev) {
        if (this.tool?.hover && ev.pointerType === "mouse") { this.tool.hover(toolPoint(cur)); this.#schedule(); }
        return;
      }
      if (ev.pointerId === this.toolPointerId && this.pointers.size === 1) {
        this.pointers.set(ev.pointerId, cur);
        this.tool.move(toolPoint(cur));
        this.#schedule();
        return;
      }
      if (this.pointers.size === 1 && !this.tool) {
        this.view = { ...this.view, tx: this.view.tx + cur.x - prev.x, ty: this.view.ty + cur.y - prev.y };
      } else if (this.pointers.size === 2) {
        const other = [...this.pointers.entries()].find(([id]) => id !== ev.pointerId)[1];
        const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
        const d1 = Math.hypot(cur.x - other.x, cur.y - other.y);
        const m0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
        const m1 = { x: (cur.x + other.x) / 2, y: (cur.y + other.y) / 2 };
        this.view = { ...this.view, tx: this.view.tx + m1.x - m0.x, ty: this.view.ty + m1.y - m0.y };
        if (d0 > 0 && d1 > 0) this.zoomAt(m1.x, m1.y, d1 / d0);
      }
      this.pointers.set(ev.pointerId, cur);
      this.#schedule();
    });
    const end = (ev, cancelled) => {
      const p = local(ev);
      if (ev.pointerId === this.toolPointerId) {
        this.toolPointerId = null;
        if (cancelled) this.tool?.abort?.();
        else this.tool?.up(toolPoint(p));
        this.#schedule();
      }
      this.pointers.delete(ev.pointerId);
    };
    c.addEventListener("pointerup", (ev) => end(ev, false));
    c.addEventListener("pointercancel", (ev) => end(ev, true));
    c.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const p = local(ev);
        this.zoomAt(p.x, p.y, Math.exp(-ev.deltaY * 0.0015));
      },
      { passive: false }
    );
    c.addEventListener("dblclick", (ev) => {
      if (this.tool) return; // ツールを使っているときは、ダブルタップで拡大しない
      const p = local(ev);
      this.zoomAt(p.x, p.y, 2);
    });
  }
}
