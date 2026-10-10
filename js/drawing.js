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

const LAYERS_PER_GROUP = 16;

/** Jw_cadと同じ表記(0〜9、A〜F)のレイヤ番号。例: グループ10・レイヤ3 → "A-3" */
export function layerLabel(groupIndex, layerIndex) {
  return `${groupIndex.toString(16).toUpperCase()}-${layerIndex.toString(16).toUpperCase()}`;
}

/**
 * JWWのレイヤ構成(16のレイヤグループ × 各16レイヤ)を作る。
 * ezjwwが返すレイヤ表は、グループ番号×16+レイヤ番号の順に並んでいる(実ファイルで全図形について確認済み)。
 * 図形が持つレイヤ名(dxf.layers[].name)から、グループとレイヤを引けるようにする。
 */
export function buildLayerGroups(dxfLayers, header, entities) {
  const groupsSrc = header?.layer_groups;
  const valid = Array.isArray(groupsSrc) && groupsSrc.length > 0 && dxfLayers.length >= groupsSrc.length * LAYERS_PER_GROUP;
  const groups = [];
  const byKey = new Map();
  if (valid) {
    groupsSrc.forEach((g, gi) => {
      const layers = g.layers.map((l, li) => {
        const key = dxfLayers[gi * LAYERS_PER_GROUP + li]?.name ?? null;
        const layer = {
          group: gi, index: li, key, label: layerLabel(gi, li),
          name: (l.name ?? "").trim(), state: l.state, count: 0,
          color: dxfLayers[gi * LAYERS_PER_GROUP + li]?.color ?? null,
        };
        if (key !== null) byKey.set(key, layer);
        return layer;
      });
      groups.push({ index: gi, name: (g.name ?? "").trim() || `グループ${gi}`, state: g.state, layers });
    });
  }
  // 表に載っていないレイヤ名の図形(想定外)は「その他」にまとめて、見えなくならないようにする
  let other = null;
  for (const e of entities) {
    let layer = byKey.get(e.layer);
    if (!layer) {
      if (!other) {
        other = { index: groups.length, name: valid ? "その他" : "すべてのレイヤ", state: 2, layers: [] };
        groups.push(other);
      }
      layer = { group: other.index, index: other.layers.length, key: e.layer, label: "", name: e.layer, state: 2, count: 0 };
      other.layers.push(layer);
      byKey.set(e.layer, layer);
    }
    layer.count += 1;
  }
  return groups;
}

/** ezjwwの変換結果を、画面表示用のモデルにまとめる。header はezjwwの readHeader の結果。 */
export function buildModel(dxf, header = null) {
  const entities = dxf.entities ?? [];
  const typeCounts = new Map();
  for (const e of entities) typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
  const groups = buildLayerGroups(dxf.layers ?? [], header, entities);
  // Jw_cadで「非表示」(状態0)のグループ・レイヤは、最初から隠す
  const initiallyHidden = new Set();
  for (const g of groups) {
    for (const l of g.layers) {
      if (l.key !== null && (g.state === 0 || l.state === 0)) initiallyHidden.add(l.key);
    }
  }
  // Jw_cadの「書込レイヤ」(図形を描き足すときの、レイヤと色)
  const wgIdx = header?.write_layer_group;
  const wlIdx = header?.layer_groups?.[wgIdx]?.write_layer;
  const wl = Number.isInteger(wgIdx) && Number.isInteger(wlIdx) ? groups[wgIdx]?.layers?.[wlIdx] : null;
  return {
    entities,
    bounds: boundsOf(entities),
    groups,
    writeLayer: wl && wl.key !== null ? { key: wl.key, color: wl.color ?? 7 } : null,
    initiallyHidden,
    writeGroup: Number.isInteger(header?.write_layer_group) ? header.write_layer_group : null,
    writeScale: header?.layer_groups?.[header?.write_layer_group]?.scale > 0 ? header.layer_groups[header.write_layer_group].scale : null,
    layerCount: groups.reduce((n, g) => n + g.layers.filter((l) => l.count > 0).length, 0),
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
