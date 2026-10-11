// 注釈・測定のツール。画面の指(またはマウス)の動きを受け取り、注釈を作る。
import { hitTest } from "./annotations.js";
import { distance, polylineLength } from "./geometry.js";
import { pickEntity } from "./edits.js";
import { lineTypeLabel } from "./drawing.js";
import { DEFAULT_TEXT_ATTR, makeTextEntities } from "./text.js";

const SNAP_PX = 14; // 画面上で、この距離以内の端点に吸着する
const TAP_MOVE_PX = 10; // 指がこれ以上動いたら、「タップ」ではなく「ドラッグ」とみなす(赤ペン以外では、離した位置を採用)
const PEN_MIN_STEP_PX = 2;

export const MODES = ["move", "select", "dim", "area", "route", "wall", "mark", "line", "rect", "circle", "arrow", "ctext", "pen", "text", "erase"];
export const MEASURE_MODES = ["dim", "area", "route"]; // 「測定」にまとめるモード
export const SHAPE_MODES = ["line", "rect", "circle", "arrow"]; // 図面に図形(線・矩形・円・矢印)を描き足すモード
const ARROW_HEAD_MM = 3; // 矢印の頭の長さ(用紙mm)。短い矢印では、全長の半分まで
const ARROW_HEAD_WIDTH = 0.3; // 矢印の頭の半幅(頭の長さに対する比)
export const ATTR_MODES = [...SHAPE_MODES, "ctext"]; // 「属性取得」ができるモード(ctext=図面に文字を描き足す)
const LINE_KINDS = ["LINE", "ARC", "CIRCLE"]; // 線の属性を取れる図形

export class ToolController {
  /**
   * @param {object} deps
   * @param {import("./viewer.js").Viewer} deps.viewer
   * @param {import("./annotations.js").AnnotationStore} deps.store
   * @param {() => number} deps.getScale 縮尺の分母(例: 100)
   * @param {() => import("./geometry.js").SnapIndex | null} deps.getSnap
   * @param {(at: {x:number,y:number}, initial?: string) => Promise<string | null>} deps.askText コメントの文字を入力してもらう
   * @param {(title: string, hint?: string) => Promise<{dx:number, dy:number} | null>} [deps.askOffset] 横・縦の距離(実寸mm)を入力してもらう
   * @param {() => {layer?: string, color?: number}} [deps.getDrawStyle] 描き足す図形(線・矩形・円)のレイヤと色
   * @param {(id: string) => {x:number,y:number,w:number,h:number} | null} [deps.getTextRect] 画面に描いたコメントの四角(画面px)。選ぶときの当たり判定に使う
   * @param {(opts: {initial?: string, height: number}) => Promise<{text: string, height: number} | null>} [deps.askDrawText] 図面に描く文字(内容と高さ)を入力してもらう
   * @param {(message: string) => void} [deps.onNotice] 利用者に一言伝えたいとき(属性を取得した、など)
   * @param {() => {height:number, thick:number, z0:number, align:string}} [deps.getWallParams] 壁の高さ・厚み・下端・位置(実寸mm)
   * @param {(wall: {path: number[][], closed: boolean}) => void} [deps.onWall] 壁をなぞり終えたとき(3Dの部品にする)
   * @param {() => void} [deps.onState] モードや作図中の状態が変わったとき
   */
  constructor({ viewer, store, getScale, getSnap, askText, askDrawText = null, askOffset = async () => null, getTextRect = () => null, objectTool = null, getDrawStyle = () => ({}), getWallParams = () => ({ height: 2700, thick: 150, z0: 0, align: "center" }), onWall = () => {}, onNotice = () => {}, onState = () => {} }) {
    this.viewer = viewer;
    this.store = store;
    this.getScale = getScale;
    this.getSnap = getSnap;
    this.askText = askText;
    this.askDrawText = askDrawText;
    this.onNotice = onNotice;
    this.getWallParams = getWallParams;
    this.onWall = onWall;
    this.askOffset = askOffset;
    this.getTextRect = getTextRect;
    this.objectTool = objectTool; // 図面の図形そのものを編集するツール(「選択」モードで、注釈より下の図形を扱う)
    this.sub = null; // 選択モードで、いまの指の操作を預けているツール(図面の図形の操作中だけ)
    this.getDrawStyle = getDrawStyle; // 描き足す図形の、レイヤ・色など
    this.onState = onState;
    this.mode = "move";
    this.draft = null; // { item: {kind, points, scale}, cursor }
    this.snap = null; // いま吸着している点(表示用)
    this.pen = null; // 赤ペンの書き途中
    this.downAt = null;
    this.selectedId = null; // 選んでいる注釈
    this.drag = null; // 移動中: { item, start, orig, moved }
    this.lineAttr = null; // 属性取得した線の属性 { layer, color, line_type, line_weight }。nullなら既定(書込レイヤ・実線)
    this.textAttr = null; // 属性取得した文字の属性 { layer, color, height, width_factor, style }。nullなら既定
    this.picking = false; // 「属性取得」の待ち(次にタップした図形から属性を取る)
  }

