import { init, readDrawing, readHeader } from "../vendor/ezjww.mjs";
import { decodeDxf, isBinaryDxf, looksLikeDxf, readDxfDrawing } from "./dxf-import.js";
import { buildModel, explainNotDrawing } from "./drawing.js";
import { Viewer } from "./viewer.js";
import { LayerPanel } from "./layer-panel.js";
import { OneDriveDialog } from "./onedrive-dialog.js";
import { CLIENT_ID, EXPLORER_HOSTS } from "./config.js";
import { describePayload, fetchDrawing, pickDrawingUrl } from "./remote-drop.js";
import { setupTools } from "./app-tools.js";
import { LocalAnnotationStorage, fingerprintOf, storageKey } from "./annotations.js";
import { FileLibrary } from "./library.js";

const $ = (id) => document.getElementById(id);
const els = {
  file: $("file"), name: $("name"), fit: $("fit"), layersBtn: $("layers-btn"), theme: $("theme"),
  stage: $("stage"), canvas: $("canvas"), empty: $("empty"), busy: $("busy"), status: $("status"),
  panel: $("panel"), panelClose: $("panel-close"), allOn: $("all-on"), allOff: $("all-off"),
  search: $("layer-search"), list: $("layer-list"), showEmpty: $("show-empty"),
};

const state = { model: null, fileName: "", key: null, dark: false };
const viewer = new Viewer(els.canvas);
const storage = new LocalAnnotationStorage();
const library = new FileLibrary(storage);
const layerPanel = new LayerPanel({
  list: els.list,
  search: els.search,
  showEmpty: els.showEmpty,
  onChange: (hidden) => {
    viewer.setHiddenLayers(hidden);
    scheduleViewSave();
  },
});
const toolkit = setupTools({
  viewer,
  getModel: () => state.model,
  getFileName: () => state.fileName,
  storage,
  ensureLayerVisible: (key) => layerPanel.show(key),
});

// ---- 表示位置(拡大・移動)と、隠したレイヤを、図面ごとに端末へ残す(保存ボタンとは別。開き直したときに、同じ見え方に戻すため) ----
let viewTimer = 0;
function scheduleViewSave() {
  if (!state.key) return;
  clearTimeout(viewTimer);
  viewTimer = setTimeout(saveView, 800);
}
function saveView() {
  if (!state.key || !state.model) return;
  const { s, tx, ty } = viewer.view;
  storage.set(`view:${state.key}`, { s, tx, ty, hidden: [...layerPanel.hidden] }, "meta");
}
viewer.onChange = () => scheduleViewSave();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) saveView();
});
window.addEventListener("pagehide", saveView);

const wasmReady = init().catch((err) => {
  setStatus(`読み込み部品の準備に失敗しました: ${err.message}`);
  throw err;
});

function setStatus(text) {
  els.status.textContent = text;
}

/** DXFを、JWWと同じ画面用モデルにする(Jw_cadのレイヤグループはないので、すべてのレイヤを1グループにまとめる)。 */
function modelFromDxf(bytes) {
  const dxf = readDxfDrawing(decodeDxf(bytes));
  const model = buildModel(dxf, null);
  model.source = "dxf";
  model.unitScale = dxf.unitScale;
  model.unsupportedTypes = dxf.unsupportedTypes;
  const keys = model.groups.flatMap((g) => g.layers.map((l) => l.key));
  const wk = keys.includes("0") ? "0" : keys[0];
  model.writeLayer = wk === undefined ? null : { key: wk, color: 7 }; // 描き足す図形の、レイヤと色
  return model;
}

