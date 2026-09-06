import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runExtractionTests() {
  console.log('=== RUNNING MODULE 3 TEXT EXTRACTION TESTS ===\n');

  // Test 1: Upload and extract multi-page science exam paper
  console.log('--- Test 1: Multi-Page Realistic Exam Paper Extraction ---');
  try {
    const pdfPath = path.join(__dirname, 'sample_class10_science_exam.pdf');
    const pdfBuffer = fs.readFileSync(pdfPath);
    const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
    const formData = new FormData();
    formData.append('file', blob, 'sample_class10_science_exam.pdf');

    // 1. Upload to Cloudinary
    const uploadRes = await fetch('http://127.0.0.1:5000/api/papers/upload', {
      method: 'POST',
      body: formData,
    });
    const uploadData = await uploadRes.json();
    const uploadedUrl = uploadData.data?.file?.url;
    console.log(`✅ Upload Succeeded! URL: ${uploadedUrl}`);

    // 2. Extract Text
    const extractRes = await fetch('http://127.0.0.1:5000/api/papers/extract-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileUrl: uploadedUrl }),
    });

    const extractData = await extractRes.json();
    console.log(`Extraction HTTP Status: ${extractRes.status}`);
    console.log(`Page Count: ${extractData.data?.extraction?.pageCount}`);
    console.log(`Character Count: ${extractData.data?.extraction?.characterCount}`);
    console.log(`Status: ${extractData.data?.extraction?.extractionStatus}`);
    console.log('--- Extracted Text Preview ---');
    console.log(extractData.data?.extraction?.text);
    console.log('------------------------------');

    if (
      extractRes.status === 200 &&
      extractData.success &&
      extractData.data.extraction.pageCount === 2 &&
      extractData.data.extraction.text.includes('SECTION A - BIOLOGY') &&
      extractData.data.extraction.text.includes('SECTION B - CHEMISTRY & PHYSICS') &&
      extractData.data.extraction.text.includes('Ohm\'s Law')
    ) {
      console.log('✅ Test 1 PASSED: Multi-page document extracted with all pages, sections, and symbols!\n');
    } else {
      console.error('❌ Test 1 FAILED');
    }
  } catch (err) {
    console.error('❌ Test 1 Exception:', err.message);
  }

  // Test 2: Missing fileUrl in request body
  console.log('--- Test 2: Missing fileUrl in Request Body ---');
  try {
    const res = await fetch('http://127.0.0.1:5000/api/papers/extract-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (res.status === 400 && data.success === false) {
      console.log('✅ Test 2 PASSED: Correctly returned 400 for missing fileUrl!\n');
    } else {
      console.error('❌ Test 2 FAILED');
    }
  } catch (err) {
    console.error('❌ Test 2 Exception:', err.message);
  }

  // Test 3: Invalid / Malformed URL
  console.log('--- Test 3: Malformed URL ---');
  try {
    const res = await fetch('http://127.0.0.1:5000/api/papers/extract-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileUrl: 'not-a-valid-url' }),
    });
    const data = await res.json();
    if (res.status === 400 && data.success === false) {
      console.log('✅ Test 3 PASSED: Correctly returned 400 for malformed URL!\n');
    } else {
      console.error('❌ Test 3 FAILED');
    }
  } catch (err) {
    console.error('❌ Test 3 Exception:', err.message);
  }

  console.log('=== MODULE 3 TEXT EXTRACTION TESTS COMPLETE ===');
}

runExtractionTests();
