import test from "node:test";
import assert from "node:assert/strict";
import { describePayload, fetchDrawing, pickDrawingUrl } from "../js/remote-drop.js";

const HOSTS = ["i-sf.tailbc9241.ts.net"];
const ID = "tDaZkaYPHaHZmyE18U2Etw";
const good = (name = "%E3%83%86%E3%82%B9%E3%83%88%E5%9B%B3%20(1).jww") => `https://i-sf.tailbc9241.ts.net:10000/api/dfile/${ID}/${name}`;

test("ドロップされたアドレス: 許可した接続先の図面用アドレスだけを選ぶ", () => {
  const r = pickDrawingUrl(good() + "?open=%2Fabc", HOSTS);
  assert.equal(r.name, "テスト図 (1).jww");
  assert.equal(r.url, good()); // ?open= は付けない
  assert.equal(pickDrawingUrl(good("a.DXF"), HOSTS).name, "a.DXF");
  assert.equal(pickDrawingUrl("# コメント\r\nhttps://example.com/x\r\n" + good("b.jwc"), HOSTS).name, "b.jwc"); // 行の途中の無関係なものは読み飛ばす
});

test("ドロップされたアドレス: 別の接続先・http・図面でない・形が違うものは取りに行かない", () => {
  assert.equal(pickDrawingUrl(good().replace("i-sf.tailbc9241.ts.net", "evil.example"), HOSTS), null);
  assert.equal(pickDrawingUrl(good().replace("https:", "http:"), HOSTS), null);
  assert.equal(pickDrawingUrl(good("memo.txt"), HOSTS), null);
  assert.equal(pickDrawingUrl(`https://i-sf.tailbc9241.ts.net/api/raw/${ID}/a.jww`, HOSTS), null);
  assert.equal(pickDrawingUrl(`https://i-sf.tailbc9241.ts.net/api/dfile/short/a.jww`, HOSTS), null);
  assert.equal(pickDrawingUrl(`https://i-sf.tailbc9241.ts.net.evil.example/api/dfile/${ID}/a.jww`, HOSTS), null);
  assert.equal(pickDrawingUrl(`https://user:pw@i-sf.tailbc9241.ts.net/api/dfile/${ID}/a.jww`, HOSTS), null);
  assert.equal(pickDrawingUrl(`https://i-sf.tailbc9241.ts.net/api/dfile/${ID}/..%2F..%2Fa.jww`.replace("..%2F..%2F", "x/y/"), HOSTS), null);
  assert.equal(pickDrawingUrl("", HOSTS), null);
  assert.equal(pickDrawingUrl(undefined, HOSTS), null);
});

test("図面の取得: 成功はFile、期限切れ・接続失敗・その他は、わけを添えた失敗", async () => {
  const target = { url: good(), name: "a.jww" };
  const ok = await fetchDrawing(target, async (url, opt) => {
    assert.equal(opt.credentials, "omit"); // ログイン情報(Cookie)は送らない
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  });
  assert.equal(ok.name, "a.jww");
  assert.equal(ok.size, 3);
  await assert.rejects(fetchDrawing(target, async () => ({ ok: false, status: 403 })), /期限が切れた/);
  await assert.rejects(fetchDrawing(target, async () => { throw new TypeError("Failed to fetch"); }), /接続できません/);
  await assert.rejects(fetchDrawing(target, async () => ({ ok: false, status: 500 })), /500/);
});

test("ドロップされたもの: 文章の中・HTMLのリンクからも拾う。何が渡ったかを文章にする", () => {
  assert.equal(pickDrawingUrl(`<a href="${good()}">図面</a>`, HOSTS).name, "テスト図 (1).jww");
  assert.equal(pickDrawingUrl(`C:\a\b.jww\n${good()}`, HOSTS).name, "テスト図 (1).jww");
  assert.equal(pickDrawingUrl("C:\a\b.jww", HOSTS), null);
  const d = describePayload(["text/plain"], { "text/plain": "C:\a\n b.jww", "text/uri-list": "" });
  assert.match(d, /text\/plain/);
  assert.match(d, /C:\a b\.jww/);
  assert.match(describePayload([], {}), /なし/);
});
