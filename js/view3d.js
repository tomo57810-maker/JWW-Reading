// 3D表示。three.js(vendor/)を使い、部品(parts3d.js が作る形)と、床に敷く平面図を表示する。
// 指1本で回す、2本で拡大・移動(OrbitControlsの既定)。
import { aciToRgb } from "./aci.js";
import { segmentsOf } from "./parts3d.js";

const WALL_DEFAULT = [150, 160, 172];
const PIPE_DEFAULT = [30, 111, 217];

function partColor(aci, kind) {
  if (!Number.isInteger(aci) || aci === 7 || aci === 0) return kind === "pipe" ? PIPE_DEFAULT : WALL_DEFAULT;
  return aciToRgb(aci, false);
}

export class View3D {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ready = null;
    this.T = null; // three.js
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.partsGroup = null;
    this.planLines = null;
    this.bounds = null; // 表示物を囲む箱(m)
    this.raf = 0;
  }

  async #init() {
    const [T, { OrbitControls }] = await Promise.all([import("three"), import("three/addons/controls/OrbitControls.js")]);
    this.T = T;
    this.renderer = new T.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new T.Scene();
    this.scene.background = new T.Color(0xeef1f5);
    this.camera = new T.PerspectiveCamera(45, 1, 0.05, 5000);
    this.scene.add(new T.HemisphereLight(0xffffff, 0x8890a0, 1.6));
    const sun = new T.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-6, 12, 8);
    this.scene.add(sun);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = true;
    this.partsGroup = new T.Group();
    this.scene.add(this.partsGroup);
    this.scene.add(new T.AxesHelper(1));
  }

  async init() {
    this.ready ??= this.#init();
    await this.ready;
  }

  resize() {
    if (!this.renderer) return;
    const r = this.canvas.parentElement.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width));
    const h = Math.max(1, Math.floor(r.height));
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  #clear(group) {
    for (const o of [...group.children]) {
      group.remove(o);
      o.traverse?.((c) => {
        c.geometry?.dispose();
        if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose());
      });
    }
  }

  /** 部品の形(buildScene の結果)を、3Dに置く。 */
  setParts(shapes) {
    const T = this.T;
    this.#clear(this.partsGroup);
    const mats = new Map();
    const mat = (rgb) => {
      const k = rgb.join(",");
      if (!mats.has(k)) mats.set(k, new T.MeshStandardMaterial({ color: new T.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255), side: T.DoubleSide, roughness: 0.8, metalness: 0.05 }));
      return mats.get(k);
    };
    // 面(壁)は、色ごとに1つの形にまとめる
    const byColor = new Map();
    for (const q of shapes.quads) {
      const rgb = partColor(q.color, q.kind);
      const k = rgb.join(",");
      if (!byColor.has(k)) byColor.set(k, { rgb, pos: [] });
      const [a, b, c, d] = q.c;
      byColor.get(k).pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
    const edgePos = [];
    for (const q of shapes.quads) {
      for (let i = 0; i < 4; i++) edgePos.push(...q.c[i], ...q.c[(i + 1) % 4]);
    }
    for (const { rgb, pos } of byColor.values()) {
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      this.partsGroup.add(new T.Mesh(g, mat(rgb)));
    }
    if (edgePos.length) {
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.Float32BufferAttribute(edgePos, 3));
      this.partsGroup.add(new T.LineSegments(g, new T.LineBasicMaterial({ color: 0x3a4250 })));
    }
    // 円筒・球
    const up = new T.Vector3(0, 1, 0);
    const cylGeo = new T.CylinderGeometry(1, 1, 1, 16, 1, false);
    const capless = new T.CylinderGeometry(1, 1, 1, 16, 1, true);
    for (const c of shapes.cyls) {
      const a = new T.Vector3(...c.a);
      const b = new T.Vector3(...c.b);
      const len = a.distanceTo(b);
      if (len === 0) continue;
      const m = new T.Mesh(c.cap ? cylGeo : capless, mat(partColor(c.color, c.kind)));
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(up, b.clone().sub(a).normalize());
      m.scale.set(c.r, len, c.r);
      this.partsGroup.add(m);
    }
    const sphGeo = new T.SphereGeometry(1, 12, 8);
    for (const s of shapes.spheres) {
      const m = new T.Mesh(sphGeo, mat(partColor(s.color, s.kind)));
      m.position.set(...s.c);
      m.scale.setScalar(s.r);
      this.partsGroup.add(m);
    }
    this.#boundsFrom(shapes);
  }

  #boundsFrom(shapes) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const add = (p) => {
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
      z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]);
    };
    for (const q of shapes.quads) q.c.forEach(add);
    for (const c of shapes.cyls) { add(c.a); add(c.b); }
    for (const s of shapes.spheres) add(s.c);
    this.bounds = x0 === Infinity ? null : { x0, y0, z0, x1, y1, z1 };
  }

  /**
   * 平面図を、床(高さ0)に敷く。entities: 編集後の図形、scale: 縮尺の分母、hidden: 非表示のレイヤ名の集合。
   * 部品が1つもないときは、この範囲を表示の中心にする。
   */
  setPlan(entities, { scale, hidden, visible }) {
    const T = this.T;
    if (this.planLines) {
      this.scene.remove(this.planLines);
      this.planLines.geometry.dispose();
      this.planLines.material.dispose();
      this.planLines = null;
    }
    if (!visible) return;
    const s = scale / 1000;
    const pos = [];
    const col = [];
    const push = (x1, y1, x2, y2, rgb) => {
      pos.push(x1 * s, 0, -y1 * s, x2 * s, 0, -y2 * s);
      col.push(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    };
    let x0 = Infinity, x1b = -Infinity, y0 = Infinity, y1b = -Infinity;
    for (const e of entities) {
      if (!e || hidden.has(e.layer)) continue;
      let segs = null;
      if (e.type === "LINE" || e.type === "ARC") segs = segmentsOf(e);
      else if (e.type === "CIRCLE") {
        segs = [];
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * 2 * Math.PI, b = ((i + 1) / 24) * 2 * Math.PI;
          segs.push([e.center_x + e.radius * Math.cos(a), e.center_y + e.radius * Math.sin(a), e.center_x + e.radius * Math.cos(b), e.center_y + e.radius * Math.sin(b)]);
        }
      }
      if (!segs) continue;
      const rgb = aciToRgb(e.color, false).map((v) => Math.round(v * 0.6 + 255 * 0.4)); // 薄くして、部品を目立たせる
      for (const sg of segs) {
        push(sg[0], sg[1], sg[2], sg[3], rgb);
        x0 = Math.min(x0, sg[0]); x1b = Math.max(x1b, sg[0]); y0 = Math.min(y0, sg[1]); y1b = Math.max(y1b, sg[1]);
      }
    }
    if (pos.length === 0) return;
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new T.Float32BufferAttribute(col, 3));
    this.planLines = new T.LineSegments(g, new T.LineBasicMaterial({ vertexColors: true }));
    this.scene.add(this.planLines);
    this.planBounds = { x0: x0 * s, x1: x1b * s, z0: -y1b * s, z1: -y0 * s };
  }

  /** 視点を決める: iso(斜め)/top(真上)/front(正面)。表示物(なければ平面図)の中心を見る。 */
  setView(kind) {
    const b = this.bounds ?? (this.planBounds ? { x0: this.planBounds.x0, x1: this.planBounds.x1, z0: this.planBounds.z0, z1: this.planBounds.z1, y0: 0, y1: 0 } : { x0: -5, x1: 5, z0: -5, z1: 5, y0: 0, y1: 3 });
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, cz = (b.z0 + b.z1) / 2;
    const size = Math.max(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0, 2);
    const d = size * 1.6;
    this.controls.target.set(cx, cy, cz);
    const T = this.T;
    const pos = kind === "top" ? new T.Vector3(cx, cy + d * 1.4, cz + 0.001) : kind === "front" ? new T.Vector3(cx, cy, cz + d * 1.4) : new T.Vector3(cx + d * 0.9, cy + d * 0.8, cz + d * 0.9);
    this.camera.position.copy(pos);
    this.camera.near = Math.max(0.02, size / 500);
    this.camera.far = size * 60;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  start() {
    cancelAnimationFrame(this.raf);
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }
}
