// 測定・注釈・書き出しの画面まわり。図面を開いたとき onOpened() を呼ぶ。
import { AnnotationStore, LocalAnnotationStorage, fingerprintOf, storageKey } from "./annotations.js";
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
  select: "注釈をタップで選び、ドラッグで移動",
  dim: "2点をタップ(端点に吸着)",
  area: "角を順にタップ→「完了」",
  route: "経路を順にタップ→「完了」",
  pen: "指でなぞって書く",
  text: "置きたい所をタップ",
  erase: "消したい注釈をタップ",
};

export function setupTools({ viewer, getModel, getFileName }) {
  const el = {
    bar: $("tools"), scale: $("scale"), hint: $("tool-hint"),
    add: $("t-add"), rl: $("t-rl"), rr: $("t-rr"), big: $("t-big"), small: $("t-small"),
    done: $("t-done"), cancel: $("t-cancel"), copy: $("t-copy"), edit: $("t-edit"), del: $("t-del"), undo: $("t-undo"), exportBtn: $("t-export"),
    txt: $("txt"), txtInput: $("txt-input"),
    ex: $("ex"), exMsg: $("ex-msg"), exOverlay: $("ex-overlay"),
  };
  const storage = new LocalAnnotationStorage();
  let fingerprint = null;
  let snapIndex = null;
  let saveTimer = 0;

  let edits = null; // 図面の図形の編集記録(図面を開くたびに作る)
  let unloadedEdits = null; // 読み込めなかった保存済みの編集(上書きして失わないよう、そのまま持ち続ける)
  const snapshot = () => ({
    ...store.toJSON(fingerprint),
    edits: edits && (edits.ops.length > 0 || !unloadedEdits) ? edits.toJSON() : (unloadedEdits ?? null),
  });

  const save = () => {
    if (!fingerprint) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => storage.set(storageKey(fingerprint), snapshot()), 300);
  };

  const textRects = new Map(); // 画面に描いたコメントの四角(選ぶときの当たり判定用)
  const store = new AnnotationStore(() => {
    viewer.redraw();
    save();
    syncUi(); // 取り消しなどで、選んでいた注釈がなくなったときに、ボタンの表示を合わせる
  });

  const getScale = () => {
    const n = Math.round(Number(el.scale.value));
    return Number.isFinite(n) && n >= 1 ? n : 100;
  };

  const objectTool = new ObjectTool({ viewer, edits: null, onState: () => syncUi() });

  const tools = new ToolController({
    viewer,
    store,
    objectTool,
    getScale,
    getSnap: () => snapIndex,
    askText: (at, initial) => askText(at, initial),
    getTextRect: (id) => textRects.get(id) ?? null,
    onState: () => syncUi(),
  });

  viewer.overlay = (frame) => {
    if (!frame.forExport) textRects.clear();
    drawAnnotations(frame, { items: store.items, draft: tools.draft, snap: tools.snap, selectedId: tools.selectedId, rects: textRects });
    if (tools.mode === "obj") objectTool.drawOverlay(frame);
  };

  function askText(at, initial = "") {
    return new Promise((resolve) => {
      el.txtInput.value = initial;
      el.txt.addEventListener("close", () => resolve(el.txt.returnValue === "ok" ? el.txtInput.value : null), { once: true });
      el.txt.returnValue = "cancel";
      el.txt.showModal();
      el.txtInput.focus();
    });
  }

  function syncUi() {
    for (const b of el.bar.querySelectorAll("[data-tool]")) b.setAttribute("aria-pressed", String(b.dataset.tool === tools.mode));
    const info = tools.draftInfo;
    const drafting = tools.drafting;
    el.done.hidden = !drafting;
    el.cancel.hidden = !drafting;
    el.hint.textContent = HINTS[tools.mode] + (info && drafting ? `(${info.count}点)` : "");
    const need = info?.kind === "area" ? 3 : 2;
    el.done.disabled = !info || info.count < need;
    const sel = tools.mode === "select" ? tools.selected : null;
    el.copy.hidden = !sel;
    el.del.hidden = !sel;
    el.edit.hidden = sel?.kind !== "text";
    if (sel) el.hint.textContent = "選択中: ドラッグで移動";
    const obj = tools.mode === "obj";
    const objSel = obj && objectTool.hasSelection;
    el.add.hidden = !obj;
    el.add.setAttribute("aria-pressed", String(objectTool.additive));
    for (const b of [el.rl, el.rr, el.big, el.small]) b.hidden = !objSel;
    if (objSel) {
      el.copy.hidden = false;
      el.del.hidden = false;
      el.hint.textContent = `${objectTool.selection.length}個を選択中`;
    }
  }

  for (const b of el.bar.querySelectorAll("[data-tool]")) b.addEventListener("click", () => tools.setMode(b.dataset.tool));
  el.done.addEventListener("click", () => tools.finish());
  el.cancel.addEventListener("click", () => tools.cancel());
  el.undo.addEventListener("click", () => tools.undo());
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
    save();
  });
  el.exportBtn.addEventListener("click", () => {
    el.exMsg.textContent = "";
    el.ex.showModal();
  });
  el.ex.querySelector("[data-ex-close]").addEventListener("click", () => el.ex.close());

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
      store.load(data);
      if (data.settings?.scale) el.scale.value = data.settings.scale;
      const r = edits ? edits.load(data.edits) : { ok: true };
      objectTool.refresh();
      el.exMsg.textContent = `注釈 ${store.items.length}件を読み込みました` + (r.ok ? "" : `(図形の編集は、${r.reason}ため読み込めませんでした)`);
      save();
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

  return {
    store,
    tools,
    /** 図面を開いたとき: 吸着用の点を作り、保存済みの注釈を呼び戻す。 */
    async onOpened(model, file, bytes) {
      tools.setMode("move");
      objectTool.clearSelection();
      snapIndex = new SnapIndex(model.entities);
      fingerprint = await fingerprintOf(file.name, bytes);
      const saved = await storage.get(storageKey(fingerprint));
      let snapTimer = 0;
      edits = new EditStore(model.entities, (e) => {
        viewer.entities = e.entities;
        clearTimeout(snapTimer);
        snapTimer = setTimeout(() => (snapIndex = new SnapIndex(e.entities.filter(Boolean))), 200); // 編集後の端点に吸着する
        save();
      });
      objectTool.edits = edits;
      const restored = edits.load(saved?.edits);
      unloadedEdits = restored.ok ? null : saved.edits;
      viewer.setEntities(edits.entities);
      store.load(saved ?? { items: [] });
      if (!restored.ok) el.hint.textContent = `保存済みの図形の編集は、${restored.reason}ため、読み込めませんでした`;
      el.scale.value = store.settings.scale ?? model.writeScale ?? 100;
      el.bar.hidden = false;
      syncUi();
    },
  };
}
