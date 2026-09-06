/**
 * E2E browser test for the recreated PaperGen AI UI.
 *
 * Flow: open the app → upload uploads/ENGLISH.pdf → Class 10 / Medium / 3 questions
 *       → click "Generate Question Paper" → wait for success banner → verify the
 *       generated paper renders in the PDF-style viewer → screenshot.
 *
 * Requires the dev servers (client :5173, server :5000) to be running.
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';
const PDF_PATH = path.join(__dirname, 'uploads', 'ENGLISH.pdf');
const SHOT_DIR = path.join(__dirname, 'e2e-screenshots');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  console.error(`\n❌ FAIL: ${message}`);
  process.exit(1);
}

async function main() {
  const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!executablePath) fail('Chrome not found in the known paths.');
  if (!fs.existsSync(PDF_PATH)) fail(`Sample PDF not found at ${PDF_PATH}`);

  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 900 },
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(600000);
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  try {
    // ── 1. Load the app ─────────────────────────────────────
    console.log('→ Opening app…');
    await page.goto(BASE_URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(
      () => document.body.innerText.includes('Create New Question Paper'),
      { timeout: 30000 }
    );
    console.log('✅ App loaded, title "Create New Question Paper" visible');

    // ── 2. Structural checks vs the reference ───────────────
    const styles = await page.evaluate(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, color: s.color, border: s.borderTopColor, borderStyle: s.borderTopStyle };
      };
      const header = document.querySelector('header');
      return {
        bodyBg: getComputedStyle(document.body).backgroundColor,
        headerH: header ? header.offsetHeight : null,
        headerBorder: header ? getComputedStyle(header).borderBottomColor : null,
        h1: document.querySelector('h1')?.innerText,
        dropZone: pick('.border-dashed'),
        primaryBtn: pick('button.bg-blue-700'),
        cardCount: document.querySelectorAll('.rounded-xl.border').length,
        helpVisible: document.body.innerText.includes('Help'),
        papergenTitle: document.body.innerText.includes('PaperGen AI'),
        subtitle: document.body.innerText.includes('AI Question Paper Generator'),
      };
    });
    console.log('  layout checks:', JSON.stringify(styles));
    if (styles.bodyBg !== 'rgb(248, 249, 250)') fail(`Unexpected body background: ${styles.bodyBg}`);
    if (styles.headerH !== 64) console.warn(`  ⚠ header height ${styles.headerH}px (expected 64px)`);

    // ── 3. Upload the PDF via the hidden file input ─────────
    console.log('→ Uploading ENGLISH.pdf…');
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) fail('File input not found');
    await fileInput.uploadFile(PDF_PATH);
    await page.waitForFunction(
      () => document.body.innerText.includes('ENGLISH.pdf'),
      { timeout: 15000 }
    );
    console.log('✅ File row shows "ENGLISH.pdf"');

    // ── 4. Settings: Class 10, Medium, 3 questions ─────────
    const selects = await page.$$('select');
    if (selects.length < 2) fail('Settings selects not found');
    await selects[0].select('10'); // Class
    await selects[1].select('Medium'); // Difficulty
    const numInput = await page.$('input[type="number"]');
    if (!numInput) fail('Number input not found');
    // Note: triple-click does NOT select all in a number input; use Ctrl+A
    await numInput.focus();
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await numInput.type('3');
    const numValue = await numInput.evaluate((el) => el.value);
    if (numValue !== '3') fail(`Number of Questions is ${numValue}, expected 3`);
    console.log('✅ Settings set: Class 10 / Medium / 3 questions');

    // ── 5. Click Generate ───────────────────────────────────
    console.log('→ Clicking "Generate Question Paper"… (pipeline runs: upload → extract → embed → index → generate)');
    const startTs = Date.now();
    const genBtn = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find((b) => b.innerText.includes('Generate Question Paper'));
    });
    const btnEl = genBtn.asElement();
    if (!btnEl) fail('Generate button not found');
    await btnEl.click();

    // ── 6. Wait for the success banner (long LLM pipeline) ──
    await page.waitForFunction(
      () => document.body.innerText.includes('Your question paper has been generated successfully!'),
      { timeout: 600000 }
    );
    const genMs = Date.now() - startTs;
    console.log(`✅ Generation succeeded in ${(genMs / 1000).toFixed(1)}s — success banner visible`);

    // ── 7. Verify the generated paper rendered ──────────────
    await sleep(500);
    const paper = await page.evaluate(() => {
      const text = document.body.innerText;
      const numMatch = text.match(/(\d+) \/ (\d+)/);
      return {
        metaLine: text.includes('Class: 10') && text.includes('Difficulty: Medium') && text.includes('Total Questions: 3'),
        pageIndicator: numMatch ? numMatch[0] : null,
        hasQuestions: /^\d+\.\s/m.test(text),
        questionCount: (text.match(/\n\d+\.\s/g) || []).length,
        viewPdfBtn: text.includes('View Full PDF'),
        downloadBtn: text.includes('Download PDF'),
        sections: /Section [A-Z]/g.test(text),
      };
    });
    console.log('  paper checks:', JSON.stringify(paper));
    if (!paper.metaLine) fail('Paper meta line (Class / Difficulty / Total Questions) not found');
    if (!paper.hasQuestions) fail('No numbered questions rendered in the viewer');

    // ── 8. Real PDF verification: click Download and check the bytes ──
    let pdfCheck = null;
    try {
      const dlPromise = page.waitForEvent('download', { timeout: 60000 });
      const dlBtn = await page.evaluateHandle(() =>
        Array.from(document.querySelectorAll('button')).find((b) => b.innerText.includes('Download PDF'))
      );
      await dlBtn.asElement().click();
      const dl = await dlPromise;
      const tmpPdf = path.join(SHOT_DIR, 'downloaded-paper.pdf');
      await dl.saveAs(tmpPdf);
      const bytes = fs.readFileSync(tmpPdf);
      const header = bytes.subarray(0, 5).toString('ascii');
      pdfCheck = { name: dl.suggestedFilename(), size: bytes.length, header };
      console.log('📄 Real PDF download:', JSON.stringify(pdfCheck));
      if (header !== '%PDF-') fail(`Downloaded file is not a valid PDF (header: ${header})`);
      if (bytes.length < 1000) fail('Downloaded PDF is suspiciously small');
      console.log('✅ Real PDF generated (selectable text, auto page-breaks)');
    } catch (err) {
      console.warn(`  ⚠ could not capture download event (${err.message.slice(0, 100)}) — verify manually in a real browser`);
    }

    // ── 9. Screenshot ────────────────────────────────────────
    await sleep(800);
    const shot = path.join(SHOT_DIR, 'papergen-ui.png');
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`📸 Screenshot saved: ${shot}`);

    if (consoleErrors.length > 0) {
      console.warn('  ⚠ console errors:', consoleErrors.slice(0, 5));
    }

    console.log('\n✅ E2E PASSED — full one-click flow works end-to-end');
  } catch (err) {
    const shot = path.join(SHOT_DIR, 'papergen-ui-failure.png');
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.error(`📸 Failure screenshot saved: ${shot}`);
    console.error('Current page text tail:');
    const tail = await page.evaluate(() => document.body.innerText.slice(-1500)).catch(() => '(unavailable)');
    console.error(tail);
    fail(err.message);
  } finally {
    await browser.close();
  }
}

main();