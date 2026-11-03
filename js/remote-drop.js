// 別の窓(分割画面のエクスプローラー)から、ファイルではなく「ファイルのアドレス」が落とされたときの受け取り。
// 取りに行ってよいのは、config.js の EXPLORER_HOSTS にある接続先の、図面用アドレス(/api/dfile/…、署名つき・10分・読むだけ)だけ。
// 落とされた文字列は、外から来たデータなので、ほかのアドレスは取りに行かない。

const DRAWING_RE = /\.(jww|jwc|dxf)$/i;

/** 落とされたアドレスの並び(text/uri-list)から、取りに行ってよい最初の図面のアドレスを選ぶ。なければ null。 */
export function pickDrawingUrl(uriList, allowedHosts) {
  for (const raw of String(uriList ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    let u;
    try {
      u = new URL(line);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" || u.username || u.password) continue;
    if (!allowedHosts.includes(u.hostname.toLowerCase())) continue;
    const m = /^\/api\/dfile\/([A-Za-z0-9_-]{16,64})\/([^/]+)$/.exec(u.pathname);
    if (!m) continue;
    let name;
    try {
      name = decodeURIComponent(m[2]);
    } catch {
      continue;
    }
    if (!DRAWING_RE.test(name)) continue;
    // 問い合わせ部分(?open=…)は、別の用途の印。取りに行くときは付けない
    return { url: `${u.origin}${u.pathname}`, name };
  }
  return null;
}

/** 図面のアドレスから、Fileを作る。失敗は、利用者向けの文章の Error にする。 */
export async function fetchDrawing({ url, name }, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(url, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  } catch {
    throw new Error("エクスプローラーに接続できません。ネットワークを確かめ、エクスプローラーの画面を更新してから、もう一度ドラッグしてください");
  }
  if (res.status === 403 || res.status === 404) {
    throw new Error("このアドレスは、期限が切れたか、無効です(10分で切れます)。エクスプローラーの画面を更新(再読み込み)してから、もう一度ドラッグしてください");
  }
  if (!res.ok) throw new Error(`エクスプローラーから取得できませんでした(${res.status})`);
  return new File([await res.arrayBuffer()], name);
}
