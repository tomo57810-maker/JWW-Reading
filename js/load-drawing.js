// ファイル(JWW・JWC・DXF)のバイト列を、画面用のモデルにする。図面として開く・図形として取り込む・PDFにまとめる、で共通に使う。
import { init, readDrawing, readHeader } from "../vendor/ezjww.mjs";
import { buildModel } from "./drawing.js";
import { decodeDxf, isBinaryDxf, looksLikeDxf, readDxfDrawing } from "./dxf-import.js";

export const DRAWING_NAME_RE = /\.(jww|jwc|dxf)$/i;

/** 拡張子や中身から、DXFか。 */
export function isDxfFile(name, bytes) {
  return /\.dxf$/i.test(name) || looksLikeDxf(bytes);
}

/** DXFを、JWWと同じ画面用モデルにする(Jw_cadのレイヤグループはないので、すべてのレイヤを1グループにまとめる)。 */
export function modelFromDxf(bytes) {
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

/** バイト列から、モデルを作る。読めなければ、利用者向けの文章の Error。 */
export async function loadModel(name, bytes) {
  await init();
  const isDxf = isDxfFile(name, bytes);
  if (isDxf) {
    if (isBinaryDxf(bytes)) throw new Error("バイナリ形式のDXFは開けません。CADで「ASCII形式のDXF」として保存し直してください。");
    return { model: modelFromDxf(bytes), isDxf };
  }
  return { model: buildModel(readDrawing(bytes), readHeader(bytes)), isDxf };
}
