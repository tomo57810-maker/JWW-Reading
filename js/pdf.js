// 画像(JPEG)を貼った、PDFを作る(1ページでも、複数ページでも)。外部ライブラリは使わない。
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

/** PDF文字列用に、非ASCIIも扱えるよう、UTF-16BEの16進で書く。 */
function pdfText(text) {
  const bytes = [0xfe, 0xff];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    bytes.push(c >> 8, c & 0xff);
  }
  return `<${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}>`;
}

const isJpeg = (b) => b instanceof Uint8Array && b.length >= 4 && b[0] === 0xff && b[1] === 0xd8;

/**
 * 画像(JPEG)を1ページずつ貼った、複数ページのPDFを作る。ページの大きさは、ページごとに違ってよい。
 * @param {{ jpeg: Uint8Array, widthPx: number, heightPx: number, pageWidthMm: number, pageHeightMm: number }[]} pages
 * @param {string} title
 * @returns {Uint8Array}
 */
export function makeJpegPdfPages(pages, title = "") {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error("ページがありません");
  if (!pages.every((p) => isJpeg(p.jpeg))) throw new Error("JPEG画像ではありません");
  // 番号: 1=Catalog, 2=Pages, 各ページ 3+3i(Page)・4+3i(画像)・5+3i(内容)、最後=Info
  const infoNo = 3 + pages.length * 3;
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  const objs = [
    enc.encode("<< /Type /Catalog /Pages 2 0 R >>"),
    enc.encode(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`),
  ];
  pages.forEach((p, i) => {
    const w = p.pageWidthMm * PT_PER_MM;
    const h = p.pageHeightMm * PT_PER_MM;
    const content = enc.encode(`q ${fmt(w)} 0 0 ${fmt(h)} 0 0 cm /Im0 Do Q\n`);
    objs.push(
      enc.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(w)} ${fmt(h)}] /Resources << /XObject << /Im0 ${4 + i * 3} 0 R >> >> /Contents ${5 + i * 3} 0 R >>`),
      concat([
        enc.encode(`<< /Type /XObject /Subtype /Image /Width ${p.widthPx} /Height ${p.heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`),
        p.jpeg,
        enc.encode("\nendstream"),
      ]),
      concat([enc.encode(`<< /Length ${content.length} >>\nstream\n`), content, enc.encode("endstream")])
    );
  });
  objs.push(enc.encode(`<< /Producer (JWW-Reading) ${title ? `/Title ${pdfText(title)} ` : ""}>>`));

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
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${infoNo} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  parts.push(enc.encode(xref));
  return concat(parts);
}

/**
 * 1ページのPDF(makeJpegPdfPages の1ページ版)。
 * @param {{ jpeg: Uint8Array, widthPx: number, heightPx: number, pageWidthMm: number, pageHeightMm: number, title?: string }} opts
 * @returns {Uint8Array}
 */
export function makeJpegPdf({ title = "", ...page }) {
  return makeJpegPdfPages([page], title);
}
