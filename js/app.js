import { init, readDrawing, readHeader } from "../vendor/ezjww.mjs";
import { buildModel, explainNotDrawing } from "./drawing.js";
import { Viewer } from "./viewer.js";
import { LayerPanel } from "./layer-panel.js";
import { OneDriveDialog } from "./onedrive-dialog.js";
import { CLIENT_ID } from "./config.js";

const $ = (id) => document.getElementById(id);
const els = {
  file: $("file"), name: $("name"), fit: $("fit"), layersBtn: $("layers-btn"), theme: $("theme"),
  stage: $("stage"), canvas: $("canvas"), empty: $("empty"), busy: $("busy"), status: $("status"),
  panel: $("panel"), panelClose: $("panel-close"), allOn: $("all-on"), allOff: $("all-off"),
  search: $("layer-search"), list: $("layer-list"), showEmpty: $("show-empty"),
};

const state = { model: null, dark: false };
const viewer = new Viewer(els.canvas);
const layerPanel = new LayerPanel({
  list: els.list,
  search: els.search,
  showEmpty: els.showEmpty,
  onChange: (hidden) => viewer.setHiddenLayers(hidden),
});

const wasmReady = init().catch((err) => {
  setStatus(`読み込み部品の準備に失敗しました: ${err.message}`);
  throw err;
});

function setStatus(text) {
  els.status.textContent = text;
}

async function openFile(file) {
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
    const model = buildModel(readDrawing(bytes), readHeader(bytes));
    const ms = Math.round(performance.now() - t0);
    state.model = model;
    layerPanel.setModel(model);
    viewer.setModel(model, new Set(layerPanel.hidden));
    els.name.textContent = file.name;
    els.empty.hidden = true;
    els.fit.disabled = false;
    els.layersBtn.disabled = false;
    const unsupported = model.unsupported.length ? ` / 未対応の図形 ${model.unsupported.length}個は表示していません` : "";
    setStatus(`図形 ${model.entities.length.toLocaleString()}個 / レイヤ ${model.layerCount} / 読み込み ${ms}ms${unsupported}`);
  } catch (err) {
    setStatus(`開けませんでした: ${err?.message ?? err}`);
  } finally {
    els.busy.hidden = true;
  }
}

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

for (const type of ["dragenter", "dragover"]) {
  els.stage.addEventListener(type, (ev) => { ev.preventDefault(); els.stage.classList.add("drag"); });
}
for (const type of ["dragleave", "drop"]) {
  els.stage.addEventListener(type, (ev) => { ev.preventDefault(); els.stage.classList.remove("drag"); });
}
els.stage.addEventListener("drop", (ev) => {
  const f = ev.dataTransfer?.files?.[0];
  if (f) openFile(f);
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
  navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("Service Workerを登録できませんでした", err));
}
openSharedFile();

// 検証用: ?debug を付けて開いたときだけ、画面から状態を確認できるようにする
if (new URLSearchParams(location.search).has("debug")) window.__jww = { state, viewer };
