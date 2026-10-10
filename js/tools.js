// 注釈・測定のツール。画面の指(またはマウス)の動きを受け取り、注釈を作る。
import { hitTest } from "./annotations.js";
import { distance, polylineLength } from "./geometry.js";

const SNAP_PX = 14; // 画面上で、この距離以内の端点に吸着する
const TAP_MOVE_PX = 10; // 指がこれ以上動いたら、「タップ」ではなく「ドラッグ」とみなす(赤ペン以外では、離した位置を採用)
const PEN_MIN_STEP_PX = 2;

export const MODES = ["move", "select", "dim", "area", "route", "pen", "text", "erase"];

export class ToolController {
  /**
   * @param {object} deps
   * @param {import("./viewer.js").Viewer} deps.viewer
   * @param {import("./annotations.js").AnnotationStore} deps.store
   * @param {() => number} deps.getScale 縮尺の分母(例: 100)
   * @param {() => import("./geometry.js").SnapIndex | null} deps.getSnap
   * @param {(at: {x:number,y:number}, initial?: string) => Promise<string | null>} deps.askText コメントの文字を入力してもらう
   * @param {(id: string) => {x:number,y:number,w:number,h:number} | null} [deps.getTextRect] 画面に描いたコメントの四角(画面px)。選ぶときの当たり判定に使う
   * @param {() => void} [deps.onState] モードや作図中の状態が変わったとき
   */
  constructor({ viewer, store, getScale, getSnap, askText, getTextRect = () => null, onState = () => {} }) {
    this.viewer = viewer;
    this.store = store;
    this.getScale = getScale;
    this.getSnap = getSnap;
    this.askText = askText;
    this.getTextRect = getTextRect;
    this.onState = onState;
    this.mode = "move";
    this.draft = null; // { item: {kind, points, scale}, cursor }
    this.snap = null; // いま吸着している点(表示用)
    this.pen = null; // 赤ペンの書き途中
    this.downAt = null;
    this.selectedId = null; // 選んでいる注釈
    this.drag = null; // 移動中: { item, start, orig, moved }
  }

  get selected() {
    return this.store.items.find((i) => i.id === this.selectedId) ?? null;
  }

  setMode(mode) {
    if (!MODES.includes(mode)) return;
    this.cancel();
    this.selectedId = null;
    this.mode = mode;
    this.viewer.tool = mode === "move" ? null : this;
    this.viewer.toolPointerId = null;
    this.viewer.toolPointerId = null;
    this.snap = null;
    this.onState();
    this.viewer.redraw();
  }

  /** 作図中の面積・ルートを確定する。 */
  finish() {
    const d = this.draft;
    if (!d) return false;
    const need = d.item.kind === "area" ? 3 : 2;
    if (d.item.points.length < need) return false;
    this.store.add({ ...d.item });
    this.draft = null;
    this.onState();
    this.viewer.redraw();
    return true;
  }

  /** 2本目の指が触れたとき: 書きかけの赤ペンの線や、注釈の移動だけをやめる。点を置いた作図中の線は残す。 */
  abort() {
    if (this.pen) {
      this.pen = null;
      this.draft = null;
    }
    if (this.drag) this.#endDrag();
    this.downAt = null;
    this.onState();
    this.viewer.redraw();
  }

  /** 作図中の線を、すべて取り消す(「取消」ボタン)。 */
  cancel() {
    this.draft = null;
    this.pen = null;
    this.drag = null;
    this.downAt = null;
    this.snap = null;
    this.onState();
    this.viewer.redraw();
  }

  /** 作図中なら、最後の点を取り消す。作図中でなければ、最後の注釈を取り消す。 */
  undo() {
    if (this.draft && this.draft.item.kind !== "pen" && this.draft.item.points.length > 0) {
      this.draft.item.points.pop();
      if (this.draft.item.points.length === 0) this.draft = null;
      this.onState();
      this.viewer.redraw();
      return;
    }
    this.store.undo();
  }

  get drafting() {
    return Boolean(this.draft) && this.draft.item.kind !== "pen";
  }

  get draftInfo() {
    const d = this.draft;
    if (!d) return null;
    return { kind: d.item.kind, count: d.item.points.length, length: polylineLength(d.item.points) };
  }

