// OneDriveのファイル選択画面(ダイアログ)。フォルダをたどって、JWW/JWCを選ぶ。
import { OneDriveClient, isDrawingName } from "./onedrive.js";

const STORAGE_KEY = "jww-reading.clientId";

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStored(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 保存できない環境では、毎回入力してもらう
  }
}

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

export class OneDriveDialog {
  /**
   * @param {{ dialog: HTMLDialogElement, onOpenFile: (file: File) => void, defaultClientId?: string }} opts
   */
  constructor({ dialog, onOpenFile, defaultClientId = "" }) {
    this.dialog = dialog;
    this.onOpenFile = onOpenFile;
    this.defaultClientId = defaultClientId;
    this.client = null;
    this.stack = []; // [{ name, location }] いま開いているフォルダの道すじ
    this.showAll = false;
    this.body = dialog.querySelector("[data-od-body]");
    this.title = dialog.querySelector("[data-od-title]");
    dialog.querySelector("[data-od-close]").addEventListener("click", () => dialog.close());
  }

  get clientId() {
    return readStored() || this.defaultClientId;
  }

  async open() {
    if (!this.dialog.open) this.dialog.showModal();
    if (!this.clientId) return this.#renderSetup();
    this.#renderMessage("準備中…");
    try {
      if (!this.client) {
        this.client = new OneDriveClient({ clientId: this.clientId, redirectUri: new URL("./", location.href).href });
      }
      await this.client.ready;
    } catch (err) {
      return this.#renderError(err, { canReset: true });
    }
    if (!this.client.signedIn) return this.#renderSignIn();
    return this.#browse();
  }

  #renderSetup(message = "") {
    this.title.textContent = "OneDrive(初回設定)";
    const input = el("input", { type: "text", className: "search", placeholder: "アプリケーション(クライアント)ID", autocomplete: "off", spellcheck: false });
    const save = el("button", { className: "btn primary", type: "button" }, "保存して進む");
    save.addEventListener("click", () => {
      const value = input.value.trim();
      if (!/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) {
        this.#renderSetup("IDの形式が違います(例: 12345678-abcd-1234-abcd-1234567890ab)");
        return;
      }
      writeStored(value);
      this.client = null;
      this.open();
    });
    this.body.replaceChildren(
      el("p", {}, "OneDriveに直接つなぐには、Microsoft Entraでアプリを1つ登録し、その「アプリケーション(クライアント)ID」を入力します(初回のみ)。"),
      el("p", { className: "note" }, "手順は、リポジトリの docs/ONEDRIVE.md にあります。IDは秘密情報ではありません。"),
      input,
      ...(message ? [el("p", { className: "err" }, message)] : []),
      save
    );
  }

  #renderSignIn() {
    this.title.textContent = "OneDrive";
    const go = el("button", { className: "btn primary", type: "button" }, "Microsoftでサインイン");
    go.addEventListener("click", async () => {
      this.#renderMessage("サインイン中…");
      try {
        await this.client.signIn();
        if (this.client.signedIn) this.#browse();
      } catch (err) {
        this.#renderError(err);
      }
    });
    const reset = el("button", { className: "btn small", type: "button" }, "IDを入れ直す");
    reset.addEventListener("click", () => {
      writeStored("");
      this.client = null;
      this.open();
    });
    this.body.replaceChildren(
      el("p", {}, "大学や会社のアカウントでサインインすると、OneDriveのJWWを直接開けます。図面はこの端末にだけダウンロードされます。"),
      go,
      reset
    );
  }

  #renderMessage(text) {
    this.body.replaceChildren(el("p", { className: "note" }, text));
  }

  #renderError(err, { canReset = false } = {}) {
    const items = [el("p", { className: "err" }, err?.message ?? String(err))];
    const retry = el("button", { className: "btn", type: "button" }, "やり直す");
    retry.addEventListener("click", () => this.open());
    items.push(retry);
    if (canReset) {
      const reset = el("button", { className: "btn", type: "button" }, "IDを入れ直す");
      reset.addEventListener("click", () => {
        writeStored("");
        this.client = null;
        this.open();
      });
      items.push(reset);
    }
    this.body.replaceChildren(...items);
  }

  async #browse() {
    const here = this.stack.at(-1) ?? null;
    this.title.textContent = "OneDrive";
    this.#renderMessage("読み込み中…");
    let entries;
    try {
      entries = await this.client.list(here?.location ?? null);
    } catch (err) {
      return this.#renderError(err);
    }
    const visible = entries.filter((e) => e.isFolder || this.showAll || isDrawingName(e.name));

    const crumbs = el("nav", { className: "od-crumbs" });
    const top = el("button", { className: "btn small", type: "button" }, "OneDrive");
    top.addEventListener("click", () => { this.stack = []; this.#browse(); });
    crumbs.append(top);
    this.stack.forEach((s, i) => {
      const b = el("button", { className: "btn small", type: "button" }, s.name);
      b.addEventListener("click", () => { this.stack = this.stack.slice(0, i + 1); this.#browse(); });
      crumbs.append(b);
    });

    const opt = el("label", { className: "opt" }, el("input", { type: "checkbox", checked: this.showAll }), " JWW/JWC以外のファイルも表示");
    opt.querySelector("input").addEventListener("change", (ev) => { this.showAll = ev.target.checked; this.#browse(); });

    const list = el("ul", { className: "od-list" });
    for (const e of visible) {
      const li = el("li");
      const canOpen = e.isFolder || isDrawingName(e.name);
      const b = el("button", { className: "od-item", type: "button", disabled: !canOpen });
      b.append(
        el("span", { className: "od-icon" }, e.isFolder ? "📁" : "📐"),
        el("span", { className: "od-name" }, e.name),
        el("span", { className: "lcount" }, e.isFolder ? "" : formatSize(e.size))
      );
      b.addEventListener("click", () => (e.isFolder ? this.#enter(e) : this.#pick(e)));
      li.append(b);
      list.append(li);
    }
    if (visible.length === 0) list.append(el("li", { className: "layer-none" }, "ここにはJWW/JWCも、フォルダもありません"));

    const out = el("button", { className: "btn small", type: "button" }, `サインアウト(${this.client.accountName})`);
    out.addEventListener("click", async () => { await this.client.signOut(); this.stack = []; this.open(); });

    this.body.replaceChildren(crumbs, opt, list, out);
  }

  #enter(entry) {
    this.stack.push({ name: entry.name, location: entry.location });
    this.#browse();
  }

  async #pick(entry) {
    this.#renderMessage(`ダウンロード中: ${entry.name}`);
    try {
      const bytes = await this.client.download(entry);
      this.dialog.close();
      this.onOpenFile(new File([bytes], entry.name));
    } catch (err) {
      this.#renderError(err);
    }
  }
}
