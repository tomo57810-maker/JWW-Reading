// 画像(JPEG)1枚を貼った、1ページのPDFを作る。外部ライブラリは使わない。
// ページの大きさは、図面の用紙(mm)に合わせるので、そのままの大きさで印刷できる。

const enc = new TextEncoder();
const PT_PER_MM = 72 / 25.4;

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const fmt = (n) => (Math.round(n * 100) / 100).toString();

/** PDF文字列用に、(), \ をエスケープし、非ASCIIはUTF-16BEの16進で書く。 */
function pdfText(text) {
  const bytes = [0xfe, 0xff];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    bytes.push(c >> 8, c & 0xff);
  }
  return `<${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}>`;
}

/**
 * @param {{ jpeg: Uint8Array, widthPx: number, heightPx: number, pageWidthMm: number, pageHeightMm: number, title?: string }} opts
 * @returns {Uint8Array}
 */
export function makeJpegPdf({ jpeg, widthPx, heightPx, pageWidthMm, pageHeightMm, title = "" }) {
  if (!(jpeg instanceof Uint8Array) || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("JPEG画像ではありません");
  }
  const w = pageWidthMm * PT_PER_MM;
  const h = pageHeightMm * PT_PER_MM;
  const content = enc.encode(`q ${fmt(w)} 0 0 ${fmt(h)} 0 0 cm /Im0 Do Q\n`);
  const objs = [
    enc.encode("<< /Type /Catalog /Pages 2 0 R >>"),
    enc.encode("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    enc.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(w)} ${fmt(h)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),
    concat([
      enc.encode(`<< /Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
      jpeg,
      enc.encode("\nendstream"),
    ]),
    concat([enc.encode(`<< /Length ${content.length} >>\nstream\n`), content, enc.encode("endstream")]),
    enc.encode(`<< /Producer (JWW-Reading) ${title ? `/Title ${pdfText(title)} ` : ""}>>`),
  ];

  const parts = [enc.encode("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")];
  const offsets = [];
  let pos = parts[0].length;
  objs.forEach((body, i) => {
    offsets.push(pos);
    const chunk = concat([enc.encode(`${i + 1} 0 obj\n`), body, enc.encode("\nendobj\n")]);
    parts.push(chunk);
    pos += chunk.length;
  });
  const xrefPos = pos;
  const xref =
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  parts.push(enc.encode(xref));
  return concat(parts);
}
