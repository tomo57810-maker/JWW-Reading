// 測定・注釈・図形の編集・書き出し・保存の画面まわり。図面を開いたとき onOpened() を呼ぶ。
import { AnnotationStore } from "./annotations.js";
import { drawAnnotations } from "./annotation-render.js";
import { SnapIndex } from "./geometry.js";
import { ToolController, MEASURE_MODES, SHAPE_MODES, ATTR_MODES } from "./tools.js";
import { aciToCss } from "./aci.js";
import { EditStore } from "./edits.js";
import { ObjectTool } from "./object-tool.js";
import { makeJpegPdf } from "./pdf.js";
import { buildDxf } from "./dxf-export.js";
import { PartStore, PART_KINDS, buildScene, describePart, isPartSource } from "./parts3d.js";
import { View3D } from "./view3d.js";
import { readDxfText } from "../vendor/ezjww.mjs";

const $ = (id) => document.getElementById(id);
const el0 = (sel) => document.querySelector(sel);

const HINTS = {
  move: "指で動かす・2本指で拡大",
  mark: "基準にする点をタップ→距離(実寸mm)を入力",
  select: "タップで1つ選ぶ/なぞって範囲選択。選んだら、ドラッグで移動、角で拡大、○で回転。コメントなども選べます",
  dim: "測定(寸法): 2点をタップ(端点に吸着)",
  area: "測定(面積): 角を順にタップ→「完了」",
  route: "測定(ルート): 経路を順にタップ→「完了」",
  line: "図形(線): 始点と終点をタップ(端点・中点に吸着)。既存の線の線種は「属性取得」",
  arrow: "図形(矢印): 根元と、先端(矢印の頭の側)をタップ",
  rect: "図形(矩形): 対角の2点をタップ(「数値」で大きさ指定)",
  circle: "図形(円): 中心と、円周上の点をタップ(「数値」で半径指定)",
  wall: "壁の線を順にタップ(端点に吸着)→「完了」。最初の点にもう一度触れると、輪を閉じます。3Dの壁になります",
  ctext: "文字を置きたい所をタップ。文字の大きさ・種類は「属性取得」で既存の文字から取れます",
  pen: "指でなぞって書く",
  text: "コメント(図面とは別の書き込み)を置きたい所をタップ",
  erase: "消したい注釈・基準点をタップ(「戻す」で元に戻せます)",
};

