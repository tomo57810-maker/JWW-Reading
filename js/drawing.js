// ezjwwが返す図形データ(DXF相当)を、描画しやすい形に整理する。座標は用紙mm、Y軸は上向き。

const DASHES = {
  JWW_DASHED1: [2, 1],
  JWW_DASHED2: [4, 1.5],
  JWW_DASHED3: [6, 2],
  JWW_DASHDOT1: [6, 1.5, 1, 1.5],
  JWW_DASHDOT2: [8, 2, 1, 2],
  JWW_DIVIDE1: [10, 2, 1, 2, 1, 2],
  JWW_DIVIDE2: [14, 2, 1, 2, 1, 2],
};

/** 線種名から破線パターン(mm)を返す。未知の線種(SXF_USER_*など)は実線扱い。 */
export function dashFor(lineType) {
  return DASHES[lineType] ?? null;
}

/** 図形が占める範囲。図形がなければnull。 */
export function boundsOf(entities) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const e of entities) {
    switch (e.type) {
      case "LINE": add(e.x1, e.y1); add(e.x2, e.y2); break;
      case "SOLID": add(e.x1, e.y1); add(e.x2, e.y2); add(e.x3, e.y3); add(e.x4, e.y4); break;
      case "ARC":
      case "CIRCLE":
        add(e.center_x - e.radius, e.center_y - e.radius);
        add(e.center_x + e.radius, e.center_y + e.radius);
        break;
      case "TEXT": add(e.x, e.y); break;
      case "POINT": add(e.x, e.y); break;
      default: break;
    }
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

/** ezjwwの変換結果を、画面表示用のモデルにまとめる。 */
export function buildModel(dxf) {
  const entities = dxf.entities ?? [];
  const layerCounts = new Map();
  const typeCounts = new Map();
  for (const e of entities) {
    layerCounts.set(e.layer, (layerCounts.get(e.layer) ?? 0) + 1);
    typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
  }
  return {
    entities,
    bounds: boundsOf(entities),
    layerCounts,
    typeCounts,
    unsupported: dxf.unsupported_entities ?? [],
  };
}

/**
 * JWWとして読めないデータの原因を、利用者向けの文章で返す(読める見込みならnull)。
 * OneDriveの「共有」はファイル本体ではなくリンク(URL)を渡すため、その場合を見分ける。
 */
export function explainNotDrawing(bytes) {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 8)).toLowerCase();
  if (head.startsWith("http://") || head.startsWith("https://")) {
    return "ファイルではなく、リンク(URL)が共有されました。OneDriveの「共有」はリンクを渡します。OneDriveで「保存」してから、「開く」で選ぶか、マイファイルから共有してください。";
  }
  return null;
}
