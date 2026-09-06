// Render PDF(s) to PNG with headless Chrome for visual comparison.
// Usage: node scripts/screenshot-pdf.mjs <pdf> [<out.png>] [--width 1200]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdf = path.resolve(process.argv[2]);
const out = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(__dirname, '..', 'e2e-screenshots', `${path.basename(pdf, '.pdf')}.png`);
const width = Number((process.argv.find((a) => a.startsWith('--width=')) || '--width=1100').split('=')[1]);

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

if (!fs.existsSync(pdf)) {
  console.error(`PDF not found: ${pdf}`);
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  defaultViewport: { width, height: 1400 },
});
try {
  const page = await browser.newPage();
  await page.goto('file:///' + pdf.replace(/\\/g, '/'), { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: out, fullPage: true });
  console.log(`Saved ${out}`);
} finally {
  await browser.close();
}