async function openFile(file, { fromLibrary = false } = {}) {
  els.busy.hidden = false;
  try {
    await wasmReady;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const reason = explainNotDrawing(bytes);
    if (reason) {
      setStatus(reason);
      return;
    }
    const t0 = performance.now();
    const isDxf = /\.dxf$/i.test(file.name) || looksLikeDxf(bytes);
    if (isDxf && isBinaryDxf(bytes)) {
      setStatus("バイナリ形式のDXFは開けません。CADで「ASCII形式のDXF」として保存し直してください。");
      return;
    }
    const model = isDxf ? modelFromDxf(bytes) : buildModel(readDrawing(bytes), readHeader(bytes));
    const ms = Math.round(performance.now() - t0);
    const key = storageKey(await fingerprintOf(file.name, bytes));
    saveView(); // 開いていた図面の表示位置を、切り替える前に残す
    // 図面の控えを端末に残す(アプリを閉じても、続きから開けるように)
    const kept = fromLibrary ? await library.touch(key) : await library.remember(key, file.name, bytes);
    state.model = model;
    state.fileName = file.name;
    state.key = key;
    layerPanel.setModel(model);
    // 前回の、隠したレイヤと表示位置を呼び戻す
    const view = await storage.get(`view:${key}`, "meta");
    if (view?.hidden) layerPanel.setHidden(view.hidden.filter((k) => model.groups.some((g) => g.layers.some((l) => l.key === k))));
    viewer.setModel(model, new Set(layerPanel.hidden));
    els.name.textContent = file.name;
    await toolkit.onOpened(model, file, bytes, key);
    viewer.fit(); // 測定バーが出て、図面の表示領域が変わったので合わせ直す
    if (view && Number.isFinite(view.s) && Number.isFinite(view.tx) && Number.isFinite(view.ty)) {
      viewer.view = { s: view.s, tx: view.tx, ty: view.ty };
      viewer.redraw();
    }
    els.empty.hidden = true;
    els.fit.disabled = false;
    els.layersBtn.disabled = false;
    const unsupportedKinds = model.unsupportedTypes?.length ? `(${model.unsupportedTypes.join("・")})` : "";
    const unsupported = model.unsupported.length ? ` / 未対応の図形 ${model.unsupported.length}個${unsupportedKinds}は表示していません` : "";
    const dxfNote = isDxf ? ` / DXFとして読み込み(単位 ${model.unitScale === 1 ? "mm" : `×${model.unitScale}でmmに換算`})` : "";
    const keptNote = kept ? "" : " / この図面は、端末に控えを残せませんでした(次回は、開き直してください)";
    setStatus(`図形 ${model.entities.length.toLocaleString()}個 / レイヤ ${model.layerCount} / 読み込み ${ms}ms${dxfNote}${unsupported}${keptNote}`);
  } catch (err) {
    setStatus(`開けませんでした: ${err?.message ?? err}`);
  } finally {
    els.busy.hidden = true;
  }
}

// ---- 最近の図面(端末に控えがあるもの) ----
const recent = { dialog: $("recent"), list: $("recent-list") };

