// ezjww(npm)のWebAssemblyをブラウザ用ESMに変換して vendor/ に置く。
// ezjwwのnpm版はNode.js専用(fs.readFileSync でwasmを読む)ため、末尾の読み込み部分だけを
// fetch 方式に差し替え、`exports.xxx = xxx` を ESM の export に書き換える。
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "node_modules", "ezjww");
const out = join(root, "vendor");
mkdirSync(out, { recursive: true });

let src = readFileSync(join(pkg, "wasm", "ezjww_wasm.js"), "utf8");

const names = [...src.matchAll(/^exports\.(\w+) = \1;$/gm)].map((m) => m[1]);
if (names.length === 0) throw new Error("exports が見つかりません(ezjwwの構成が変わった可能性)");
src = src.replace(/^exports\.\w+ = \w+;\n/gm, "");

const tail = /const wasmPath = [\s\S]*?wasm\.__wbindgen_start\(\);\s*$/;
if (!tail.test(src)) throw new Error("末尾の読み込みコードが見つかりません(ezjwwの構成が変わった可能性)");
src = src.replace(
  tail,
  `let wasm;

/** wasmを読み込んで初期化する。最初に1回だけ呼ぶ。 */
export async function init(url = new URL("./ezjww_wasm_bg.wasm", import.meta.url)) {
    if (wasm) return;
    const res = await fetch(url);
    if (!res.ok) throw new Error("wasmの取得に失敗しました: " + res.status);
    const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), __wbg_get_imports());
    wasm = instance.exports;
    wasm.__wbindgen_start();
}

/** JWW/JWCをDXF相当の図形データに変換する(読み取り専用)。 */
export function readDrawing(bytes, { explodeInserts = true, maxBlockNesting = 32 } = {}) {
    return readDxfDocument(bytes, explodeInserts, maxBlockNesting, "paper_millimeters", 1);
}
`
);
src += `\nexport { ${names.join(", ")} };\n`;
src = `// 自動生成: scripts/vendor.mjs (ezjww ${JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version}, MIT)\n` + src;

writeFileSync(join(out, "ezjww.mjs"), src);
copyFileSync(join(pkg, "wasm", "ezjww_wasm_bg.wasm"), join(out, "ezjww_wasm_bg.wasm"));
copyFileSync(join(pkg, "LICENSE"), join(out, "LICENSE-ezjww"));
// Microsoft認証ライブラリ(OneDrive連携用)。ブラウザ用の単一ファイル版をそのまま置く。
const msalPkg = join(root, "node_modules", "@azure", "msal-browser");
copyFileSync(join(msalPkg, "lib", "msal-browser.min.js"), join(out, "msal-browser.min.js"));
copyFileSync(join(msalPkg, "LICENSE"), join(out, "LICENSE-msal-browser"));
console.log("vendor/ に出力しました:", names.length, "個のAPI + msal-browser");
