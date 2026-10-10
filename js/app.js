import { init, readDrawing } from "../vendor/ezjww.mjs";
import { buildModel } from "./drawing.js";
import { Viewer } from "./viewer.js";

const $ = (id) => document.getElementById(id);
const els = {
  file: $("file"), name: $("name"), fit: $("fit"), layersBtn: $("layers-btn"), theme: $("theme"),
  stage: $("stage"), canvas: $("canvas"), empty: $("empty"), busy: $("busy"), status: $("status"),
  panel: $("panel"), panelClose: $("panel-close"), allOn: $("all-on"), allOff: $("all-off"),
  search: $("layer-search"), list: $("layer-list"),
};

const state = { model: null, hidden: new Set(), dark: false };
const viewer = new Viewer(els.canvas);

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
    const t0 = performance.now();
    const model = buildModel(readDrawing(bytes));
    const ms = Math.round(performance.now() - t0);
    state.model = model;
    state.hidden = new Set();
    viewer.setModel(model);
    els.name.textContent = file.name;
    els.empty.hidden = true;
    els.fit.disabled = false;
    els.layersBtn.disabled = false;
    renderLayerList();
    const unsupported = model.unsupported.length ? ` / 未対応の図形 ${model.unsupported.length}個は表示していません` : "";
    setStatus(`図形 ${model.entities.length.toLocaleString()}個 / レイヤ ${model.layerCounts.size} / 読み込み ${ms}ms${unsupported}`);
  } catch (err) {
    setStatus(`開けませんでした: ${err?.message ?? err}`);
  } finally {
    els.busy.hidden = true;
  }
}

function renderLayerList() {
  const filter = els.search.value.trim().toLowerCase();
  els.list.replaceChildren();
  if (!state.model) return;
  for (const [layer, count] of state.model.layerCounts) {
    if (filter && !layer.toLowerCase().includes(filter)) continue;
    const li = document.createElement("li");
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !state.hidden.has(layer);
    box.addEventListener("change", () => {
      if (box.checked) state.hidden.delete(layer);
      else state.hidden.add(layer);
      viewer.setHiddenLayers(new Set(state.hidden));
    });
    const name = document.createElement("span");
    name.className = "lname";
    name.textContent = layer;
    const n = document.createElement("span");
    n.className = "lcount";
    n.textContent = count.toLocaleString();
    label.append(box, name, n);
    li.append(label);
    els.list.append(li);
  }
}

function setAllLayers(visible) {
  if (!state.model) return;
  state.hidden = visible ? new Set() : new Set(state.model.layerCounts.keys());
  viewer.setHiddenLayers(new Set(state.hidden));
  renderLayerList();
}

els.file.addEventListener("change", () => {
  const f = els.file.files[0];
  if (f) openFile(f);
  els.file.value = "";
});
els.fit.addEventListener("click", () => viewer.fit());
els.layersBtn.addEventListener("click", () => { els.panel.hidden = !els.panel.hidden; });
els.panelClose.addEventListener("click", () => { els.panel.hidden = true; });
els.allOn.addEventListener("click", () => setAllLayers(true));
els.allOff.addEventListener("click", () => setAllLayers(false));
els.search.addEventListener("input", renderLayerList);
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
