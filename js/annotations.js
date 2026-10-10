// 注釈(寸法・面積・ルート・赤ペン・コメント)。原本のJWWは書き換えず、座標(用紙mm)だけを別に保存する。

export const KINDS = ["dim", "area", "route", "pen", "text", "mark"];

export const COLORS = {
  dim: "#d81b60",
  area: "#1e88e5",
  route: "#f57c00",
  pen: "#e53935",
  text: "#e53935",
  mark: "#2e7d32",
  // 図面に描き足す図形(線・矩形・円)の作図中の見た目(確定すると、図面の図形になる)
  line: "#1565c0",
  rect: "#1565c0",
  circle: "#1565c0",
};

let counter = 0;
const newId = () => `a${Date.now().toString(36)}${(counter++).toString(36)}`;

export class AnnotationStore {
  constructor(onChange = () => {}) {
    this.items = [];
    this.settings = {}; // 縮尺など、図面ごとの設定
    this.onChange = onChange;
    this.undoStack = []; // 変更の直前の状態(JSON文字列)。「戻す」で、1つずつ戻る
    this.onCheckpoint = () => {}; // 状態を積んだとき(図形の編集との、共通の「戻す」の順序づけに使う)
  }

  /** 変更する直前に呼ぶ。いまの状態を、「戻す」ために積む。 */
  checkpoint() {
    this.undoStack.push(JSON.stringify(this.items));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.onCheckpoint();
  }

  /** 直前の状態に戻す。戻せたら true。 */
  restoreLast() {
    const prev = this.undoStack.pop();
    if (prev === undefined) return false;
    this.items = JSON.parse(prev);
    this.onChange(this.items);
    return true;
  }

  /** 保存データ(JSON用)から読み込む。形式が違う項目は読み飛ばす。 */
  load(data) {
    const items = Array.isArray(data?.items) ? data.items : [];
    this.items = items.filter(isValidItem);
    this.undoStack = [];
    this.settings = data?.settings && typeof data.settings === "object" ? { ...data.settings } : {};
    this.onChange(this.items);
  }

  toJSON(fingerprint = null) {
    return { app: "JWW-Reading", version: 1, file: fingerprint, settings: this.settings, items: this.items };
  }

  add(item) {
    const full = { id: newId(), createdAt: new Date().toISOString(), ...item };
    if (!isValidItem(full)) throw new Error("注釈の形式が正しくありません");
    this.checkpoint();
    this.items.push(full);
    this.onChange(this.items);
    return full;
  }

  /** 注釈の中身を直接変えたあとに呼ぶ(保存・再描画のため)。 */
  touch() {
    this.onChange(this.items);
  }

  remove(id) {
    if (!this.items.some((i) => i.id === id)) return;
    this.checkpoint();
    this.items = this.items.filter((i) => i.id !== id);
    this.onChange(this.items);
  }

  /** 直前の変更を取り消す(追加・削除・移動・文字の修正のどれでも戻る)。 */
  undo() {
    return this.restoreLast();
  }

  clear() {
    if (this.items.length === 0) return;
    this.checkpoint();
    this.items = [];
    this.onChange(this.items);
  }
}

const isPoint = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);

export function isValidItem(item) {
  if (!item || !KINDS.includes(item.kind) || typeof item.id !== "string") return false;
  switch (item.kind) {
    case "dim": return Array.isArray(item.points) && item.points.length === 2 && item.points.every(isPoint);
    case "area": return Array.isArray(item.points) && item.points.length >= 3 && item.points.every(isPoint);
    case "route": return Array.isArray(item.points) && item.points.length >= 2 && item.points.every(isPoint);
    case "pen": return Array.isArray(item.points) && item.points.length >= 2 && item.points.every(isPoint);
    case "text": return isPoint(item.at) && typeof item.text === "string" && item.text.length > 0;
    case "mark": return isPoint(item.at);
    default: return false;
  }
}

/** ファイルを見分けるための指紋(名前・大きさ・内容のSHA-256)。同じ図面の注釈を呼び戻すのに使う。 */
export async function fingerprintOf(name, bytes, subtle = globalThis.crypto?.subtle) {
  let hash = "";
  if (subtle) {
    const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
    hash = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return { name, size: bytes.length, sha256: hash };
}

export function storageKey(fp) {
  return fp.sha256 ? `sha256:${fp.sha256}` : `name:${fp.name}:${fp.size}`;
}

/**
 * 端末のIndexedDBへの保存(注釈・作業中の下書き・最後に開いた図面・図面ファイルの控え)。
 * 使えない環境(プライベートモード等)では、何もせず null / false を返す。
 *   annotations: 保存した状態と下書き     meta: 最後に開いた図面・表示位置など
 *   files: 図面ファイルの情報(小さい)    blobs: 図面ファイルの中身
 */
export const STORES = ["annotations", "meta", "files", "blobs"];

export class LocalAnnotationStorage {
  constructor(dbName = "jww-reading") {
    this.dbName = dbName;
    this.dbPromise = null;
  }

  #db() {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") return reject(new Error("IndexedDBが使えません"));
        const req = indexedDB.open(this.dbName, 2);
        req.onupgradeneeded = () => {
          for (const name of STORES) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }

  async #run(store, mode, fn) {
    const db = await this.#db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req?.result ?? null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async get(key, store = "annotations") {
    try {
      return (await this.#run(store, "readonly", (s) => s.get(key))) ?? null;
    } catch {
      return null;
    }
  }

  async set(key, value, store = "annotations") {
    try {
      await this.#run(store, "readwrite", (s) => s.put(value, key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key, store = "annotations") {
    try {
      await this.#run(store, "readwrite", (s) => s.delete(key));
      return true;
    } catch {
      return false;
    }
  }

  /** 保存してあるすべての値(キーと値の組)。 */
  async entries(store) {
    try {
      const db = await this.#db();
      return await new Promise((resolve, reject) => {
        const out = [];
        const req = db.transaction(store).objectStore(store).openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (c) {
            out.push([c.key, c.value]);
            c.continue();
          } else resolve(out);
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  }
}

/** 注釈の中心(面積の文字などを置く位置)。 */
export function centroid(points) {
  const n = points.length;
  return { x: points.reduce((a, p) => a + p.x, 0) / n, y: points.reduce((a, p) => a + p.y, 0) / n };
}

function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 点pに最も近い注釈(許容距離tol・用紙mm以内)を返す。「消す」「選択」で使う。 */
export function hitTest(items, p, tol) {
  let best = null;
  let bestD = tol;
  for (const item of items) {
    let d = Infinity;
    if (item.at) {
      d = Math.hypot(p.x - item.at.x, p.y - item.at.y); // コメント・基準点: 置いた位置からの距離
    } else {
      const pts = item.points;
      for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSegment(p, pts[i - 1], pts[i]));
      if (item.kind === "area") {
        d = Math.min(d, distToSegment(p, pts[pts.length - 1], pts[0]));
        if (pointInPolygon(p, pts)) d = 0;
      }
    }
    if (d <= bestD) {
      best = item;
      bestD = d;
    }
  }
  return best;
}