  /** 画面上の吸着の範囲を、用紙mmに直して、近い端点を探す。 */
  #snapPoint(point) {
    const index = this.getSnap();
    const tol = SNAP_PX / this.viewer.view.s;
    const hit = index?.nearest(point.world, tol) ?? null;
    return hit ?? point.world;
  }

  hover(point) {
    this.snap = this.#nearEndpoint(point);
    if (this.draft) this.draft.cursor = this.snap ?? point.world;
  }

  #nearEndpoint(point) {
    const index = this.getSnap();
    return index?.nearest(point.world, SNAP_PX / this.viewer.view.s) ?? null;
  }

  /** 画面の点にある注釈を探す。コメントは描いた四角、それ以外は線からの距離で判定する。 */
  #pick(point) {
    const tol = 8;
    for (const item of [...this.store.items].reverse()) {
      if (item.kind !== "text") continue;
      const r = this.getTextRect(item.id);
      if (r && point.sx >= r.x - tol && point.sx <= r.x + r.w + tol && point.sy >= r.y - tol && point.sy <= r.y + r.h + tol) return item;
    }
    return hitTest(this.store.items.filter((i) => i.kind !== "text"), point.world, (SNAP_PX * 1.5) / this.viewer.view.s);
  }

  #endDrag() {
    const d = this.drag;
    this.drag = null;
    if (d?.moved) this.store.touch();
  }

  /** 選んだ注釈を、少しずらして複製し、複製を選ぶ。 */
  copySelected() {
    const src = this.selected;
    if (!src) return null;
    const off = 14 / this.viewer.view.s; // 画面で14pxぶん、右下にずらす
    const clone = JSON.parse(JSON.stringify(src));
    delete clone.id;
    delete clone.createdAt;
    if (clone.at) clone.at = { x: clone.at.x + off, y: clone.at.y - off };
    else clone.points = clone.points.map((p) => ({ x: p.x + off, y: p.y - off }));
    const added = this.store.add(clone);
    this.selectedId = added.id;
    this.onState();
    this.viewer.redraw();
    return added;
  }

  deleteSelected() {
    const sel = this.selected;
    if (!sel) return;
    this.store.remove(sel.id);
    this.selectedId = null;
    this.onState();
    this.viewer.redraw();
  }

  /** 選んだコメントの文字を直す。 */
  async editSelectedText() {
    const sel = this.selected;
    if (!sel || sel.kind !== "text") return;
    const text = await this.askText(sel.at, sel.text);
    if (text?.trim()) {
      sel.text = text.trim();
      this.store.touch();
    }
    this.onState();
    this.viewer.redraw();
  }

  down(point) {
    this.downAt = point;
    switch (this.mode) {
      case "select": {
        const hit = this.#pick(point);
        this.selectedId = hit?.id ?? null;
        this.drag = hit
          ? { item: hit, start: point.world, orig: hit.at ? { at: { ...hit.at } } : { points: hit.points.map((p) => ({ ...p })) }, moved: false }
          : null;
        this.onState();
        break;
      }
      case "pen":
        this.pen = { kind: "pen", points: [point.world], scale: this.getScale() };
        this.draft = { item: this.pen, cursor: null };
        this.onState();
        break;
      case "dim":
      case "area":
      case "route":
        this.snap = this.#nearEndpoint(point);
        if (this.draft) this.draft.cursor = this.snap ?? point.world;
        break;
      default:
        break;
    }
  }

  move(point) {
    switch (this.mode) {
      case "select": {
        const d = this.drag;
        if (!d) break;
        const dx = point.world.x - d.start.x;
        const dy = point.world.y - d.start.y;
        if (!d.moved && Math.hypot(dx, dy) * this.viewer.view.s < 4) break; // 指がわずかに動いただけでは動かさない
        d.moved = true;
        if (d.orig.at) d.item.at = { x: d.orig.at.x + dx, y: d.orig.at.y + dy };
        else d.item.points = d.orig.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
        break;
      }
      case "pen": {
        if (!this.pen) break;
        const last = this.pen.points.at(-1);
        if (distance(last, point.world) * this.viewer.view.s >= PEN_MIN_STEP_PX) this.pen.points.push(point.world);
        break;
      }
      case "dim":
      case "area":
      case "route":
        // 指を動かしている間も、吸着の位置と途中の長さを見せる(離した位置が採用される)
        this.snap = this.#nearEndpoint(point);
        if (this.draft) this.draft.cursor = this.snap ?? point.world;
        break;
      default:
        break;
    }
  }

  async up(point) {
    const moved = this.downAt ? Math.hypot(point.sx - this.downAt.sx, point.sy - this.downAt.sy) : 0;
    this.downAt = null;
    switch (this.mode) {
      case "select":
        this.#endDrag();
        this.onState();
        break;
      case "pen": {
        const pen = this.pen;
        this.pen = null;
        this.draft = null;
        if (pen && pen.points.length >= 2) this.store.add(pen);
        this.onState();
        break;
      }
      case "dim":
      case "area":
      case "route": {
        const p = this.#snapPoint(point);
        if (!this.draft) {
          this.draft = { item: { kind: this.mode, points: [], scale: this.getScale() }, cursor: null };
        }
        const pts = this.draft.item.points;
        const last = pts.at(-1);
        if (!last || distance(last, p) * this.viewer.view.s > 3) pts.push({ x: p.x, y: p.y }); // 同じ場所の二重タップは無視(吸着用の点そのものは持たない)
        this.snap = null;
        this.draft.cursor = null;
        if (this.mode === "dim" && pts.length === 2) {
          this.store.add({ ...this.draft.item });
          this.draft = null;
        }
        this.onState();
        break;
      }
      case "text": {
        if (moved > TAP_MOVE_PX) break;
        const at = point.world;
        const text = await this.askText(at, "");
        if (text?.trim()) {
          const added = this.store.add({ kind: "text", at, text: text.trim() });
          this.setMode("select"); // 置いたコメントを、すぐ動かしたり複製したりできるようにする
          this.selectedId = added.id;
          this.onState();
        }
        break;
      }
      case "erase": {
        if (moved > TAP_MOVE_PX) break;
        const hit = hitTest(this.store.items, point.world, SNAP_PX * 1.5 / this.viewer.view.s);
        if (hit) this.store.remove(hit.id);
        this.onState();
        break;
      }
      default:
        break;
    }
    this.viewer.redraw();
  }
}
