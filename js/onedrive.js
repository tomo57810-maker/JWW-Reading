// OneDrive(Microsoft Graph)から、JWWを直接取得する。図面はこの端末のブラウザに直接ダウンロードされ、他のサーバーには送られない。
// 認証には、ブラウザ用のMSAL(vendor/msal-browser.min.js)を使う。クライアントシークレットは使わない(SPA+PKCE)。

export const GRAPH = "https://graph.microsoft.com/v1.0";
const AUTHORITY = "https://login.microsoftonline.com/common";
// 自分のファイルだけなら Files.Read で足りる。共有ライブラリ(Teams等)の中身は Files.Read.All が必要で、組織によっては管理者の同意が要る。
export const SCOPES_FULL = ["Files.Read.All"];
export const SCOPES_BASIC = ["Files.Read"];

const CONSENT_ERRORS = ["AADSTS65001", "AADSTS90094", "AADSTS650057", "AADSTS500011", "consent_required", "access_denied"];

export class GraphError extends Error {
  constructor(message, { status = 0, code = "" } = {}) {
    super(message);
    this.name = "GraphError";
    this.status = status;
    this.code = code;
  }
}

const enc = encodeURIComponent;

/** Graphの項目を、一覧表示用の形にそろえる。共有ライブラリへのショートカット(remoteItem)は、実体の場所を指す。 */
export function toEntry(item) {
  const remote = item.remoteItem;
  const driveId = remote?.parentReference?.driveId ?? item.parentReference?.driveId ?? null;
  const itemId = remote?.id ?? item.id;
  return {
    name: item.name ?? "",
    size: item.size ?? remote?.size ?? 0,
    isFolder: Boolean(item.folder || remote?.folder),
    modified: item.lastModifiedDateTime ?? "",
    location: { driveId, itemId },
    shortcut: Boolean(remote),
  };
}

export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name, "ja", { numeric: true });
  });
}

export function isDrawingName(name) {
  return /\.(jww|jwc)$/i.test(name);
}

export class OneDriveClient {
  /**
   * @param {{ clientId: string, redirectUri: string, msal?: any, fetchImpl?: typeof fetch }} opts
   */
  constructor({ clientId, redirectUri, msal = globalThis.msal, fetchImpl = (...a) => globalThis.fetch(...a) }) {
    if (!clientId) throw new GraphError("アプリケーション(クライアント)IDが設定されていません");
    if (!msal) throw new GraphError("認証部品(MSAL)を読み込めていません");
    this.msal = msal;
    this.fetch = fetchImpl;
    this.scopes = SCOPES_FULL;
    this.app = new msal.PublicClientApplication({
      auth: { clientId, authority: AUTHORITY, redirectUri },
      cache: { cacheLocation: "localStorage" },
    });
    this.account = null;
    this.ready = this.#init();
  }

