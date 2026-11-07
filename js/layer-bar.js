// Jw_cadと同じ並びの、レイヤグループ(0〜F)とレイヤ(0〜F)のボタン。
//  ・押す(タップ・左クリック): 表示 ⇄ 非表示
//  ・長押し・右クリック: 書込レイヤ(グループのボタンなら、書込グループ)にする
// レイヤのボタンには、書込グループの16レイヤを並べる。DXFなど、Jw_cadのレイヤ構成でない図面は、一覧のボタンだけ。

const HEX = "0123456789ABCDEF";
const LONG_PRESS_MS = 450;
const MOVE_PX = 10;

/** ボタンに、押す(tap)と長押し・右クリック(hold)を付ける。 */
function bindPress(btn, { tap, hold }) {
  let timer = 0;
  let held = false;
  let at = null;
  btn.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return; // 右クリックは contextmenu で扱う
    held = false;
    at = { x: ev.clientX, y: ev.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => {
      held = true;
      navigator.vibrate?.(15);
      hold();
    }, LONG_PRESS_MS);
  });
  btn.addEventListener("pointermove", (ev) => {
    if (at && Math.hypot(ev.clientX - at.x, ev.clientY - at.y) > MOVE_PX) clearTimeout(timer);
  });
  const stop = () => clearTimeout(timer);
  btn.addEventListener("pointerup", stop);
  btn.addEventListener("pointercancel", stop);
  btn.addEventListener("pointerleave", stop);
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (held) {
      held = false;
      return;
    }
    tap();
  });
  btn.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    clearTimeout(timer);
    if (held) return; // 長押しで、すでに処理した(携帯は、長押しのあとに contextmenu が来ることがある)
    held = true;
    hold();
  });
}

export class LayerBar {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root 入れ物
   * @param {() => object|null} o.getModel いまの図面のモデル(groups, writeLayer, writeGroup)
   * @param {() => Set<string>} o.getHidden 隠しているレイヤ名
   * @param {(keys: string[], visible: boolean) => void} o.setVisible レイヤの表示を変える
   * @param {(layer: object, group: object) => void} o.setWrite 書込レイヤにする
   * @param {() => void} o.openList レイヤの一覧(名前つき)を開く
   */
  constructor({ root, getModel, getHidden, setVisible, setWrite, openList }) {
    Object.assign(this, { root, getModel, getHidden, setVisible, setWrite, openList });
    root.replaceChildren();
    const make = (cls, label) => {
      const h = document.createElement("div");
      h.className = cls;
      h.textContent = label;
      return h;
    };
    this.groupBtns = [];
    this.layerBtns = [];
    const gGrid = make("lb-grid", "");
    const lGrid = make("lb-grid", "");
    for (let i = 0; i < 16; i++) {
      const g = document.createElement("button");
      g.type = "button";
      g.className = "lb-btn";
      g.textContent = HEX[i];
      bindPress(g, { tap: () => this.#toggleGroup(i), hold: () => this.#writeGroup(i) });
      gGrid.append(g);
      this.groupBtns.push(g);
      const l = document.createElement("button");
      l.type = "button";
      l.className = "lb-btn";
      l.textContent = HEX[i];
      bindPress(l, { tap: () => this.#toggleLayer(i), hold: () => this.#writeLayer(i) });
      lGrid.append(l);
      this.layerBtns.push(l);
    }
    this.allBtn = document.createElement("button");
    this.allBtn.type = "button";
    this.allBtn.className = "lb-btn lb-wide";
    this.allBtn.textContent = "All";
    this.allBtn.title = "書込グループのレイヤを、すべて表示/非表示";
    this.allBtn.addEventListener("click", () => this.#toggleAll());
    this.listBtn = document.createElement("button");
    this.listBtn.type = "button";
    this.listBtn.className = "lb-btn lb-wide";
    this.listBtn.textContent = "一覧";
    this.listBtn.title = "レイヤ名の一覧を開く";
    this.listBtn.addEventListener("click", () => this.openList());
    this.jw = document.createElement("div");
    this.jw.className = "lb-jw";
    this.jw.append(make("lb-head", "グループ"), gGrid, make("lb-head", "レイヤ"), lGrid, this.allBtn);
    root.append(this.jw, this.listBtn);
    this.refresh();
  }

  /** Jw_cadのレイヤ構成(16グループ×16レイヤ)か。 */
  #jwGroups() {
    const m = this.getModel();
    if (!m) return null;
    const gs = m.groups.filter((g) => g.index < 16 && g.layers.length === 16 && g.layers.some((l) => l.key !== null && l.label));
    return gs.length ? gs : null;
  }

  #group(i) {
    return this.#jwGroups()?.find((g) => g.index === i) ?? null;
  }

  /** レイヤのボタンに並べるグループ(=書込グループ)。 */
  #shownGroup() {
    const m = this.getModel();
    const gs = this.#jwGroups();
    if (!m || !gs) return null;
    const wk = m.writeLayer?.key;
    return gs.find((g) => g.layers.some((l) => l.key === wk)) ?? gs.find((g) => g.index === m.writeGroup) ?? gs[0];
  }

  #toggleLayer(i) {
    const g = this.#shownGroup();
    const l = g?.layers[i];
    if (!l || l.key === null) return;
    if (l.key === this.getModel()?.writeLayer?.key) return; // 書込レイヤは隠さない(Jw_cadと同じ)
    this.setVisible([l.key], this.getHidden().has(l.key));
    this.refresh();
  }

  #writeLayer(i) {
    const g = this.#shownGroup();
    const l = g?.layers[i];
    if (!l || l.key === null) return;
    this.setWrite(l, g);
    this.refresh();
  }

