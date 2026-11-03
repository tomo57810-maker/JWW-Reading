// 複数の図面(JWW・JWC・DXF)を、順に読み込んで、PDFにする。注釈や図形の編集は含めず、Jw_cadで表示される状態(非表示のレイヤは除く)の原本どおりにする。
import { Viewer } from "./viewer.js";
import { DRAWING_NAME_RE, loadModel } from "./load-drawing.js";
import { makeJpegPdfPages } from "./pdf.js";

const MARGIN_MM = 5;

export const baseNameOf = (name) => name.replace(/\.(jww|jwc|dxf)$/i, "");

/** 1つの図面(モデル)を、用紙の大きさに合わせたJPEGの1ページにする。図形がなければ null。 */
export async function renderPage(viewer, model, longSidePx) {
  const b = model.bounds;
  if (!b) return null;
  viewer.setModel(model, new Set(model.initiallyHidden));
  const pageWidthMm = b.x1 - b.x0 + MARGIN_MM * 2;
  const pageHeightMm = b.y1 - b.y0 + MARGIN_MM * 2;
  const pxPerMm = longSidePx / Math.max(pageWidthMm, pageHeightMm);
  const canvas = document.createElement("canvas");
  try {
    canvas.width = Math.max(1, Math.round(pageWidthMm * pxPerMm));
    canvas.height = Math.max(1, Math.round(pageHeightMm * pxPerMm));
    viewer.renderToCanvas(canvas, { withOverlay: false, marginPx: MARGIN_MM * pxPerMm });
    const blob = await new Promise((resolve, reject) => canvas.toBlob((x) => (x ? resolve(x) : reject(new Error("画像を作れませんでした"))), "image/jpeg", 0.92));
    return { jpeg: new Uint8Array(await blob.arrayBuffer()), widthPx: canvas.width, heightPx: canvas.height, pageWidthMm, pageHeightMm };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

/**
 * ファイルを順にPDFにする。
 * @param files File の並び
 * @param opts.onePdf true: 1つのPDF(1図面=1ページ)、false: 図面ごとのPDF
 * @param opts.longSidePx 画像の長辺の画素数
 * @param opts.onProgress (done, total, name) => void
 * @returns {{ outputs: {name, blob}[], failed: {name, reason}[], pages: number }}
 */
export async function batchToPdf(files, { onePdf = true, longSidePx = 4000, onProgress = () => {}, now = () => new Date() } = {}) {
  const list = [...files].filter((f) => DRAWING_NAME_RE.test(f.name));
  const viewer = new Viewer(document.createElement("canvas"));
  const pages = [];
  const separate = [];
  const failed = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    onProgress(i, list.length, f.name);
    await new Promise((r) => setTimeout(r, 0)); // 表示を更新させる
    try {
      const { model } = await loadModel(f.name, new Uint8Array(await f.arrayBuffer()));
      const page = await renderPage(viewer, model, longSidePx);
      if (!page) throw new Error("図形がありません");
      if (onePdf) pages.push({ ...page, name: f.name });
      else separate.push({ name: `${baseNameOf(f.name)}.pdf`, blob: new Blob([makeJpegPdfPages([page], baseNameOf(f.name))], { type: "application/pdf" }) });
    } catch (err) {
      failed.push({ name: f.name, reason: err?.message ?? String(err) });
    }
    onProgress(i + 1, list.length, f.name);
  }
  const outputs = [];
  if (onePdf && pages.length) {
    const d = now();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    outputs.push({ name: `図面まとめ_${stamp}_${pages.length}ページ.pdf`, blob: new Blob([makeJpegPdfPages(pages, "図面まとめ")], { type: "application/pdf" }) });
  } else outputs.push(...separate);
  return { outputs, failed, pages: onePdf ? pages.length : separate.length };
}
