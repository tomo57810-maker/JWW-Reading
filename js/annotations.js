// 注釈(寸法・面積・ルート・赤ペン・コメント)。原本のJWWは書き換えず、座標(用紙mm)だけを別に保存する。

export const KINDS = ["dim", "area", "route", "pen", "text"];

export const COLORS = {
  dim: "#d81b60",
  area: "#1e88e5",
  route: "#f57c00",
  pen: "#e53935",
  text: "#e53935",
};

let counter = 0;
const newId = () => `a${Date.now().toString(36)}${(counter++).toString(36)}`;

export class AnnotationStore {
  constructor(onChange = () => {}) {
    this.items = [];
    this.settings = {}; // 縮尺など、図面ごとの設定
    this.onChange = onChange;
  }

  /** 保存データ(JSON用)から読み込む。形式が違う項目は読み飛ばす。 */
  load(data) {
    const items = Array.isArray(data?.items) ? data.items : [];
    this.items = items.filter(isValidItem);
    this.settings = data?.settings && typeof data.settings === "object" ? { ...data.settings } : {};
    this.onChange(this.items);
  }

  toJSON(fingerprint = null) {
    return { app: "JWW-Reading", version: 1, file: fingerprint, settings: this.settings, items: this.items };
  }

  add(item) {
    const full = { id: newId(), createdAt: new Date().toISOString(), ...item };
    if (!isValidItem(full)) throw new Error("注釈の形式が正しくありません");
    this.items.push(full);
    this.onChange(this.items);
    return full;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length !== before) this.onChange(this.items);
  }

  undo() {
    const last = this.items.pop();
    if (last) this.onChange(this.items);
    return last ?? null;
  }

  clear() {
    if (this.items.length === 0) return;
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

/** 注釈を端末のIndexedDBに保存する。使えない環境(プライベートモード等)では、何もせず false を返す。 */
export class LocalAnnotationStorage {
  constructor(dbName = "jww-reading", storeName = "annotations") {
    this.dbName = dbName;
    this.storeName = storeName;
    this.dbPromise = null;
  }

  #db() {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") return reject(new Error("IndexedDBが使えません"));
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(this.storeName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }

  async get(key) {
    try {
      const db = await this.#db();
      return await new Promise((resolve, reject) => {
        const req = db.transaction(this.storeName).objectStore(this.storeName).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  async set(key, value) {
    try {
      const db = await this.#db();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, "readwrite");
        tx.objectStore(this.storeName).put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      return true;
    } catch {
      return false;
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

/** 点pに最も近い注釈(許容距離tol・用紙mm以内)を返す。「消す」で使う。 */
export function hitTest(items, p, tol) {
  let best = null;
  let bestD = tol;
  for (const item of items) {
    let d = Infinity;
    if (item.kind === "text") {
      d = Math.hypot(p.x - item.at.x, p.y - item.at.y);
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
