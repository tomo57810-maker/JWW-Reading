// 開いた図面ファイルを、端末の中(IndexedDB)に控えとして残す。アプリを閉じても、続きから開けるようにするため。
// 控えは、端末の外には送られない。最近の5件まで、合計150MBまで。

const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;

export class FileLibrary {
  /** @param {import("./annotations.js").LocalAnnotationStorage} storage */
  constructor(storage) {
    this.storage = storage;
  }

  /** 図面を控えに入れ、「最後に開いた図面」にする。保存できなかったときは false。 */
  async remember(key, name, bytes) {
    const ok = await this.storage.set(key, { key, name, size: bytes.length, openedAt: Date.now() }, "files");
    if (!ok) return false;
    const saved = await this.storage.set(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "blobs");
    if (!saved) {
      await this.storage.delete(key, "files");
      return false;
    }
    await this.storage.set("last", key, "meta");
    await this.#trim(key);
    return true;
  }

  /** 開いたことだけを記録する(控えは、すでにある)。 */
  async touch(key) {
    const info = await this.storage.get(key, "files");
    if (!info) return false;
    await this.storage.set(key, { ...info, openedAt: Date.now() }, "files");
    await this.storage.set("last", key, "meta");
    return true;
  }

  /** 新しい順の一覧(中身は含まない)。 */
  async list() {
    const all = (await this.storage.entries("files")).map(([, v]) => v);
    return all.sort((a, b) => b.openedAt - a.openedAt);
  }

  /** 最後に開いた図面を、{ name, bytes, key } で返す。なければ null。 */
  async last() {
    const key = await this.storage.get("last", "meta");
    return key ? this.load(key) : null;
  }

  async load(key) {
    const [info, buf] = await Promise.all([this.storage.get(key, "files"), this.storage.get(key, "blobs")]);
    if (!info || !buf) return null;
    return { key, name: info.name, bytes: new Uint8Array(buf) };
  }

  async remove(key) {
    await this.storage.delete(key, "files");
    await this.storage.delete(key, "blobs");
    if ((await this.storage.get("last", "meta")) === key) await this.storage.delete("last", "meta");
  }

  /** 古いものから消して、件数と合計の大きさを収める(いま開いている図面は残す)。 */
  async #trim(keepKey) {
    const items = await this.list();
    let total = items.reduce((n, i) => n + i.size, 0);
    for (let i = items.length - 1; i >= 0 && (items.length > MAX_FILES || total > MAX_TOTAL_BYTES); i--) {
      if (items[i].key === keepKey) continue;
      total -= items[i].size;
      await this.remove(items[i].key);
      items.splice(i, 1);
    }
  }
}

export { MAX_FILES, MAX_TOTAL_BYTES };
