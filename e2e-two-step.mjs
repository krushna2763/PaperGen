/**
 * E2E — targeted unit-assignment test (user scenario).
 *
 * Uploads:   "sample paper .pdf" (previous-year paper)
 * Notes:     "CBSE Notes Class 4 English Chapter 1 - Free PDF.pdf" → Unit 1
 *            "CBSE Notes Class 4 English Chapter 2 - Free PDF.pdf" → Unit 2
 * Assignment: Q1→Unit 1, Q2→Unit 1, Q3→Unit 2, Q4→Unit 2, Q5→Unit 1
 *
 * Flow: open app → upload paper → Class 4 / Medium → Analyze → confirm screen →
 *       upload both notes files as Unit 1 / Unit 2 → set per-row unit dropdowns →
 *       Generate → wait for success banner → verify review screen → screenshots.
 *
 * Requires dev servers: client :5173, server :5000.
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';
const PAPER_PDF = path.join(__dirname, 'uploads', 'samplepaper1.pdf'); // user-provided paper WITH marks
const PAPER_NAME = path.basename(PAPER_PDF);
const NOTES1_PDF = 'C:/Users/Krushna/Downloads/CBSE Notes Class 4 English Chapter 1 - Free PDF.pdf';
const NOTES2_PDF = 'C:/Users/Krushna/Downloads/CBSE Notes Class 4 English Chapter 2 - Free PDF.pdf';
const SHOT_DIR = path.join(__dirname, 'e2e-screenshots');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => console.log(`→ ${msg}`);
const ok = (msg) => console.log(`✅ ${msg}`);

function fail(message) {
  console.error(`\n❌ FAIL: ${message}`);
  process.exit(1);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function main() {
  for (const p of [PAPER_PDF, NOTES1_PDF, NOTES2_PDF]) {
    if (!fs.existsSync(p)) fail(`Required file missing: ${p}`);
  }
  const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!executablePath) fail('Chrome not found in the known paths.');
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 1000 },
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(300000);
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  try {
    // ── 1. Load the app ─────────────────────────────────────
    step('Opening app…');
    await page.goto(BASE_URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(
      () => document.body.innerText.includes('Create New Question Paper'),
      { timeout: 30000 }
    );
    ok('App loaded');

    // ── 2. Upload the sample paper ──────────────────────────
    step('Uploading "sample paper .pdf"…');
    const paperInput = await page.$('input[type="file"]');
    if (!paperInput) fail('File input not found');
    await paperInput.uploadFile(PAPER_PDF);
    await page.waitForFunction(
      (name) => document.body.innerText.includes(name),
      { timeout: 15000 },
      PAPER_NAME
    );
    ok(`File row shows "${PAPER_NAME}"`);

    // ── 3. Settings: Class 4 / Medium ───────────────────────
    const selects = await page.$$('select');
    if (selects.length < 2) fail('Settings selects not found');
    await selects[0].select('4'); // Class
    await selects[1].select('Medium'); // Difficulty
    ok('Settings set: Class 4 / Medium');

    // ── 4. Analyze ──────────────────────────────────────────
    step('Clicking "Analyze Reference Paper"…');
    const analyzeBtn = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('button')).find((b) =>
        b.innerText.includes('Analyze Reference Paper')
      )
    );
    const analyzeEl = analyzeBtn.asElement();
    if (!analyzeEl) fail('Analyze button not found');
    await analyzeEl.click();

    await page.waitForFunction(
      () => document.body.innerText.includes('Review Blueprint & Assign Units'),
      { timeout: 300000 }
    );
    ok('Confirm screen visible');

    const bp = await page.evaluate(() => {
      const t = document.body.innerText;
      const rows = Array.from(document.querySelectorAll('.divide-y > div'));
      return {
        locked: t.includes('LOCKED'),
        assignTitle: t.includes('Assign a unit to every question'),
        questionCount: /(\d+)\s*\n?\s*questions/.exec(t)?.[1] ?? null,
        rows: rows.map((r) => ({
          key: r.querySelector('span.w-12')?.innerText.trim() ?? null,
          marks: r.querySelector('span.w-16')?.innerText.trim() ?? null,
        })),
        units: t.includes('Syllabus notes')
          ? (t.split('Syllabus notes')[1] || '').split('Assign a unit')[0].match(/([^\n·]+)·\s*(\d+)\s*chunk/g) ?? []
          : [],
      };
    });
    console.log('  blueprint checks:', JSON.stringify(bp, null, 1));
    if (!bp.locked || !bp.assignTitle) fail('Confirm screen missing LOCKED badge or assignment list');
    const rowsWithoutMarks = bp.rows.filter((r) => /n\/a/.test(r.marks || ''));
    if (bp.rows.length >= 5 && rowsWithoutMarks.length === 0) {
      ok('All blueprint slots carry marks — validation deadlock should be gone');
    } else {
      console.warn(`  ⚠ ${rowsWithoutMarks.length} slot(s) without marks: ${rowsWithoutMarks.map((r) => r.key).join(', ')}`);
    }

    // ── 5-6. Ensure Unit 1 + Unit 2 notes are indexed ───────
    // Units from the previous run may already be indexed (hash reuse) — only
    // upload the ones missing.
    const hasUnit = (n) => bp.units.some((u) => norm(u).includes(norm(n)) && /[1-9]\d*\s*chunk/.test(u));
    const uploads = [
      { name: 'Unit 1', file: NOTES1_PDF },
      { name: 'Unit 2', file: NOTES2_PDF },
    ];
    for (const { name, file } of uploads) {
      if (hasUnit(name)) {
        ok(`${name} already indexed — skipping upload`);
        continue;
      }
      step(`Uploading notes as "${name}"…`);
      const unitInput = await page.$('input[placeholder^="Unit"]');
      if (!unitInput) fail('Unit name input not found');
      await unitInput.type(name);
      const noteInputs = await page.$$('input[type="file"]');
      if (noteInputs.length < 2) fail('Notes file input not found');
      await noteInputs[noteInputs.length - 1].uploadFile(file);
      await page.waitForFunction(
        (n) => new RegExp(`${n}\\s*·\\s*[1-9]\\d*\\s*chunk`, 'i').test(document.body.innerText) ||
          new RegExp(n.replace(/\s+/g, '\\s*') + '\\s*·\\s*[1-9]\\d*\\s*chunk', 'i').test(document.body.innerText.replace(/\s+/g, ' ')),
        { timeout: 300000 },
        name
      );
      ok(`${name} indexed`);
    }

    // ── 7. Assign units: Q1,Q2,Q5→Unit 1; Q3,Q4→Unit 2 ──────
    step('Assigning units per question…');
    const slotKeys = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.divide-y > div'));
      return rows.map((r) => r.querySelector('span.w-12')?.innerText.trim()).filter(Boolean);
    });
    console.log('  slot keys:', slotKeys.join(', '));
    if (slotKeys.length < 5) fail(`Expected 5 blueprint rows, found ${slotKeys.length}`);

    // Unit option order comes from the unit chips; match by normalized name.
    const unitOptionValues = await page.evaluate(() => {
      const sel = document.querySelector('.divide-y select');
      return sel ? Array.from(sel.options).map((o) => ({ value: o.value, label: o.textContent.trim() })) : [];
    });
    console.log('  unit options:', JSON.stringify(unitOptionValues));
    const pickUnit = (target) => {
      const hit = unitOptionValues.find((o) => norm(o.label) === norm(target));
      if (!hit) fail(`Unit "${target}" not among options: ${unitOptionValues.map((o) => o.label).join(' | ')}`);
      return hit.value;
    };
    const wanted = [pickUnit('Unit 1'), pickUnit('Unit 1'), pickUnit('Unit 2'), pickUnit('Unit 2'), pickUnit('Unit 1')];
    const rowSelects = await page.$$('.divide-y select');
    if (rowSelects.length < slotKeys.length) fail(`Expected ≥${slotKeys.length} row selects, found ${rowSelects.length}`);
    for (let i = 0; i < slotKeys.length; i++) {
      await rowSelects[i].select(wanted[i]);
    }
    ok(`Assigned: ${slotKeys.map((k, i) => `${k}→${['U1', 'U1', 'U2', 'U2', 'U1'][i]}`).join(', ')}`);

    // ── 8. Generate ─────────────────────────────────────────
    step('Clicking "Generate Question Paper"… (agentic pipeline)');
    const genTs = Date.now();
    const genBtn = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('button')).find((b) =>
        b.innerText.includes('Generate Question Paper')
      )
    );
    const genEl = genBtn.asElement();
    if (!genEl) fail('Generate button not found');
    try {
      await page.waitForFunction(
        () => {
          const b = Array.from(document.querySelectorAll('button')).find((x) => x.innerText.includes('Generate Question Paper'));
          return b && !b.disabled;
        },
        { timeout: 15000 }
      );
    } catch (_e) {
      fail('Generate button still disabled after assignment — unassigned slots remain');
    }
    await genEl.click();

    await page.waitForFunction(
      () => document.body.innerText.includes('Your question paper has been generated successfully!'),
      { timeout: 600000 }
    );
    ok(`Generation succeeded in ${((Date.now() - genTs) / 1000).toFixed(1)}s`);

    // ── 9. Verify review screen + capture screenshots ───────
    await sleep(600);
    const paper = await page.evaluate(() => {
      const t = document.body.innerText;
      return {
        viewPdfBtn: t.includes('View Full PDF'),
        downloadBtn: t.includes('Download PDF'),
        backBtn: t.includes('Back to Blueprint'),
        numbered: (t.match(/\n\d+\.\s/g) || []).length,
      };
    });
    console.log('  paper checks:', JSON.stringify(paper));
    if (!paper.viewPdfBtn || !paper.downloadBtn || !paper.backBtn) fail('Review action buttons missing');

    const reviewShot = path.join(SHOT_DIR, 'unit-assignment-review.png');
    await page.screenshot({ path: reviewShot, fullPage: true });
    console.log(`📸 Review screenshot: ${reviewShot}`);

    // ── 10. "Back to Blueprint" → capture assignment state ──
    const backBtn = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('button')).find((b) => b.innerText.includes('Back to Blueprint'))
    );
    if (backBtn.asElement()) {
      await backBtn.asElement().click();
      await sleep(500);
    }
    const confirmShot = path.join(SHOT_DIR, 'unit-assignment-confirm.png');
    await page.screenshot({ path: confirmShot, fullPage: true });
    console.log(`📸 Confirm-screen screenshot: ${confirmShot}`);

    if (consoleErrors.length > 0) {
      console.warn('  ⚠ console errors:', consoleErrors.slice(0, 5));
    }
    console.log('\n✅ E2E PASSED — sample paper + Unit 1/Unit 2 notes + per-question assignment (Q1,Q2,Q5→U1; Q3,Q4→U2)');
  } catch (err) {
    const shot = path.join(SHOT_DIR, 'unit-assignment-failure.png');
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.error(`📸 Failure screenshot: ${shot}`);
    const tail = await page.evaluate(() => document.body.innerText.slice(-1500)).catch(() => '(unavailable)');
    console.error('Current page text tail:');
    console.error(tail);
    fail(err.message);
  } finally {
    await browser.close();
  }
}

main();
