// レイヤ一覧。Jw_cadと同じく「レイヤグループ → その中のレイヤ」の2段で表示する。

export class LayerPanel {
  /**
   * @param {{ list: HTMLElement, search: HTMLInputElement, showEmpty: HTMLInputElement, onChange: (hidden: Set<string>) => void }} opts
   */
  constructor({ list, search, showEmpty, onChange }) {
    this.list = list;
    this.search = search;
    this.showEmpty = showEmpty;
    this.onChange = onChange;
    this.model = null;
    this.hidden = new Set();
    this.open = new Set(); // 開いているグループ番号
    this.rows = []; // 画面上のグループごとの部品(チェックの同期用)
    search.addEventListener("input", () => this.render());
    showEmpty.addEventListener("change", () => this.render());
  }

  setModel(model) {
    this.model = model;
    this.hidden = new Set(model.initiallyHidden);
    this.open = new Set(model.writeGroup === null ? [] : [model.writeGroup]); // Jw_cadの書込グループを開いておく
    this.search.value = "";
    this.render();
  }

  /** 指定したレイヤを表示にする(図形を描き足したレイヤが、隠れていたときなど)。 */
  show(key) {
    if (!this.hidden.has(key)) return;
    this.hidden.delete(key);
    this.render();
    this.onChange(new Set(this.hidden));
  }

  /** 隠すレイヤを、まとめて設定する(前回の表示状態の復元)。 */
  setHidden(keys) {
    this.hidden = new Set(keys);
    this.render();
    this.onChange(new Set(this.hidden));
  }

  /** 表示する(true)/しない(false)を、全レイヤに設定する。 */
  setAll(visible) {
    if (!this.model) return;
    this.hidden = new Set();
    if (!visible) {
      for (const g of this.model.groups) for (const l of g.layers) if (l.key !== null) this.hidden.add(l.key);
    }
    this.#changed();
  }

  render() {
    this.list.replaceChildren();
    this.rows = [];
    if (!this.model) return;
    const filter = this.search.value.trim().toLowerCase();
    const showEmpty = this.showEmpty.checked;
    for (const group of this.model.groups) {
      const groupHit = filter && group.name.toLowerCase().includes(filter);
      const layers = group.layers.filter((l) => {
        if (l.key === null) return false;
        if (!showEmpty && l.count === 0) return false;
        if (!filter || groupHit) return true;
        return l.name.toLowerCase().includes(filter) || l.label.toLowerCase().includes(filter);
      });
      if (layers.length === 0) continue;
      this.#renderGroup(group, layers, Boolean(filter));
    }
    if (this.list.children.length === 0) {
      const li = document.createElement("li");
      li.className = "layer-none";
      li.textContent = filter ? "該当するレイヤがありません" : "表示できるレイヤがありません";
      this.list.append(li);
    }
    this.#sync();
  }

  #renderGroup(group, layers, forceOpen) {
    const li = document.createElement("li");
    const details = document.createElement("details");
    details.className = "lgroup";
    details.open = forceOpen || this.open.has(group.index);
    details.addEventListener("toggle", () => {
      if (details.open) this.open.add(group.index);
      else this.open.delete(group.index);
    });

    const summary = document.createElement("summary");
    const groupBox = document.createElement("input");
    groupBox.type = "checkbox";
    groupBox.setAttribute("aria-label", `${group.name}のすべてのレイヤを表示/非表示`);
    groupBox.addEventListener("change", () => {
      for (const l of layers) {
        if (l.count === 0) continue;
        if (groupBox.checked) this.hidden.delete(l.key);
        else this.hidden.add(l.key);
      }
      this.#changed();
    });
    const name = document.createElement("span");
    name.className = "gname";
    name.textContent = group.name;
    const summaryCount = document.createElement("span");
    summaryCount.className = "lcount";
    summary.append(groupBox, name, summaryCount);

    const ul = document.createElement("ul");
    ul.className = "llayers";
    const layerBoxes = [];
    for (const l of layers) {
      const item = document.createElement("li");
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.addEventListener("change", () => {
        if (box.checked) this.hidden.delete(l.key);
        else this.hidden.add(l.key);
        this.#changed();
      });
      const tag = document.createElement("span");
      tag.className = "ltag";
      tag.textContent = l.label;
      const lname = document.createElement("span");
      lname.className = "lname";
      lname.textContent = l.name || "(名前なし)";
      const n = document.createElement("span");
      n.className = "lcount";
      n.textContent = l.count.toLocaleString();
      label.append(box, tag, lname, n);
      if (l.count === 0) item.className = "empty-layer";
      item.append(label);
      ul.append(item);
      layerBoxes.push({ box, layer: l });
    }
    details.append(summary, ul);
    li.append(details);
    this.list.append(li);
    this.rows.push({ group, groupBox, summaryCount, layerBoxes });
  }

  /** チェックの状態と、グループの「表示中 n/m」を現在の表示設定に合わせる。 */
  #sync() {
    for (const { group, groupBox, summaryCount, layerBoxes } of this.rows) {
      for (const { box, layer } of layerBoxes) box.checked = !this.hidden.has(layer.key);
      const withShapes = group.layers.filter((l) => l.key !== null && l.count > 0);
      const shown = withShapes.filter((l) => !this.hidden.has(l.key)).length;
      groupBox.checked = withShapes.length > 0 && shown === withShapes.length;
      groupBox.indeterminate = shown > 0 && shown < withShapes.length;
      const total = withShapes.reduce((n, l) => n + l.count, 0);
      summaryCount.textContent = `${shown}/${withShapes.length}レイヤ · ${total.toLocaleString()}`;
    }
  }

  #changed() {
    this.#sync();
    this.onChange(new Set(this.hidden));
  }
}
