// 測定・注釈・図形の編集・書き出し・保存の画面まわり。図面を開いたとき onOpened() を呼ぶ。
import { AnnotationStore } from "./annotations.js";
import { drawAnnotations } from "./annotation-render.js";
import { SnapIndex } from "./geometry.js";
import { ToolController } from "./tools.js";
import { EditStore } from "./edits.js";
import { ObjectTool } from "./object-tool.js";
import { makeJpegPdf } from "./pdf.js";

const $ = (id) => document.getElementById(id);

const HINTS = {
  move: "指で動かす・2本指で拡大",
  obj: "なぞって範囲選択/タップで1つ選ぶ。枠をドラッグで移動、角で拡大、○で回転",
  mark: "基準にする点をタップ→距離(実寸mm)を入力",
  select: "注釈をタップで選び、ドラッグで移動",
  dim: "2点をタップ(端点に吸着)",
  area: "角を順にタップ→「完了」",
  route: "経路を順にタップ→「完了」",
  line: "始点と終点をタップ(端点・中点に吸着)",
  rect: "対角の2点をタップ(「数値」で大きさ指定)",
  circle: "中心と、円周上の点をタップ(「数値」で半径指定)",
  pen: "指でなぞって書く",
  text: "置きたい所をタップ",
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
  return JSON.stringify({ items: snap?.items ?? [], scale: snap?.settings?.scale ?? null, ops: snap?.edits?.ops ?? [] });
}

export function setupTools({ viewer, getModel, getFileName, storage, ensureLayerVisible = () => {} }) {
  const el = {
    bar: $("tools"), scale: $("scale"), hint: $("tool-hint"),
    base: $("t-base"), stretch: $("t-stretch"), num: $("t-num"), shapeNum: $("t-shape-num"), save: $("t-save"),
    off: $("off"), offTitle: $("off-title"), offHint: $("off-hint"), offDx: $("off-dx"), offDy: $("off-dy"), offDxLabel: $("off-dx-label"), offDyRow: $("off-dy-row"),
    add: $("t-add"), rl: $("t-rl"), rr: $("t-rr"), big: $("t-big"), small: $("t-small"),
    done: $("t-done"), cancel: $("t-cancel"), copy: $("t-copy"), edit: $("t-edit"), del: $("t-del"), undo: $("t-undo"), exportBtn: $("t-export"),
    txt: $("txt"), txtInput: $("txt-input"), resume: $("resume"),
    ex: $("ex"), exMsg: $("ex-msg"), exOverlay: $("ex-overlay"), exAutosave: $("ex-autosave"), exDraft: $("ex-draft"),
  };

  let storeKey = null; // 図面ごとの保存先(中身のSHA-256)。保存した状態=storeKey、下書き=draft:storeKey
  let snapIndex = null;
  let edits = null; // 図面の図形の編集記録(図面を開くたびに作る)
  let unloadedEdits = null; // 読み込めなかった保存済みの編集(上書きして失わないよう、そのまま持ち続ける)
  let savedCore = coreOf(null); // 最後に保存した状態の核。いまの状態と違えば「未保存」
  let loading = false; // 図面を開く途中(読み込みによる変化は、変更として扱わない)
  let autosave = prefs.get("autosave", "off") === "on";
  let keepDraft = prefs.get("draft", "on") === "on";
  let flashText = "";
  let flashTimer = 0;
  let afterTimer = 0;
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
    askText: (at, initial) => askText(at, initial),
    askOffset: (title, hint, opts) => askOffset(title, hint, opts),
    getTextRect: (id) => textRects.get(id) ?? null,
    onState: () => syncUi(),
  });

  viewer.overlay = (frame) => {
    if (!frame.forExport) textRects.clear();
    const snap = tools.mode === "obj" ? objectTool.snapHit : tools.snap;
    drawAnnotations(frame, { items: store.items, draft: tools.draft, snap, selectedId: tools.selectedId, rects: textRects });
    if (tools.mode === "obj") objectTool.drawOverlay(frame);
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

  function askText(at, initial = "") {
    return new Promise((resolve) => {
      el.txtInput.value = initial;
      el.txt.addEventListener("close", () => resolve(el.txt.returnValue === "ok" ? el.txtInput.value : null), { once: true });
      el.txt.returnValue = "cancel";
      el.txt.showModal();
      el.txtInput.focus();
    });
  }

  /** 「戻す」: 作図中の点 → 直前の操作(注釈・図形の編集のうち、新しいほう)の順に戻す。 */
  function undoLast() {
    if (objectTool.baseMove || objectTool.stretch) {
      objectTool.cancelModes();
      return;
    }
    if (tools.undoDraft()) return;
    const kind = history.pop();
    if (kind === "edit") objectTool.undo();
    else if (kind === "ann") store.undo();
    else if (!objectTool.undo()) store.undo();
    syncUi();
  }

  function syncUi() {
    for (const b of el.bar.querySelectorAll("[data-tool]")) b.setAttribute("aria-pressed", String(b.dataset.tool === tools.mode));
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
    if (sel) el.hint.textContent = flashText || "選択中: ドラッグで移動";
    const obj = tools.mode === "obj";
    const objSel = obj && objectTool.hasSelection;
    const busy = obj && (objectTool.baseMove || objectTool.stretch); // 基点移動・伸縮の途中
    el.add.hidden = !obj || Boolean(busy);
    el.add.setAttribute("aria-pressed", String(objectTool.additive));
    for (const b of [el.rl, el.rr, el.big, el.small, el.base, el.stretch]) b.hidden = !objSel || Boolean(busy);
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
  el.done.addEventListener("click", () => (tools.mode === "obj" ? objectTool.finish() : tools.finish()));
  el.cancel.addEventListener("click", () => (tools.mode === "obj" ? objectTool.cancelModes() : tools.cancel()));
  el.base.addEventListener("click", () => objectTool.beginBaseMove());
  el.stretch.addEventListener("click", () => objectTool.beginStretch());
  el.num.addEventListener("click", () => objectTool.askStretchOffset());
  el.shapeNum.addEventListener("click", () => tools.askShapeNumbers());
  el.undo.addEventListener("click", undoLast);
  el.save.addEventListener("click", () => commitSave());
  el.copy.addEventListener("click", () => (tools.mode === "obj" ? objectTool.copy() : tools.copySelected()));
  el.del.addEventListener("click", () => (tools.mode === "obj" ? objectTool.delete() : tools.deleteSelected()));
  el.add.addEventListener("click", () => {
    objectTool.additive = !objectTool.additive;
    syncUi();
  });
  el.rl.addEventListener("click", () => objectTool.rotateBy(90));
  el.rr.addEventListener("click", () => objectTool.rotateBy(-90));
  el.big.addEventListener("click", () => objectTool.scaleBy(1.25));
  el.small.addEventListener("click", () => objectTool.scaleBy(0.8));
  el.edit.addEventListener("click", () => tools.editSelectedText());
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