const prefs = {
  get(key, fallback) {
    try {
      return localStorage.getItem(`jww-reading.${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`jww-reading.${key}`, value);
    } catch {
      // 保存できない環境では、毎回の既定値で動く
    }
  },
};

/** 変更の有無の判定に使う、保存内容の核(注釈・縮尺・図形の編集記録)。 */
export function coreOf(snap) {
  return JSON.stringify({ items: snap?.items ?? [], scale: snap?.settings?.scale ?? null, ops: snap?.edits?.ops ?? [], parts: snap?.parts?.items ?? [] });
}

export function setupTools({ viewer, getModel, getFileName, storage, ensureLayerVisible = () => {} }) {
  const el = {
    bar: $("tools"), scale: $("scale"), hint: $("tool-hint"),
    base: $("t-base"), stretch: $("t-stretch"), num: $("t-num"), shapeNum: $("t-shape-num"), save: $("t-save"),
    off: $("off"), offTitle: $("off-title"), offHint: $("off-hint"), offDx: $("off-dx"), offDy: $("off-dy"), offDxLabel: $("off-dx-label"), offDyRow: $("off-dy-row"),
    add: $("t-add"), rl: $("t-rl"), rr: $("t-rr"), big: $("t-big"), small: $("t-small"),
    done: $("t-done"), cancel: $("t-cancel"), copy: $("t-copy"), edit: $("t-edit"), del: $("t-del"), undo: $("t-undo"), exportBtn: $("t-export"),
    txt: $("txt"), txtInput: $("txt-input"), txtTitle: $("txt-title"), txtSizeRow: $("txt-size-row"), txtSize: $("txt-size"), resume: $("resume"),
    opts: $("opts"), mOpts: $("m-opts"), aOpts: $("a-opts"), pick: $("t-pick"), attrInfo: $("attr-info"), attrChip: $("attr-chip"), attrReset: $("t-attr-reset"),
    groups: [...document.querySelectorAll("[data-group]")],
    sOpts: $("s-opts"), wOpts: $("w-opts"), wH: $("w-h"), wT: $("w-t"), wZ: $("w-z"), wA: $("w-a"), to3d: $("t-3d"), v3dBtn: $("v3d-btn"),
    ex: $("ex"), exMsg: $("ex-msg"), exOverlay: $("ex-overlay"), exAutosave: $("ex-autosave"), exDraft: $("ex-draft"),
  };

  let storeKey = null; // 図面ごとの保存先(中身のSHA-256)。保存した状態=storeKey、下書き=draft:storeKey
  let snapIndex = null;
  let edits = null; // 図面の図形の編集記録(図面を開くたびに作る)
  let unloadedParts = null; // 読み込めなかった保存済みの3D部品(そのまま持ち続ける)
  let sourceBytes = null; // 開いている図面の原本(DXFへの書き出しに使う)
  let unloadedEdits = null; // 読み込めなかった保存済みの編集(上書きして失わないよう、そのまま持ち続ける)
  let savedCore = coreOf(null); // 最後に保存した状態の核。いまの状態と違えば「未保存」
  let loading = false; // 図面を開く途中(読み込みによる変化は、変更として扱わない)
  let autosave = prefs.get("autosave", "off") === "on";
  let keepDraft = prefs.get("draft", "on") === "on";
  let flashText = "";
  let flashTimer = 0;
  let afterTimer = 0;
  const GROUPS = { measure: MEASURE_MODES, shape: SHAPE_MODES }; // 工具の「まとめ」ボタンと、その中のモード
  const lastGroup = { measure: "dim", shape: "line" }; // まとめボタンを押したとき、最後に使った種類
  const history = []; // 「戻す」の順序: "ann"(注釈) / "edit"(図形の編集)

  el.exAutosave.checked = autosave;
  el.exDraft.checked = keepDraft;

  const flash = (text) => {
    flashText = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashText = "";
      syncUi();
    }, 2500);
    syncUi();
  };

  const snapshot = () => ({
    app: "JWW-Reading",
    version: 1,
    file: storeKey ? { key: storeKey } : null,
    settings: store.settings,
    items: store.items,
    edits: edits && (edits.ops.length > 0 || !unloadedEdits) ? edits.toJSON() : (unloadedEdits ?? null),
    parts: edits && (parts.list.length > 0 || !unloadedParts) ? parts.toJSON(edits.baseCount) : (unloadedParts ?? null),
  });

  const isDirty = () => coreOf(snapshot()) !== savedCore;

  /** 最後に保存した状態として、端末に書く。下書きは、不要になるので消す。 */
  async function commitSave({ quiet = false } = {}) {
    if (!storeKey) return;
    const snap = snapshot();
    const ok = await storage.set(storeKey, snap);
    if (!ok) {
      flash("保存できませんでした(この端末で、保存が許可されていません)");
      return;
    }
    await storage.delete(`draft:${storeKey}`);
    savedCore = coreOf(snap);
    updateSaveButton();
    if (!quiet) flash("保存しました");
  }

  async function writeDraft() {
    if (!storeKey) return;
    if (isDirty()) await storage.set(`draft:${storeKey}`, snapshot());
    else await storage.delete(`draft:${storeKey}`);
  }

  function updateSaveButton() {
    const dirty = isDirty();
    el.save.textContent = dirty ? "保存●" : "保存";
    el.save.classList.toggle("dirty", dirty);
  }

  /** 変更があったとき: 未保存の表示を更新し、設定に応じて、自動保存または下書きを残す。 */
  function afterChange() {
    if (loading) return;
    clearTimeout(afterTimer);
    afterTimer = setTimeout(() => {
      updateSaveButton();
      if (autosave) commitSave({ quiet: true });
      else if (keepDraft) writeDraft();
    }, 300);
  }

  const textRects = new Map(); // 画面に描いたコメントの四角(選ぶときの当たり判定用)
  const refreshMarks = () => snapIndex?.setMarks(store.items.filter((i) => i.kind === "mark").map((i) => i.at));
  const store = new AnnotationStore(() => {
    viewer.redraw();
    afterChange();
    refreshMarks(); // 基準点は、寸法や移動の吸着の対象にする
    syncUi(); // 取り消しなどで、選んでいた注釈がなくなったときに、ボタンの表示を合わせる
  });
  store.onCheckpoint = () => history.push("ann");
  const parts = new PartStore(() => afterChange()); // 3D部品(平面図の図形に、高さなどをつけたもの)
  parts.onAdd = () => history.push("part");

  const getScale = () => {
    const n = Math.round(Number(el.scale.value));
    return Number.isFinite(n) && n >= 1 ? n : 100;
  };

  const objectTool = new ObjectTool({
    viewer,
    edits: null,
    getSnap: () => snapIndex,
    getScale: () => getScale(),
    askOffset: (title, hint, opts) => askOffset(title, hint, opts),
    onState: () => syncUi(),
  });

  const tools = new ToolController({
    viewer,
    store,
    objectTool,
    getScale,
    getSnap: () => snapIndex,
    getDrawStyle: () => {
      const w = getModel()?.writeLayer;
      if (w) ensureLayerVisible(w.key); // 描き足した図形が、隠れたレイヤに入って見えなくならないようにする
      return w ? { layer: w.key, color: w.color } : {};
    },
    getWallParams: () => wallParams(),
    onWall: ({ path, closed }) => makeWall(path, closed),
    askText: (at, initial) => askText(at, initial),
    askDrawText: ({ initial, height }) => askDrawText(initial, height),
    onNotice: (msg) => flash(msg),
    askOffset: (title, hint, opts) => askOffset(title, hint, opts),
    getTextRect: (id) => textRects.get(id) ?? null,
    onState: () => syncUi(),
  });

  viewer.overlay = (frame) => {
    if (!frame.forExport) textRects.clear();
    const snap = tools.mode === "select" ? objectTool.snapHit : tools.snap;
    drawAnnotations(frame, { items: store.items, draft: tools.draft, snap, selectedId: tools.selectedId, rects: textRects });
    if (tools.mode === "select") objectTool.drawOverlay(frame);
  };

  /**
   * 横・縦の距離(実寸mm)を入力してもらう。やめたら null。
   * single を指定すると、1つの数値だけを聞く(例: 円の半径)。このとき、返す値は dx に入る。
   */
  function askOffset(title, hint = "", { single = "" } = {}) {
    return new Promise((resolve) => {
      el.offTitle.textContent = title;
      el.offHint.textContent = hint;
      el.offDxLabel.textContent = single || "横(→が+)";
      el.offDyRow.hidden = Boolean(single);
      el.offDx.value = "0";
      el.offDy.value = "0";
      el.off.addEventListener(
        "close",
        () => {
          if (el.off.returnValue !== "ok") return resolve(null);
          const dx = Number(el.offDx.value);
          const dy = single ? 0 : Number(el.offDy.value);
          resolve(Number.isFinite(dx) && Number.isFinite(dy) ? { dx, dy } : null);
        },
        { once: true }
      );
      el.off.returnValue = "cancel";
      el.off.showModal();
      el.offDx.focus();
      el.offDx.select();
    });
  }

  /** 文字入力のダイアログ。withSize のとき、文字の高さも聞く。やめたら null。 */
  function openTextDialog({ title, initial = "", height = null }) {
    return new Promise((resolve) => {
      el.txtTitle.textContent = title;
      el.txtInput.value = initial;
      el.txtSizeRow.hidden = height === null;
      if (height !== null) el.txtSize.value = String(+height.toFixed(2));
      el.txt.addEventListener(
        "close",
        () => resolve(el.txt.returnValue === "ok" ? { text: el.txtInput.value, height: Number(el.txtSize.value) } : null),
        { once: true }
      );
      el.txt.returnValue = "cancel";
      el.txt.showModal();
      el.txtInput.focus();
    });
  }

  async function askText(at, initial = "") {
    const r = await openTextDialog({ title: "コメント", initial });
    return r ? r.text : null;
  }

  /** 図面に描く文字の入力(内容と高さ)。 */
  function askDrawText(initial, height) {
    return openTextDialog({ title: "文字を描き足す", initial, height });
  }

  /** 「戻す」: 作図中の点 → 直前の操作(注釈・図形の編集のうち、新しいほう)の順に戻す。 */
  function undoLast() {
    if (objectTool.baseMove || objectTool.stretch) {
      objectTool.cancelModes();
      return;
    }
    if (tools.undoDraft()) return;
    const kind = history.pop();
    if (kind === "part") parts.undo();
    else if (kind === "edit") objectTool.undo();
    else if (kind === "ann") store.undo();
    else if (!objectTool.undo()) store.undo();
    syncUi();
  }

  function syncUi() {
    for (const b of el.bar.querySelectorAll("[data-tool]")) b.setAttribute("aria-pressed", String(b.dataset.tool === tools.mode));
    const measuring = MEASURE_MODES.includes(tools.mode);
    const shaping = SHAPE_MODES.includes(tools.mode);
    const attrMode = ATTR_MODES.includes(tools.mode);
    if (measuring) lastGroup.measure = tools.mode;
    if (shaping) lastGroup.shape = tools.mode;
    for (const g of el.groups) g.setAttribute("aria-pressed", String(GROUPS[g.dataset.group].includes(tools.mode)));
    el.mOpts.hidden = !measuring;
    el.sOpts.hidden = !shaping;
    el.aOpts.hidden = !attrMode;
    const wallMode = tools.mode === "wall";
    el.wOpts.hidden = !wallMode;
    el.opts.hidden = !(measuring || attrMode || wallMode);
    if (attrMode) {
      el.pick.setAttribute("aria-pressed", String(tools.picking));
      el.attrInfo.textContent = tools.picking ? "取りたい既存の図形をタップ" : tools.attrSummary();
      el.attrChip.style.background = aciToCss(tools.currentColor, viewer.dark);
      el.attrReset.hidden = !(tools.lineAttr || tools.textAttr);
    }
    const info = tools.draftInfo;
    const drafting = tools.drafting;
    el.done.hidden = !drafting;
    el.cancel.hidden = !drafting;
    el.hint.textContent = flashText || HINTS[tools.mode] + (info && drafting ? `(${info.count}点)` : "");
    const need = info?.kind === "area" ? 3 : 2;
    el.done.disabled = !info || info.count < need;
    const shapeDraft = tools.shapeDrafting;
    el.shapeNum.hidden = !(shapeDraft && tools.draft.item.points.length === 1);
    el.cancel.hidden = el.cancel.hidden && !shapeDraft;
    const sel = tools.mode === "select" ? tools.selected : null;
    el.copy.hidden = !sel;
    el.del.hidden = !sel;
    el.edit.hidden = sel?.kind !== "text";
    if (sel) el.hint.textContent = flashText || "選択中: ドラッグで移動、「複製」「削除」";
    const obj = tools.mode === "select";
    const objSel = obj && objectTool.hasSelection;
    const busy = obj && (objectTool.baseMove || objectTool.stretch); // 基点移動・伸縮の途中
    el.add.hidden = !obj || Boolean(busy);
    el.add.setAttribute("aria-pressed", String(objectTool.additive));
    for (const b of [el.rl, el.rr, el.big, el.small, el.base, el.stretch]) b.hidden = !objSel || Boolean(busy);
    el.to3d.hidden = !objSel || Boolean(busy);
    if (objSel && !busy) {
      el.copy.hidden = false;
      el.del.hidden = false;
      el.hint.textContent = flashText || `${objectTool.selection.length}個を選択中`;
    }
    if (busy) {
      el.copy.hidden = true;
      el.del.hidden = true;
      el.cancel.hidden = false;
      const bm = objectTool.baseMove;
      const st = objectTool.stretch;
      el.hint.textContent = flashText || (bm
        ? bm.stage === "base" ? "動かす側の点(端点・中点)をタップ" : "移動先の点をタップ(2本指で動かして探せます)"
        : st.stage === "window" ? "動かす側を、窓で囲む(ドラッグ)" : "ドラッグ、または「数値」で動かし、「完了」");
      el.num.hidden = !(st && st.stage === "offset");
      el.done.hidden = !(st && st.stage === "offset");
      el.done.disabled = !(st && st.stage === "offset" && (st.dx !== 0 || st.dy !== 0));
    } else {
      el.num.hidden = true;
    }
  }

  for (const b of el.bar.querySelectorAll("[data-tool]")) b.addEventListener("click", () => tools.setMode(b.dataset.tool));
  for (const g of el.groups) {
    g.addEventListener("click", () => {
      const name = g.dataset.group;
      if (!GROUPS[name].includes(tools.mode)) tools.setMode(lastGroup[name]);
    });
  }
  el.pick.addEventListener("click", () => tools.togglePick());
  el.attrReset.addEventListener("click", () => tools.resetAttr());
  const objBusy = () => Boolean(objectTool.baseMove || objectTool.stretch);
  el.done.addEventListener("click", () => (objBusy() ? objectTool.finish() : tools.finish()));
  el.cancel.addEventListener("click", () => (objBusy() ? objectTool.cancelModes() : tools.cancel()));
  el.base.addEventListener("click", () => objectTool.beginBaseMove());
  el.stretch.addEventListener("click", () => objectTool.beginStretch());
  el.num.addEventListener("click", () => objectTool.askStretchOffset());
  el.shapeNum.addEventListener("click", () => tools.askShapeNumbers());
  el.undo.addEventListener("click", undoLast);
  el.save.addEventListener("click", () => commitSave());
  el.copy.addEventListener("click", () => (objectTool.hasSelection ? objectTool.copy() : tools.copySelected()));
  el.del.addEventListener("click", () => (objectTool.hasSelection ? objectTool.delete() : tools.deleteSelected()));
  el.add.addEventListener("click", () => {
    objectTool.additive = !objectTool.additive;
    syncUi();
  });
  el.rl.addEventListener("click", () => objectTool.rotateBy(90));
  el.rr.addEventListener("click", () => objectTool.rotateBy(-90));
  el.big.addEventListener("click", () => objectTool.scaleBy(1.25));
  el.small.addEventListener("click", () => objectTool.scaleBy(0.8));
  el.edit.addEventListener("click", () => tools.editSelectedText());
  el.to3d.addEventListener("click", () => makePart());
  el.v3dBtn.addEventListener("click", () => openView3d());
  el.scale.addEventListener("change", () => {
    store.settings.scale = getScale();
    afterChange();
  });
  el.exportBtn.addEventListener("click", () => {
    el.exMsg.textContent = "";
    el.exAutosave.checked = autosave;
    el.exDraft.checked = keepDraft;
    el.ex.showModal();
  });
  el.ex.querySelector("[data-ex-close]").addEventListener("click", () => el.ex.close());

  // ---- 3D ----
  const p3 = { dlg: $("p3"), hint: $("p3-hint"), kind: $("p3-kind"), z0: $("p3-z0"), h: $("p3-h"), t: $("p3-t"), d: $("p3-d"), label: $("p3-label"), z0Label: $("p3-z0-label"), hLabel: $("p3-h-label"), tRow: $("p3-t-row"), dRow: $("p3-d-row"), nc: $("p3-nc"), ncRow: $("p3-nc-row") };
  const p3Defaults = {
    wall: { z0: 0, h: 2700, t: 0, d: 50 },
    pipe: { z0: 2500, h: 1000, t: 0, d: 50 },
  };
  const syncP3 = () => {
    const wall = p3.kind.value === "wall";
    p3.z0Label.textContent = wall ? "下端の高さ" : "配管の中心の高さ";
    p3.hLabel.textContent = wall ? "高さ" : "立上りの長さ(平面図の円のとき)";
    p3.tRow.hidden = !wall;
    p3.dRow.hidden = wall;
    p3.ncRow.hidden = !wall || !p3.hasRound; // 円弧・円が選択に含まれる壁のときだけ、除外の選択肢を出す
  };
  p3.kind.addEventListener("change", () => {
    const d = JSON.parse(prefs.get(`p3.${p3.kind.value}`, "null")) ?? p3Defaults[p3.kind.value];
    p3.z0.value = d.z0;
    p3.h.value = d.h;
    p3.t.value = d.t;
    p3.d.value = d.d;
    syncP3();
  });

  /** 選んでいる図形を、3D部品にする(種類・高さなどを聞く)。 */
  async function makePart() {
    let ids = objectTool.selection.filter((i) => isPartSource(edits?.entities[i]));
    const hasRound = ids.some((i) => edits.entities[i].type !== "LINE");
    p3.hasRound = hasRound;
    if (ids.length === 0) {
      flash("線・円弧・円を選んでください(文字などは3Dにできません)");
      return;
    }
    p3.hint.textContent = `選んだ線・円弧・円 ${ids.length}個を、3Dの部品にします。`;
    p3.kind.dispatchEvent(new Event("change"));
    p3.label.value = "";
    const ok = await new Promise((resolve) => {
      p3.dlg.addEventListener("close", () => resolve(p3.dlg.returnValue === "ok"), { once: true });
      p3.dlg.returnValue = "cancel";
      p3.dlg.showModal();
    });
    if (!ok) return;
    const kind = p3.kind.value;
    if (kind === "wall" && p3.nc.checked) ids = ids.filter((i) => edits.entities[i].type === "LINE");
    if (ids.length === 0) return flash("壁にできる線がありません(円弧・円は除外されました)");
    const num = (el_, fallback) => (Number.isFinite(Number(el_.value)) && el_.value !== "" ? Number(el_.value) : fallback);
    const vals = { z0: num(p3.z0, 0), h: num(p3.h, 0), t: Math.max(0, num(p3.t, 0)), d: num(p3.d, 50) };
    if (kind === "wall" && !(vals.h > 0)) return flash("高さは、0より大きい数にしてください");
    if (kind === "pipe" && !(vals.d > 0)) return flash("外径は、0より大きい数にしてください");
    prefs.set(`p3.${kind}`, JSON.stringify(vals));
    const first = edits.entities[ids[0]];
    parts.add({
      kind, ids, z0: vals.z0, h: vals.h, ...(kind === "wall" ? { thick: vals.t } : { dia: vals.d }),
      color: Number.isInteger(first?.color) ? first.color : 7, label: p3.label.value.trim(),
    });
    flash(`3D化しました(右上の「3D」で見られます)`);
  }

  // 壁をなぞって起こす(「壁3D」)。高さ・厚みなどは、画面の入力欄から読む
  for (const [key, input] of [["w.h", el.wH], ["w.t", el.wT], ["w.z", el.wZ], ["w.a", el.wA]]) {
    input.value = prefs.get(key, input.value);
    input.addEventListener("change", () => {
      prefs.set(key, input.value);
      if (tools.draft?.item.kind === "wall") tools.draft.item.thick = wallParams().thick; // 作図中の帯の太さに反映
      viewer.redraw();
    });
  }
  function wallParams() {
    const n = (input, fallback) => (input.value !== "" && Number.isFinite(Number(input.value)) ? Number(input.value) : fallback);
    return { height: n(el.wH, 2700), thick: Math.max(0, n(el.wT, 150)), z0: n(el.wZ, 0), align: el.wA.value };
  }

  function makeWall(path, closed) {
    const w = wallParams();
    if (!(w.height > 0)) return flash("壁の高さは、0より大きい数にしてください");
    parts.add({ kind: "wall", ids: [], path, closed, z0: w.z0, h: w.height, thick: w.thick, align: w.align, color: 7, label: "" });
    flash(`壁を作りました(高さ${w.height}・厚み${w.thick}mm)。「3D」で見られます`);
  }

  let view3d = null;
  const v3 = { root: $("v3d"), canvas: $("v3d-canvas"), info: $("v3d-info"), plan: $("v3d-plan"), list: $("v3d-list"), parts: $("v3d-parts"), listBtn: $("v3d-list-btn") };

  function refreshView3d({ resetView = false } = {}) {
    const scale = getScale();
    const shapes = buildScene(parts.list, edits.entities, { scale });
    view3d.setParts(shapes);
    view3d.setPlan(edits.entities, { scale, hidden: viewer.hiddenLayers, visible: v3.plan.checked });
    if (resetView) view3d.setView("iso");
    v3.info.textContent = parts.list.length === 0
      ? "まだ3D化した部品がありません。「選択」で線などを選び、「3D化」を押してください。"
      : `部品 ${parts.list.length}個(縮尺 1/${scale})。指1本で回す、2本で拡大・移動`;
    renderPartList();
  }

  function renderPartList() {
    v3.parts.replaceChildren();
    for (const p of parts.list) {
      const li = document.createElement("li");
      li.className = "row-part";
      const span = document.createElement("span");
      span.textContent = `[${PART_KINDS[p.kind]}] ${describePart(p)}`;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn small";
      del.textContent = "削除";
      del.addEventListener("click", () => {
        parts.remove(p.id);
        refreshView3d();
      });
      li.append(span, del);
      v3.parts.append(li);
    }
    if (parts.list.length === 0) {
      const li = document.createElement("li");
      li.className = "note";
      li.textContent = "部品はありません";
      v3.parts.append(li);
    }
  }

  async function openView3d() {
    if (!edits) return;
    v3.root.hidden = false;
    v3.info.textContent = "3Dを準備しています…";
    try {
      view3d ??= new View3D(v3.canvas);
      await view3d.init();
      view3d.resize();
      refreshView3d({ resetView: true });
      view3d.start();
    } catch (err) {
      v3.info.textContent = `3Dを表示できませんでした: ${err?.message ?? err}`;
    }
  }

  $("v3d-close").addEventListener("click", () => {
    v3.root.hidden = true;
    view3d?.stop();
  });
  for (const b of v3.root.querySelectorAll("[data-v3d-view]")) b.addEventListener("click", () => view3d?.setView(b.dataset.v3dView));
  v3.plan.addEventListener("change", () => view3d && refreshView3d());
  v3.listBtn.addEventListener("click", () => {
    v3.list.hidden = !v3.list.hidden;
  });
  window.addEventListener("resize", () => !v3.root.hidden && view3d?.resize());

  // ---- 保存の設定 ----
  el.exAutosave.addEventListener("change", () => {
    autosave = el.exAutosave.checked;
    prefs.set("autosave", autosave ? "on" : "off");
    if (autosave) commitSave({ quiet: true }); // オンにした時点の状態を、保存する
    else afterChange();
  });
  el.exDraft.addEventListener("change", async () => {
    keepDraft = el.exDraft.checked;
    prefs.set("draft", keepDraft ? "on" : "off");
    if (!keepDraft && storeKey) await storage.delete(`draft:${storeKey}`);
    else afterChange();
  });
  $("ex-revert").addEventListener("click", async () => {
    if (!storeKey) return;
    if (!isDirty()) {
      el.exMsg.textContent = "保存してから、変更はありません";
      return;
    }
    if (!confirm("最後に保存した状態に戻します。保存していない変更は、失われます。よろしいですか?")) return;
    const saved = await storage.get(storeKey);
    applySnapshot(saved);
    await storage.delete(`draft:${storeKey}`);
    updateSaveButton();
    el.exMsg.textContent = saved ? "最後に保存した状態に戻しました" : "保存した状態がないため、原本の状態に戻しました";
  });

  // ---- 書き出し ----
  function deliver(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  const baseName = () => (getFileName() || "図面").replace(/\.(jww|jwc)$/i, "");

  async function exportPdf(longSidePx) {
    const model = getModel();
    if (!model?.bounds) return;
    el.exMsg.textContent = "PDFを作っています…";
    await new Promise((r) => setTimeout(r, 30)); // 表示を更新させる
    const canvas = document.createElement("canvas");
    try {
      const b = model.bounds;
      const marginMm = 5;
      const pageW = b.x1 - b.x0 + marginMm * 2;
      const pageH = b.y1 - b.y0 + marginMm * 2;
      const pxPerMm = longSidePx / Math.max(pageW, pageH);
      canvas.width = Math.max(1, Math.round(pageW * pxPerMm));
      canvas.height = Math.max(1, Math.round(pageH * pxPerMm));
      viewer.renderToCanvas(canvas, { withOverlay: el.exOverlay.checked, marginPx: marginMm * pxPerMm });
      const blob = await new Promise((resolve, reject) => canvas.toBlob((x) => (x ? resolve(x) : reject(new Error("画像を作れませんでした"))), "image/jpeg", 0.92));
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      const pdf = makeJpegPdf({ jpeg, widthPx: canvas.width, heightPx: canvas.height, pageWidthMm: pageW, pageHeightMm: pageH, title: baseName() });
      deliver(new Blob([pdf], { type: "application/pdf" }), `${baseName()}${el.exOverlay.checked && store.items.length ? "_注釈" : ""}.pdf`);
      el.exMsg.textContent = `PDFを保存しました(${(pdf.length / 1024 / 1024).toFixed(1)} MB、${Math.round(pageW)}×${Math.round(pageH)} mm)`;
    } catch (err) {
      el.exMsg.textContent = `PDFを作れませんでした: ${err?.message ?? err}。「標準」で試してください。`;
    } finally {
      canvas.width = canvas.height = 0;
    }
  }

  async function exportDxf() {
    if (!edits || !sourceBytes) return;
    el.exMsg.textContent = "DXFを作っています…";
    await new Promise((r) => setTimeout(r, 30)); // 表示を更新させる
    try {
      const { text, count, skipped } = buildDxf(readDxfText(sourceBytes), edits.entities);
      deliver(new Blob([text], { type: "application/dxf" }), `${baseName()}${edits.ops.length ? "_編集済" : ""}.dxf`);
      el.exMsg.textContent = `DXFを保存しました(図形 ${count.toLocaleString()}個、${(text.length / 1024 / 1024).toFixed(1)} MB)` + (skipped ? `。書き出せない図形が${skipped}個ありました` : "");
    } catch (err) {
      el.exMsg.textContent = `DXFを作れませんでした: ${err?.message ?? err}`;
    }
  }

  $("ex-dxf").addEventListener("click", exportDxf);
  $("ex-pdf").addEventListener("click", () => exportPdf(4000));
  $("ex-pdf-hi").addEventListener("click", () => exportPdf(7000));
  $("ex-json").addEventListener("click", () => {
    const json = JSON.stringify(snapshot(), null, 2);
    deliver(new Blob([json], { type: "application/json" }), `${baseName()}_注釈.json`);
    el.exMsg.textContent = `注釈 ${store.items.length}件を保存しました`;
  });
  $("ex-json-file").addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data?.app !== "JWW-Reading") throw new Error("このアプリの注釈ファイルではありません");
      const r = applySnapshot(data);
      afterChange();
      el.exMsg.textContent = `注釈 ${store.items.length}件を読み込みました` + (r.ok ? "" : `(図形の編集は、${r.reason}ため読み込めませんでした)`);
    } catch (err) {
      el.exMsg.textContent = `読み込めませんでした: ${err?.message ?? err}`;
    }
  });
  $("ex-reset-edits").addEventListener("click", () => {
    if (!edits || edits.ops.length === 0) {
      el.exMsg.textContent = "図形の編集はありません";
      return;
    }
    if (confirm(`図形の編集 ${edits.ops.length}件を、すべて元に戻します。よろしいですか?`)) {
      objectTool.clearSelection();
      edits.clear();
      for (let i = history.length - 1; i >= 0; i--) if (history[i] === "edit") history.splice(i, 1);
      objectTool.refresh();
      el.exMsg.textContent = "図形の編集を元に戻しました";
    }
  });
  $("ex-clear").addEventListener("click", () => {
    if (store.items.length === 0 || confirm(`注釈 ${store.items.length}件をすべて消します。よろしいですか?`)) {
      store.clear();
      el.exMsg.textContent = "注釈を消しました";
    }
  });

  $("ex-clear-marks").addEventListener("click", () => {
    const marks = store.items.filter((i) => i.kind === "mark");
    if (marks.length === 0) {
      el.exMsg.textContent = "基準点はありません";
      return;
    }
    if (confirm(`基準点 ${marks.length}個を、すべて消します。よろしいですか?`)) {
      store.checkpoint();
      store.items = store.items.filter((i) => i.kind !== "mark");
      store.touch();
      el.exMsg.textContent = "基準点を消しました(「戻す」で元に戻せます)";
    }
  });

  /** 保存データ(または null=原本のまま)を、いまの図面に当てはめる。 */
  function applySnapshot(snap) {
    loading = true;
    try {
      store.load(snap ?? { items: [] });
      const r = edits ? edits.load(snap?.edits) : { ok: true };
      unloadedEdits = r.ok ? null : snap?.edits;
      const pr = edits ? parts.load(snap?.parts, edits.baseCount) : { ok: true };
      unloadedParts = pr.ok ? null : snap?.parts;
      history.length = 0;
      objectTool.clearSelection();
      objectTool.refresh();
      el.scale.value = store.settings.scale ?? getModel()?.writeScale ?? 100;
      syncUi();
      return r;
    } finally {
      loading = false;
    }
  }

  /** 保存していない作業(下書き)があるとき、続きから再開するかを選んでもらう。 */
  function askResume(hasSaved) {
    return new Promise((resolve) => {
      $("resume-saved").textContent = hasSaved ? "保存した状態で開く" : "最初の状態で開く(編集なし)";
      el.resume.addEventListener("close", () => resolve(el.resume.returnValue || "saved"), { once: true });
      el.resume.returnValue = "";
      el.resume.showModal();
    });
  }

  // アプリを閉じる・隠すときにも、下書きを確実に残す
  const flushDraft = () => {
    if (!loading && !autosave && keepDraft) writeDraft();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushDraft();
  });
  window.addEventListener("pagehide", flushDraft);
  window.addEventListener("beforeunload", (ev) => {
    if (isDirty() && !keepDraft && !autosave) ev.preventDefault(); // 一時保存がオフのときだけ、未保存の警告
  });

  return {
    store,
    tools,
    get dirty() {
      return isDirty();
    },
    /** 図面を開いたとき: 吸着用の点を作り、保存済みの注釈・図形の編集(または下書き)を呼び戻す。 */
    async onOpened(model, file, bytes, key) {
      loading = true;
      try {
        tools.setMode("move");
        objectTool.clearSelection();
        storeKey = key;
        sourceBytes = bytes;
        el.v3dBtn.disabled = false;
        snapIndex = new SnapIndex(model.entities);
        let snapTimer = 0;
        edits = new EditStore(model.entities, (e) => {
          viewer.entities = e.entities;
          clearTimeout(snapTimer);
          snapTimer = setTimeout(() => {
            snapIndex = new SnapIndex(e.entities); // 編集後の端点・中点に吸着する(番号を保つため、nullも含めて渡す)
            refreshMarks();
          }, 200);
          afterChange();
        });
        edits.onAdd = () => history.push("edit");
        objectTool.edits = edits;
        const saved = await storage.get(key);
        const draft = await storage.get(`draft:${key}`);
        const r = applySnapshot(saved);
        savedCore = coreOf(snapshot()); // 保存した状態(なければ、原本のまま)
        if (!r.ok) el.hint.textContent = `保存済みの図形の編集は、${r.reason}ため、読み込めませんでした`;
        viewer.setEntities(edits.entities);
        el.bar.hidden = false;
        if (draft && coreOf(draft) !== savedCore) {
          const choice = await askResume(Boolean(saved));
          if (choice === "resume") applySnapshot(draft);
          else if (choice === "original") applySnapshot(null);
          if (choice === "saved") await storage.delete(`draft:${key}`);
        } else if (draft) {
          await storage.delete(`draft:${key}`);
        }
      } finally {
        loading = false;
      }
      refreshMarks();
      updateSaveButton();
      syncUi();
    },
  };
}
