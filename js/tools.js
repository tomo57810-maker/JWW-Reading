// 注釈・測定のツール。画面の指(またはマウス)の動きを受け取り、注釈を作る。
import { hitTest } from "./annotations.js";
import { distance, polylineLength } from "./geometry.js";

const SNAP_PX = 14; // 画面上で、この距離以内の端点に吸着する
const TAP_MOVE_PX = 10; // 指がこれ以上動いたら、「タップ」ではなく「ドラッグ」とみなす(赤ペン以外では、離した位置を採用)
const PEN_MIN_STEP_PX = 2;

export const MODES = ["move", "dim", "area", "route", "pen", "text", "erase"];

export class ToolController {
  /**
   * @param {object} deps
   * @param {import("./viewer.js").Viewer} deps.viewer
   * @param {import("./annotations.js").AnnotationStore} deps.store
   * @param {() => number} deps.getScale 縮尺の分母(例: 100)
   * @param {() => import("./geometry.js").SnapIndex | null} deps.getSnap
   * @param {(at: {x:number,y:number}) => Promise<string | null>} deps.askText コメントの文字を入力してもらう
   * @param {() => void} [deps.onState] モードや作図中の状態が変わったとき
   */
  constructor({ viewer, store, getScale, getSnap, askText, onState = () => {} }) {
    this.viewer = viewer;
    this.store = store;
    this.getScale = getScale;
    this.getSnap = getSnap;
    this.askText = askText;
    this.onState = onState;
    this.mode = "move";
    this.draft = null; // { item: {kind, points, scale}, cursor }
    this.snap = null; // いま吸着している点(表示用)
    this.pen = null; // 赤ペンの書き途中
    this.downAt = null;
  }

  setMode(mode) {
    if (!MODES.includes(mode)) return;
    this.cancel();
    this.mode = mode;
    this.viewer.tool = mode === "move" ? null : this;
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

  /** 作図中の線を取り消す。 */
  cancel() {
    this.draft = null;
    this.pen = null;
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

  down(point) {
    this.downAt = point;
    switch (this.mode) {
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
        if (!last || distance(last, p) * this.viewer.view.s > 3) pts.push(p); // 同じ場所の二重タップは無視
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
        const text = await this.askText(at);
        if (text?.trim()) this.store.add({ kind: "text", at, text: text.trim() });
        this.onState();
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