  #toggleGroup(i) {
    const g = this.#group(i);
    if (!g) return;
    const keys = g.layers.filter((l) => l.key !== null).map((l) => l.key);
    const hidden = this.getHidden();
    const wk = this.getModel()?.writeLayer?.key;
    const anyShown = keys.some((k) => !hidden.has(k));
    // 書込グループを隠すときも、書込レイヤだけは残す
    this.setVisible(anyShown ? keys.filter((k) => k !== wk) : keys, !anyShown);
    this.refresh();
  }

  #writeGroup(i) {
    const g = this.#group(i);
    if (!g) return;
    // 書込グループを変えるとき、レイヤは、いまの書込レイヤと同じ番号を使う(なければ、図形のある最初のレイヤ)
    const cur = this.#shownGroup()?.layers.findIndex((l) => l.key === this.getModel()?.writeLayer?.key) ?? 0;
    const l = (cur >= 0 && g.layers[cur]?.key !== null ? g.layers[cur] : null) ?? g.layers.find((x) => x.key !== null && x.count > 0) ?? g.layers.find((x) => x.key !== null);
    if (!l) return;
    this.setWrite(l, g);
    this.refresh();
  }

  #toggleAll() {
    const g = this.#shownGroup();
    if (!g) return;
    const wk = this.getModel()?.writeLayer?.key;
    const keys = g.layers.filter((l) => l.key !== null && l.key !== wk).map((l) => l.key);
    const hidden = this.getHidden();
    this.setVisible(keys, keys.some((k) => hidden.has(k)));
    this.refresh();
  }

  /** ボタンの見た目を、いまの表示・書込に合わせる。 */
  refresh() {
    const m = this.getModel();
    const gs = this.#jwGroups();
    this.root.hidden = !m;
    this.jw.hidden = !gs;
    if (!m || !gs) return;
    const hidden = this.getHidden();
    const wk = m.writeLayer?.key;
    const shown = this.#shownGroup();
    for (let i = 0; i < 16; i++) {
      const g = gs.find((x) => x.index === i);
      const gb = this.groupBtns[i];
      const keys = g ? g.layers.filter((l) => l.key !== null) : [];
      const count = keys.reduce((n, l) => n + l.count, 0);
      const vis = keys.some((l) => l.count > 0 && !hidden.has(l.key));
      gb.disabled = !g;
      gb.classList.toggle("lb-w", g === shown);
      gb.classList.toggle("lb-off", Boolean(g) && count > 0 && !vis);
      gb.classList.toggle("lb-empty", count === 0);
      gb.title = g ? `${HEX[i]} ${g.name}${g === shown ? "(書込グループ)" : ""}\n押す: 表示/非表示 長押し・右クリック: 書込グループにする` : "";
      const l = shown?.layers[i];
      const lb = this.layerBtns[i];
      lb.disabled = !l || l.key === null;
      const isW = Boolean(l) && l.key === wk;
      lb.classList.toggle("lb-w", isW);
      lb.classList.toggle("lb-off", Boolean(l) && l.key !== null && hidden.has(l.key));
      lb.classList.toggle("lb-empty", !l || l.count === 0);
      lb.title = l ? `${l.label} ${l.name || "(名前なし)"} ${l.count.toLocaleString()}個${isW ? "(書込レイヤ)" : ""}\n押す: 表示/非表示 長押し・右クリック: 書込レイヤにする` : "";
    }
  }
}
