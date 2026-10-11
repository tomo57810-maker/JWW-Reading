// 平面図から、壁らしい線を見つける。
// 壁は、壁の厚み(60〜400mm)だけ離れた、平行で重なり合う「2本の長い線」で描かれていることが多い。
// 次のような線は、壁にしない: 短い線(扉・設備・ハッチの断片)、厚みが合わない線(配管の2本線・家具)、
// 平行な線がたくさん並ぶ線(ハッチング)、ハッチ・寸法・通り芯などのレイヤの線。

const SKIP_LAYER = /hatch|ハッチ|ﾊｯﾁ|寸法|dim|通芯|通り芯|壁芯|芯|center|centre|文字|text|letter|シンボル|symbol|点線|設備|equip|給水|給湯|排水|通気|ガス|電気|油管|汚水|雑排水|haisen/i;

/**
 * entities: 編集後の図形(消した図形は null)。scale: 縮尺の分母。bounds: 調べる範囲(用紙mm。なければ全体)。
 * 戻り値: { ids: 壁らしい線の番号, pairs: 見つけた「壁の組」の数 }
 */
export function detectWalls(entities, { scale = 100, bounds = null, isVisible = () => true, minLenMm = 400, minThickMm = 60, maxThickMm = 400, maxAngleDeg = 2, maxPartners = 6, orthoOnly = true, skipLayers = true } = {}) {
  const cosTol = Math.cos((maxAngleDeg * Math.PI) / 180);
  const lines = [];
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (!e || e.type !== "LINE" || !isVisible(e)) continue;
    if (skipLayers && SKIP_LAYER.test(e.layer ?? "")) continue;
    if (bounds) {
      const x0 = Math.min(e.x1, e.x2), x1 = Math.max(e.x1, e.x2), y0 = Math.min(e.y1, e.y2), y1 = Math.max(e.y1, e.y2);
      if (x1 < bounds.x0 || x0 > bounds.x1 || y1 < bounds.y0 || y0 > bounds.y1) continue;
    }
    // 実寸mmにする(縮尺をかける)
    const x1 = e.x1 * scale, y1 = e.y1 * scale, x2 = e.x2 * scale, y2 = e.y2 * scale;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < minLenMm) continue;
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    // 水平・垂直の線だけに限る(斜めの線は、引出線・ハッチなどが多い)
    if (orthoOnly && Math.min(Math.abs(ux), Math.abs(uy)) > Math.sin((maxAngleDeg * Math.PI) / 180)) continue;
    lines.push({ i, x1, y1, x2, y2, len, ux, uy, partners: 0 });
  }
  // 格子に入れて、近い線だけを比べる
  const cell = maxThickMm * 2;
  const grid = new Map();
  const key = (cx, cy) => `${cx},${cy}`;
  const span = (l) => [Math.floor((Math.min(l.x1, l.x2) - maxThickMm) / cell), Math.floor((Math.max(l.x1, l.x2) + maxThickMm) / cell), Math.floor((Math.min(l.y1, l.y2) - maxThickMm) / cell), Math.floor((Math.max(l.y1, l.y2) + maxThickMm) / cell)];
  lines.forEach((l, n) => {
    const [a, b, c, d] = span(l);
    for (let cx = a; cx <= b; cx++) for (let cy = c; cy <= d; cy++) {
      const k = key(cx, cy);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(n);
    }
  });
  const pairs = [];
  for (let n = 0; n < lines.length; n++) {
    const A = lines[n];
    const [a, b, c, d] = span(A);
    const seen = new Set();
    for (let cx = a; cx <= b; cx++) for (let cy = c; cy <= d; cy++) {
      for (const m of grid.get(key(cx, cy)) ?? []) {
        if (m <= n || seen.has(m)) continue;
        seen.add(m);
        const B = lines[m];
        if (Math.abs(A.ux * B.ux + A.uy * B.uy) < cosTol) continue; // 平行でない
        // Aの直線から、Bの両端までの距離(符号なし)。平行に近いので、中点の距離で代表させる
        const mx = (B.x1 + B.x2) / 2 - A.x1, my = (B.y1 + B.y2) / 2 - A.y1;
        const dist = Math.abs(mx * -A.uy + my * A.ux);
        if (dist < minThickMm || dist > maxThickMm) continue;
        // Aの向きに沿った重なり
        const pa = [0, A.len];
        const pb = [(B.x1 - A.x1) * A.ux + (B.y1 - A.y1) * A.uy, (B.x2 - A.x1) * A.ux + (B.y2 - A.y1) * A.uy].sort((p, q) => p - q);
        const overlap = Math.min(pa[1], pb[1]) - Math.max(pa[0], pb[0]);
        if (overlap < Math.min(minLenMm * 0.5, 0.5 * Math.min(A.len, B.len))) continue;
        pairs.push([n, m, dist]);
        A.partners += 1;
        B.partners += 1;
      }
    }
  }
  // 平行な線が7本以上近くに並ぶ線は、ハッチングなどなので、壁にしない
  const ok = new Set();
  let count = 0;
  for (const [n, m] of pairs) {
    if (lines[n].partners > maxPartners || lines[m].partners > maxPartners) continue;
    ok.add(lines[n].i);
    ok.add(lines[m].i);
    count += 1;
  }
  return { ids: [...ok].sort((p, q) => p - q), pairs: count };
}