  get selected() {
    return this.store.items.find((i) => i.id === this.selectedId) ?? null;
  }

  setMode(mode) {
    if (!MODES.includes(mode)) return;
    this.cancel();
    this.selectedId = null;
    this.picking = false;
    this.sub = null;
    if (this.mode === "select") this.objectTool?.clearSelection(); // 選択モードを出るとき、選択と途中の操作を解除する
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
    if (d.item.kind === "wall") {
      this.onWall({ path: d.item.points.map((p) => [p.x, p.y]), closed: Boolean(d.item.closed) });
      this.draft = null;
      this.onState();
      this.viewer.redraw();
      return true;
    }
    this.store.add({ ...d.item });
    this.draft = null;
    this.onState();
    this.viewer.redraw();
    return true;
  }

  /** 2本目の指が触れたとき: 書きかけの赤ペンの線や、注釈の移動だけをやめる。点を置いた作図中の線は残す。 */
  abort() {
    if (this.sub) {
      this.sub.abort();
      this.sub = null;
    }
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

  /** 描き足す線のもとになる属性(レイヤ・色・線種・太さ)。属性取得していれば、その属性。 */
  #shapeBase() {
    const a = this.lineAttr;
    if (a) return { layer: a.layer, color: a.color, line_type: a.line_type, line_weight: a.line_weight };
    const st = this.getDrawStyle() ?? {};
    return { layer: st.layer ?? "0", color: st.color ?? 7, line_type: "CONTINUOUS", line_weight: -3 };
  }

  /** 描き足す文字の属性。属性取得していれば、その属性。なければ書込レイヤ・既定の大きさ。 */
  get textStyle() {
    if (this.textAttr) return { ...this.textAttr };
    const st = this.getDrawStyle() ?? {};
    return { layer: st.layer ?? "0", color: st.color ?? 7, ...DEFAULT_TEXT_ATTR };
  }

  /** 「属性取得」を始める/やめる(切り替え)。 */
  togglePick() {
    if (!ATTR_MODES.includes(this.mode)) return;
    this.picking = !this.picking;
    this.onState();
  }

  /** 取得した属性を捨てて、既定(書込レイヤ・実線・標準の文字)に戻す。 */
  resetAttr() {
    this.lineAttr = null;
    this.textAttr = null;
    this.picking = false;
    this.onState();
  }

  /** いまの属性を、画面に出す短い文章にする。 */
  attrSummary() {
    if (this.mode === "ctext") {
      const t = this.textStyle;
      return `高さ${+t.height.toFixed(2)}mm 幅${+t.width_factor.toFixed(2)} 文字種${t.style}`;
    }
    const a = this.#shapeBase();
    const w = a.line_weight > 0 ? `${a.line_weight / 100}mm` : "既定";
    return `${lineTypeLabel(a.line_type)} 色${a.color} 太さ${w}`;
  }

  get currentColor() {
    return this.mode === "ctext" ? this.textStyle.color : this.#shapeBase().color;
  }