async function showRecent() {
  const items = await library.list();
  recent.list.replaceChildren();
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "layer-none";
    li.textContent = "控えのある図面は、まだありません";
    recent.list.append(li);
  }
  for (const it of items) {
    const li = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "od-item";
    const name = document.createElement("span");
    name.className = "od-name";
    name.textContent = it.name;
    const info = document.createElement("span");
    info.className = "lcount";
    info.textContent = `${(it.size / 1024 / 1024).toFixed(1)} MB · ${new Date(it.openedAt).toLocaleDateString("ja-JP")}`;
    const icon = document.createElement("span");
    icon.className = "od-icon";
    icon.textContent = "📐";
    open.append(icon, name, info);
    open.addEventListener("click", async () => {
      const rec = await library.load(it.key);
      recent.dialog.close();
      if (rec) openFile(new File([rec.bytes], rec.name), { fromLibrary: true });
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn small";
    del.textContent = "削除";
    del.addEventListener("click", async () => {
      if (!confirm(`「${it.name}」の控えを、この端末から削除します。注釈・図形の編集の保存も、あわせて削除されます。よろしいですか?`)) return;
      await library.remove(it.key);
      await storage.delete(it.key);
      await storage.delete(`draft:${it.key}`);
      await storage.delete(`view:${it.key}`, "meta");
      showRecent();
    });
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.alignItems = "center";
    open.style.flex = "1";
    row.append(open, del);
    li.append(row);
    recent.list.append(li);
  }
  if (!recent.dialog.open) recent.dialog.showModal();
}
$("recent-btn").addEventListener("click", showRecent);
recent.dialog.querySelector("[data-recent-close]").addEventListener("click", () => recent.dialog.close());

els.file.addEventListener("change", () => {
  const f = els.file.files[0];
  if (f) openFile(f);
  els.file.value = "";
});
const oneDrive = new OneDriveDialog({ dialog: $("od"), onOpenFile: (file) => openFile(file), defaultClientId: CLIENT_ID });
$("od-btn").addEventListener("click", () => oneDrive.open());
// サインインの画面遷移から戻ってきたときは、続きの画面を自動で開く
if (/[#&](code|error)=/.test(location.hash)) oneDrive.open();

els.fit.addEventListener("click", () => viewer.fit());
els.layersBtn.addEventListener("click", () => { els.panel.hidden = !els.panel.hidden; });
els.panelClose.addEventListener("click", () => { els.panel.hidden = true; });
els.allOn.addEventListener("click", () => layerPanel.setAll(true));
els.allOff.addEventListener("click", () => layerPanel.setAll(false));
els.theme.addEventListener("click", () => {
  state.dark = !state.dark;
  document.documentElement.dataset.theme = state.dark ? "dark" : "light";
  viewer.setDark(state.dark);
});

// ---- ドラッグ&ドロップ: 画面のどこにドロップしても開く(ブラウザが、ファイルを直接開いてしまうのを防ぐ) ----
const isDrawingName = (name) => /\.(jww|jwc|dxf)$/i.test(name);
// ファイルそのもの、または、別の窓のエクスプローラーが渡すファイルのアドレス(text/uri-list)
const hasFiles = (ev) => {
  if (ev.target instanceof Element && ev.target.closest("input, textarea, [contenteditable]")) return false; // 入力欄への文字のドロップは、入力欄に任せる
  return (ev.dataTransfer?.types?.length ?? 0) > 0;
};
const payloadTexts = (dt) => {
  const get = (t) => { try { return dt.getData(t) || ""; } catch { return ""; } };
  return { "text/uri-list": get("text/uri-list"), "text/plain": get("text/plain"), "text/html": get("text/html") };
};
let dragDepth = 0;
window.addEventListener("dragenter", (ev) => {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  dragDepth += 1;
  els.stage.classList.add("drag");
  if (dragDepth === 1) setStatus(`ドラッグを検知しました(形式: ${[...ev.dataTransfer.types].join(", ")})`);
});
window.addEventListener("dragover", (ev) => {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", (ev) => {
  if (!hasFiles(ev)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.stage.classList.remove("drag");
});
window.addEventListener("drop", (ev) => {
  dragDepth = 0;
  els.stage.classList.remove("drag");
  if (!hasFiles(ev)) return; // ファイルでないもの(文字・リンクなど)は、ここでは扱わない
  ev.preventDefault();
  if (document.querySelector("dialog[open]")) return; // 開いているダイアログの操作中は、図面を切り替えない
  const files = [...(ev.dataTransfer.files ?? [])];
  const f = files.find((x) => isDrawingName(x.name));
  if (!f && files.length === 0) {
    // ファイルがなく、アドレスだけが落とされた(分割画面のエクスプローラーから)
    const texts = payloadTexts(ev.dataTransfer);
    const target = pickDrawingUrl(Object.values(texts).join(" "), EXPLORER_HOSTS);
    if (!target) {
      setStatus(`図面のアドレスではないため、開きません。${describePayload([...ev.dataTransfer.types], texts)}`);
      return;
    }
    setStatus(`エクスプローラーから「${target.name}」を取得しています…`);
    fetchDrawing(target).then((file) => openFile(file), (err) => setStatus(err.message));
    return;
  }
  if (!f) {
    setStatus(files.length ? `「${files[0].name}」は開けません。開けるのは .jww / .jwc / .dxf です。` : "ファイルを受け取れませんでした。");
    return;
  }
  if (files.length > 1) setStatus(`${files.length}個のファイルのうち、「${f.name}」を開きます(一度に開けるのは1つです)`);
  openFile(f);
});

// ---- PWA: オフライン対応と、他のアプリからの「共有」受け取り ----
const SHARED_CACHE = "jww-reading-shared";

async function openSharedFile() {
  const params = new URLSearchParams(location.search);
  if (!params.has("shared")) return;
  params.delete("shared");
  const query = params.toString();
  history.replaceState(null, "", location.pathname + (query ? `?${query}` : "") + location.hash);
  try {
    const cache = await caches.open(SHARED_CACHE);
    const res = await cache.match(new URL("./__shared__", location.href).href);
    if (!res) {
      setStatus("共有されたファイルを受け取れませんでした。「開く」から選んでください。");
      return;
    }
    const name = decodeURIComponent(res.headers.get("x-file-name") ?? "shared.jww");
    const bytes = await res.arrayBuffer();
    await cache.delete(new URL("./__shared__", location.href).href); // 端末内の一時コピーはすぐ消す
    await openFile(new File([bytes], name));
  } catch (err) {
    setStatus(`共有されたファイルを開けませんでした: ${err?.message ?? err}`);
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js")
    .then((reg) => {
      // アプリを開いたままでも、画面に戻ったときに、新しい版がないか確認する
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
    })
    .catch((err) => console.warn("Service Workerを登録できませんでした", err));
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) {
      hadController = true; // 初めての登録は、更新ではない
      return;
    }
    // 新しい版に切り替わった。図面を開いていなければ自動で読み込み直し、開いていれば本人に選んでもらう
    if (!state.model) location.reload();
    else $("update").hidden = false;
  });
  $("update-btn").addEventListener("click", () => location.reload());
}
openSharedFile();

// アプリを開いたとき、前回の図面があれば、自動で開く(共有で受け取った図面があるときは、そちらを優先する)
(async () => {
  if (new URLSearchParams(location.search).has("shared") || /[#&](code|error)=/.test(location.hash)) return;
  const last = await library.last();
  if (last && !state.model) {
    setStatus(`前回の図面を開いています: ${last.name}`);
    await openFile(new File([last.bytes], last.name), { fromLibrary: true });
  }
})();

// 検証用: ?debug を付けて開いたときだけ、画面から状態を確認できるようにする
if (new URLSearchParams(location.search).has("debug")) window.__jww = { state, viewer, toolkit };