  async #init() {
    await this.app.initialize();
    const redirected = await this.app.handleRedirectPromise(); // リダイレクト方式で戻ってきた場合の後始末
    this.account = redirected?.account ?? this.app.getActiveAccount() ?? this.app.getAllAccounts()[0] ?? null;
    if (this.account) this.app.setActiveAccount(this.account);
  }

  get signedIn() {
    return Boolean(this.account);
  }

  get accountName() {
    return this.account?.username ?? "";
  }

  /** サインインする。ポップアップが使えないときは、画面遷移の方式に切り替える。 */
  async signIn() {
    await this.ready;
    let result;
    try {
      try {
        result = await this.#login(this.scopes);
      } catch (err) {
        if (this.scopes !== SCOPES_FULL || !isConsentError(err)) throw err;
        this.scopes = SCOPES_BASIC; // 共有ライブラリを見る権限が許可されない場合は、自分のファイルだけで続ける
        result = await this.#login(this.scopes);
      }
    } catch (err) {
      throw describeAuthError(err);
    }
    if (result?.account) {
      this.account = result.account;
      this.app.setActiveAccount(this.account);
    }
  }

  async #login(scopes) {
    try {
      return await this.app.loginPopup({ scopes, prompt: "select_account" });
    } catch (err) {
      if (err?.errorCode === "popup_window_error" || err?.errorCode === "empty_window_error") {
        await this.app.loginRedirect({ scopes, prompt: "select_account" }); // 戻ってくると、ページが読み込み直される
        return null;
      }
      throw err;
    }
  }

  async signOut() {
    await this.ready;
    const account = this.account;
    this.account = null;
    if (account) await this.app.logoutPopup({ account, postLogoutRedirectUri: this.app.config.auth.redirectUri }).catch(() => {});
  }

  async #token() {
    await this.ready;
    if (!this.account) throw new GraphError("サインインしてください", { code: "not_signed_in" });
    try {
      const res = await this.app.acquireTokenSilent({ scopes: this.scopes, account: this.account });
      return res.accessToken;
    } catch (err) {
      if (err instanceof this.msal.InteractionRequiredAuthError || err?.errorCode === "interaction_required") {
        const res = await this.app.acquireTokenPopup({ scopes: this.scopes, account: this.account });
        return res.accessToken;
      }
      throw describeAuthError(err);
    }
  }

  async #get(url, { raw = false } = {}) {
    const token = await this.#token();
    const res = await this.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw await toGraphError(res);
    return raw ? res : res.json();
  }

  /**
   * フォルダの中身を返す。location が null のときは、OneDriveの一番上。
   * @param {{ driveId: string, itemId: string } | null} location
   */
  async list(location = null) {
    let url = location
      ? `${GRAPH}/drives/${enc(location.driveId)}/items/${enc(location.itemId)}/children`
      : `${GRAPH}/me/drive/root/children`;
    url += "?$top=200&$select=id,name,size,folder,file,remoteItem,parentReference,lastModifiedDateTime";
    const entries = [];
    for (let guard = 0; url && guard < 100; guard++) {
      const page = await this.#get(url);
      for (const item of page.value ?? []) entries.push(toEntry(item));
      url = page["@odata.nextLink"] ?? null;
    }
    return sortEntries(entries);
  }

  /** ファイルの中身(バイト列)を取得する。 */
  async download(entry) {
    const { driveId, itemId } = entry.location;
    if (!driveId) throw new GraphError("ファイルの場所を特定できませんでした");
    try {
      const res = await this.#get(`${GRAPH}/drives/${enc(driveId)}/items/${enc(itemId)}/content`, { raw: true });
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof GraphError) throw err;
      // 転送先(ダウンロード専用URL)にCORSで届かない場合は、一時URLを取得して直接取りにいく
      const meta = await this.#get(`${GRAPH}/drives/${enc(driveId)}/items/${enc(itemId)}?$select=id,@microsoft.graph.downloadUrl`);
      const url = meta["@microsoft.graph.downloadUrl"];
      if (!url) throw err;
      const res = await this.fetch(url);
      if (!res.ok) throw await toGraphError(res);
      return new Uint8Array(await res.arrayBuffer());
    }
  }
}

function isConsentError(err) {
  const text = `${err?.errorCode ?? ""} ${err?.errorMessage ?? ""} ${err?.message ?? ""}`;
  return CONSENT_ERRORS.some((c) => text.includes(c));
}

function describeAuthError(err) {
  if (err instanceof GraphError) return err;
  if (isConsentError(err)) {
    return new GraphError("組織の設定により、このアプリの利用が許可されていません。管理者の許可が必要な可能性があります。", { code: "consent" });
  }
  if (err?.errorCode === "user_cancelled") return new GraphError("サインインが取り消されました", { code: "cancelled" });
  return new GraphError(`サインインに失敗しました: ${err?.errorMessage ?? err?.message ?? err}`, { code: err?.errorCode ?? "" });
}

async function toGraphError(res) {
  let code = "";
  let message = "";
  try {
    const body = await res.json();
    code = body?.error?.code ?? "";
    message = body?.error?.message ?? "";
  } catch {
    // 本文がJSONでない場合は、ステータスだけで案内する
  }
  const hint =
    res.status === 401 ? "サインインの期限が切れました。もう一度サインインしてください。" :
    res.status === 403 ? "このファイルを読む権限がありません。組織の設定(管理者の許可)が必要な可能性があります。" :
    res.status === 404 ? "ファイルまたはフォルダが見つかりません。" :
    `OneDriveから取得できませんでした(${res.status})`;
  return new GraphError(message ? `${hint} [${code || res.status}]` : hint, { status: res.status, code });
}