  /** タップした図形から属性を取る。取れたら true。 */
  #pickAttr(point) {
    const entities = this.objectTool?.edits?.entities ?? [];
    const hidden = this.viewer.hiddenLayers;
    const wantText = this.mode === "ctext";
    const ok = (e) => !hidden?.has(e.layer) && (wantText ? e.type === "TEXT" : LINE_KINDS.includes(e.type));
    const tol = (SNAP_PX * 1.2) / this.viewer.view.s;
    const i = pickEntity(entities, point.world.x, point.world.y, tol, ok);
    if (i < 0) {
      this.onNotice(wantText ? "文字が見つかりません。取りたい文字をタップしてください" : "線が見つかりません。取りたい線をタップしてください");
      return false;
    }
    const e = entities[i];
    if (wantText) {
      this.textAttr = {
        layer: e.layer, color: e.color ?? 7, style: e.style ?? DEFAULT_TEXT_ATTR.style,
        height: e.height > 0 ? e.height : DEFAULT_TEXT_ATTR.height,
        width_factor: e.width_factor > 0 ? e.width_factor : DEFAULT_TEXT_ATTR.width_factor,
      };
    } else {
      this.lineAttr = { layer: e.layer, color: e.color ?? 7, line_type: e.line_type ?? "CONTINUOUS", line_weight: e.line_weight ?? -3 };
    }
    this.picking = false;
    this.onNotice(`属性を取得しました(${this.attrSummary()})`);
    return true;
  }

  /** 2点から、線・矩形(4本の線)・円を作って、図面に描き足す。 */
  #commitShape(a, b) {
    const base = this.#shapeBase();
    let entities;
    if (this.mode === "line") {
      entities = [{ type: "LINE", ...base, x1: a.x, y1: a.y, x2: b.x, y2: b.y }];
    } else if (this.mode === "arrow") {
      const len = distance(a, b);
      if (len <= 0) return;
      const head = Math.min(ARROW_HEAD_MM, len / 2);
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      const bx = b.x - ux * head, by = b.y - uy * head; // 頭の根元
      const hw = head * ARROW_HEAD_WIDTH;
      entities = [
        { type: "LINE", ...base, x1: a.x, y1: a.y, x2: bx, y2: by },
        // 頭は塗りつぶしの三角形(SOLIDは、頂点1・2・4・3の順に結ぶ。3と4を同じ点にして三角形にする)
        { type: "SOLID", ...base, x1: b.x, y1: b.y, x2: bx - uy * hw, y2: by + ux * hw, x3: bx + uy * hw, y3: by - ux * hw, x4: bx + uy * hw, y4: by - ux * hw },
      ];
    } else if (this.mode === "rect") {
      const [x0, x1] = [a.x, b.x];
      const [y0, y1] = [a.y, b.y];
      if (x0 === x1 || y0 === y1) return;
      entities = [
        { type: "LINE", ...base, x1: x0, y1: y0, x2: x1, y2: y0 },
        { type: "LINE", ...base, x1: x1, y1: y0, x2: x1, y2: y1 },
        { type: "LINE", ...base, x1: x1, y1: y1, x2: x0, y2: y1 },
        { type: "LINE", ...base, x1: x0, y1: y1, x2: x0, y2: y0 },
      ];
    } else {
      const radius = distance(a, b);
      if (radius <= 0) return;
      entities = [{ type: "CIRCLE", ...base, center_x: a.x, center_y: a.y, radius }];
    }
    this.objectTool?.addEntities(entities);
    this.draft = null;
  }

  /** 1点目を置いたあと、数値(実寸mm)で2点目を決める。矩形: 横・縦 / 円: 半径 / 線: 横・縦。 */
  async askShapeNumbers() {
    const d = this.draft;
    if (!d || !SHAPE_MODES.includes(d.item.kind) || d.item.points.length !== 1) return;
    const a = d.item.points[0];
    const scale = this.getScale();
    if (d.item.kind === "circle") {
      const r = await this.askOffset("円の半径(実寸mm)", "中心(いまタップした点)から、何mmの半径で描きますか。", { single: "半径" });
      if (!r || !(r.dx > 0)) return;
      this.#commitShape(a, { x: a.x + r.dx / scale, y: a.y });
    } else {
      const title = d.item.kind === "rect" ? "矩形の大きさ(実寸mm)" : d.item.kind === "arrow" ? "矢印の長さ(実寸mm)" : "線の長さ(実寸mm)";
      const r = await this.askOffset(title, "1点目から、横(→が+)・縦(↑が+)に何mmですか。例: 流しなら 横1200・縦600。");
      if (!r) return;
      this.#commitShape(a, { x: a.x + r.dx / scale, y: a.y + r.dy / scale });
    }
    this.snap = null;
    this.onState();
    this.viewer.redraw();
  }

  /** 作図中の点を1つ取り消す。取り消せたら true。 */
  undoDraft() {
    if (this.draft && this.draft.item.kind !== "pen" && this.draft.item.points.length > 0) {
      this.draft.item.points.pop();
      if (this.draft.item.points.length === 0) this.draft = null;
      this.onState();
      this.viewer.redraw();
      return true;
    }
    return false;
  }

  /** 作図中なら、最後の点を取り消す。作図中でなければ、直前の操作(図形モードでは図形の編集、それ以外は注釈)を取り消す。 */
  undo() {
    if (this.undoDraft()) return;
    if (this.mode === "select" && this.objectTool?.undo()) {
      this.onState();
      return;
    }
    this.store.undo();
  }

  get drafting() {
    return Boolean(this.draft) && this.draft.item.kind !== "pen" && !SHAPE_MODES.includes(this.draft.item.kind);
  }

  /** 線・矩形・円の作図中か(1点目を置いたあと)。 */
  get shapeDrafting() {
    return Boolean(this.draft) && SHAPE_MODES.includes(this.draft.item.kind);
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
    if (this.mode === "select") return;
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
      this.store.checkpoint();
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
        const ot = this.objectTool;
        // 基点移動・伸縮の途中や、選択中の図形の角・○の取っ手は、図面の図形の操作。それ以外は、まず注釈(コメント・基準点など)を探す
        const forObject = ot && (ot.baseMove || ot.stretch || (ot.hasSelection && ot.hitsCornerHandle(point)));
        const hit = forObject ? null : this.#pick(point);
        if (ot && !hit) {
          this.selectedId = null;
          this.drag = null;
          this.sub = ot;
          ot.down(point);
          this.onState();
          break;
        }
        if (ot?.hasSelection) ot.clearSelection();
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
      case "wall":
      case "mark":
      case "line":
      case "rect":
      case "circle":
      case "arrow":
      case "ctext":
        this.snap = this.#nearEndpoint(point);
        if (this.draft) this.draft.cursor = this.snap ?? point.world;
        break;
      default:
        break;
    }
  }

  move(point) {
    if (this.sub) {
      this.sub.move(point);
      this.viewer.redraw();
      return;
    }
    switch (this.mode) {
      case "select": {
        const d = this.drag;
        if (!d) break;
        const dx = point.world.x - d.start.x;
        const dy = point.world.y - d.start.y;
        if (!d.moved && Math.hypot(dx, dy) * this.viewer.view.s < 4) break; // 指がわずかに動いただけでは動かさない
        if (!d.moved) this.store.checkpoint(); // 「戻す」で、移動前に戻れるようにする
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
      case "wall":
      case "mark":
      case "line":
      case "rect":
      case "circle":
      case "arrow":
      case "ctext":
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
    if (this.sub) {
      const sub = this.sub;
      this.sub = null;
      sub.up(point);
      this.onState();
      this.viewer.redraw();
      return;
    }
    if (this.picking && ATTR_MODES.includes(this.mode)) {
      // 属性取得の待ち: 図形をタップしたら属性を取る(線や文字は、置かない)
      this.snap = null;
      if (moved <= TAP_MOVE_PX * 2) this.#pickAttr(point);
      this.onState();
      this.viewer.redraw();
      return;
    }
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
      case "route":
      case "wall": {
        const p = this.#snapPoint(point);
        if (!this.draft) {
          const item = { kind: this.mode, points: [], scale: this.getScale() };
          if (this.mode === "wall") item.thick = this.getWallParams().thick; // 作図中の太さの表示に使う
          this.draft = { item, cursor: null };
        }
        const pts = this.draft.item.points;
        // 壁: 最初の点にもう一度触れると、輪をつないで(閉じて)完了する
        if (this.mode === "wall" && pts.length >= 3 && distance(pts[0], p) * this.viewer.view.s <= SNAP_PX * 1.2) {
          this.draft.item.closed = true;
          this.snap = null;
          this.finish();
          break;
        }
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
      case "line":
      case "rect":
      case "circle":
      case "arrow": {
        const p = this.#snapPoint(point);
        if (!this.draft) this.draft = { item: { kind: this.mode, points: [], scale: this.getScale() }, cursor: null };
        const pts = this.draft.item.points;
        const last = pts.at(-1);
        if (!last || distance(last, p) * this.viewer.view.s > 3) pts.push({ x: p.x, y: p.y });
        this.snap = null;
        this.draft.cursor = null;
        if (pts.length === 2) this.#commitShape(pts[0], pts[1]);
        this.onState();
        break;
      }
      case "ctext": {
        if (moved > TAP_MOVE_PX) break;
        const at = this.#snapPoint(point);
        const cur = this.textStyle;
        const r = this.askDrawText ? await this.askDrawText({ initial: "", height: cur.height }) : { text: await this.askText(at, ""), height: cur.height };
        this.snap = null;
        if (!r?.text?.trim()) break;
        const attr = { ...cur, height: r.height > 0 ? r.height : cur.height };
        if (this.textAttr || attr.height !== cur.height) this.textAttr = attr; // 入力した高さは、次の文字にも引き継ぐ
        this.objectTool?.addEntities(makeTextEntities(r.text, at, attr));
        this.onState();
        break;
      }
      case "mark": {
        if (moved > TAP_MOVE_PX * 2) break;
        const base = this.#snapPoint(point);
        const scale = this.getScale();
        const r = await this.askOffset("基準点を打つ", "基点(いまタップした点)から、横(→が+)・縦(↑が+)に、実寸で何mm離れた所に打ちますか。0・0なら、基点そのものに打ちます。");
        this.snap = null;
        if (!r) break;
        const at = { x: base.x + r.dx / scale, y: base.y + r.dy / scale };
        const note = [r.dx ? `横${r.dx}` : "", r.dy ? `縦${r.dy}` : ""].filter(Boolean).join(" ");
        this.store.add({ kind: "mark", at, ...(note ? { note } : {}) });
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
        const hit = hitTest(this.store.items, point.world, (SNAP_PX * 1.6) / this.viewer.view.s); // 指で押す位置のずれを見込んで、広めに判定する
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
