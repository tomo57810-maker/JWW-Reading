import { test } from "node:test";
import assert from "node:assert/strict";
import { OneDriveClient, toEntry, sortEntries, isDrawingName, GraphError, GRAPH, SCOPES_FULL, SCOPES_BASIC } from "../js/onedrive.js";

// MSALの代役。サインイン済みのアカウントと、固定のアクセストークンを返す。
function fakeMsal({ loginError = null, silentError = null } = {}) {
  class InteractionRequiredAuthError extends Error {}
  const calls = { login: [], silent: [] };
  class PublicClientApplication {
    constructor(config) { this.config = config; this.account = null; }
    async initialize() {}
    async handleRedirectPromise() { return null; }
    getActiveAccount() { return this.account; }
    getAllAccounts() { return []; }
    setActiveAccount(a) { this.account = a; }
    async loginPopup(req) {
      calls.login.push(req.scopes);
      const err = typeof loginError === "function" ? loginError(req.scopes) : loginError;
      if (err) throw err;
      return { account: { username: "tomo@example.ac.jp" } };
    }
    async acquireTokenSilent(req) {
      calls.silent.push(req.scopes);
      if (silentError) throw silentError;
      return { accessToken: "TOKEN" };
    }
  }
  return { PublicClientApplication, InteractionRequiredAuthError, calls };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("項目の整理: 共有ライブラリのショートカットは、実体の場所(driveId/itemId)を指す", () => {
  const shortcut = toEntry({
    id: "local-id", name: "業務用-personal - ドキュメント", size: 10,
    remoteItem: { id: "remote-id", folder: {}, parentReference: { driveId: "b!remote-drive" } },
    parentReference: { driveId: "my-drive" },
  });
  assert.deepEqual(shortcut.location, { driveId: "b!remote-drive", itemId: "remote-id" });
  assert.equal(shortcut.isFolder, true);
  assert.equal(shortcut.shortcut, true);
  const file = toEntry({ id: "f1", name: "M-38.jww", size: 1000, file: {}, parentReference: { driveId: "d1" } });
  assert.deepEqual(file.location, { driveId: "d1", itemId: "f1" });
  assert.equal(file.isFolder, false);
});

test("並び順: フォルダが先、あとは名前順(数字は大きさで比べる)", () => {
  const names = sortEntries([
    { name: "M-10.jww", isFolder: false },
    { name: "M-2.jww", isFolder: false },
    { name: "設計", isFolder: true },
  ]).map((e) => e.name);
  assert.deepEqual(names, ["設計", "M-2.jww", "M-10.jww"]);
});

test("JWW/JWCの判定は、大文字小文字を区別しない", () => {
  assert.equal(isDrawingName("a.JWW"), true);
  assert.equal(isDrawingName("a.jwc"), true);
  assert.equal(isDrawingName("a.jww.pdf"), false);
});

test("一覧: ページをたどって全件を取り、トークンを付けて呼ぶ", async () => {
  const msal = fakeMsal();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init?.headers?.Authorization });
    if (url.includes("page2")) return json({ value: [{ id: "2", name: "b.jww", file: {}, parentReference: { driveId: "d" } }] });
    return json({ value: [{ id: "1", name: "a", folder: {}, parentReference: { driveId: "d" } }], "@odata.nextLink": "https://graph.microsoft.com/page2" });
  };
  const client = new OneDriveClient({ clientId: "cid", redirectUri: "https://x/", msal, fetchImpl });
  await client.signIn();
  const entries = await client.list(null);
  assert.deepEqual(entries.map((e) => e.name), ["a", "b.jww"]);
  assert.ok(seen[0].url.startsWith(`${GRAPH}/me/drive/root/children`));
  assert.equal(seen[0].auth, "Bearer TOKEN");
  const sub = await client.list({ driveId: "b!x/y", itemId: "i 1" });
  assert.ok(seen.at(-2).url.startsWith(`${GRAPH}/drives/b!x%2Fy/items/i%201/children`), seen.at(-2).url);
  assert.ok(Array.isArray(sub));
});

test("ダウンロード: /content の結果を返す。CORSで失敗したら一時URLにフォールバックする", async () => {
  const msal = fakeMsal();
  const bytes = new Uint8Array([74, 119, 119]);
  let step = 0;
  const fetchImpl = async (url) => {
    step++;
    if (url.endsWith("/content")) throw new TypeError("Failed to fetch"); // CORSの失敗を模擬
    if (url.includes("downloadUrl") || url.includes("$select")) return json({ "@microsoft.graph.downloadUrl": "https://dl.example/file" });
    if (url === "https://dl.example/file") return new Response(bytes);
    throw new Error("想定外: " + url);
  };
  const client = new OneDriveClient({ clientId: "cid", redirectUri: "https://x/", msal, fetchImpl });
  await client.signIn();
  const got = await client.download({ location: { driveId: "d", itemId: "i" } });
  assert.deepEqual([...got], [74, 119, 119]);
  assert.equal(step, 3);
});

test("エラー: 403は管理者の許可の可能性を案内する", async () => {
  const msal = fakeMsal();
  const fetchImpl = async () => json({ error: { code: "accessDenied", message: "denied" } }, 403);
  const client = new OneDriveClient({ clientId: "cid", redirectUri: "https://x/", msal, fetchImpl });
  await client.signIn();
  await assert.rejects(client.list(null), (err) => err instanceof GraphError && err.status === 403 && /管理者/.test(err.message));
});

test("サインイン: 共有ライブラリの権限(Files.Read.All)が許可されないときは、Files.Readに切り替える", async () => {
  const msal = fakeMsal({
    loginError: (scopes) => (scopes === SCOPES_FULL ? Object.assign(new Error("x"), { errorCode: "access_denied", errorMessage: "AADSTS65001: consent" }) : null),
  });
  const client = new OneDriveClient({ clientId: "cid", redirectUri: "https://x/", msal, fetchImpl: async () => json({ value: [] }) });
  await client.signIn();
  assert.equal(client.signedIn, true);
  assert.deepEqual(client.scopes, SCOPES_BASIC);
  assert.deepEqual(msal.calls.login, [SCOPES_FULL, SCOPES_BASIC]);
});

test("サインイン: 管理者の許可が必要で、どちらも使えないときは、分かりやすく案内する", async () => {
  const msal = fakeMsal({ loginError: Object.assign(new Error("x"), { errorCode: "access_denied", errorMessage: "AADSTS90094: admin consent" }) });
  const client = new OneDriveClient({ clientId: "cid", redirectUri: "https://x/", msal, fetchImpl: async () => json({}) });
  await assert.rejects(client.signIn(), (err) => /管理者の許可/.test(err.message));
});

test("IDがないときは、作れない", () => {
  assert.throws(() => new OneDriveClient({ clientId: "", redirectUri: "https://x/", msal: fakeMsal() }), GraphError);
});
