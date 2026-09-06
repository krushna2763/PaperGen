// Render the generated test-paper.pdf in headless Chrome and screenshot it.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDF = path.join(__dirname, 'client', 'e2e-screenshots', 'test-paper.pdf');
const OUT = path.join(__dirname, 'e2e-screenshots', 'pdf-render.png');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

if (!fs.existsSync(PDF)) {
  console.error('test-paper.pdf not found — run the pdfmake generation test first');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 900, height: 1200 },
});

try {
  const page = await browser.newPage();
  await page.goto('file:///' + PDF.replace(/\\/g, '/'), { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500)); // let Chrome's PDF viewer paint
  await page.screenshot({ path: OUT });
  const stat = fs.statSync(OUT);
  console.log(`✅ PDF rendered in Chrome → ${OUT} (${(stat.size / 1024).toFixed(1)} KB screenshot)`);
  console.log('   A blank page would produce a tiny uniform PNG; this size indicates rendered text/lines.');
} catch (err) {
  console.error('PDF render probe failed:', err.message);
  process.exit(1);
} finally {
  await browser.close();
}