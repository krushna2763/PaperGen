// Deep-layout probe: prints every text item's x/y/fontSize/style + page geometry.
// Usage: node scripts/pdf-probe.mjs <file.pdf> [--pages 1,2] [--full]
import fs from 'node:fs';
import { getDocument } from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';

const file = process.argv[2];
const pagesArg = process.argv.find((a) => a.startsWith('--pages='));
const wantPages = pagesArg ? pagesArg.split('=')[1].split(',').map(Number) : null;
const full = process.argv.includes('--full');

const data = new Uint8Array(fs.readFileSync(file));
const doc = await getDocument({ data, useSystemFonts: true }).promise;

console.log(`\n========== ${file} — ${doc.numPages} page(s) ==========`);

for (let p = 1; p <= doc.numPages; p++) {
  if (wantPages && !wantPages.includes(p)) continue;
  const page = await doc.getPage(p);
  const vp = page.getViewport({ scale: 1 }); // PDF points
  console.log(`\n----- PAGE ${p}  size: ${vp.width.toFixed(1)} x ${vp.height.toFixed(1)} pt -----`);
  const tc = await page.getTextContent();
  const lines = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    const size = Math.hypot(a, b); // font size from scale
    const x = e;
    const y = vp.height - f; // top-origin
    const style = it.fontName ? String(it.fontName) : '';
    lines.push({ x, y, size, style, text: it.str });
  }
  lines.sort((l1, l2) => l1.y - l2.y || l1.x - l2.x);
  for (const l of lines) {
    const indent = l.y > 0 ? '' : '';
    if (!full && l.size < 4) continue;
    console.log(
      `  y=${l.y.toFixed(1).padStart(6)}  x=${l.x.toFixed(1).padStart(6)}  sz=${l.size.toFixed(1).padStart(4)}  ${l.style.padEnd(24)}  ${indent}${l.text}`
    );
  }
}
await doc.destroy();
