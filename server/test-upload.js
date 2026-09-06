import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runUploadTests() {
  console.log('=== RUNNING MODULE 2 BACKEND UPLOAD TESTS ===\n');

  // Test 1: Valid PDF Upload
  console.log('--- Test 1: Valid PDF Upload ---');
  try {
    const pdfPath = path.join(__dirname, 'sample_science_paper.pdf');
    const pdfBuffer = fs.readFileSync(pdfPath);
    const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
    
    const formData = new FormData();
    formData.append('file', blob, 'sample_science_paper.pdf');

    const res = await fetch('http://127.0.0.1:5000/api/papers/upload', {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Response:', JSON.stringify(data, null, 2));

    if (res.status === 200 && data.success && data.data?.file?.url) {
      console.log('✅ Test 1 PASSED: PDF uploaded and received Cloudinary URL!\n');
    } else {
      console.error('❌ Test 1 FAILED');
    }
  } catch (err) {
    console.error('❌ Test 1 Exception:', err.message);
  }

  // Test 2: Non-PDF File Upload
  console.log('--- Test 2: Non-PDF File Upload (Should Reject) ---');
  try {
    const textBlob = new Blob(['This is plain text, not a PDF.'], { type: 'text/plain' });
    const formData = new FormData();
    formData.append('file', textBlob, 'invalid_notes.txt');

    const res = await fetch('http://127.0.0.1:5000/api/papers/upload', {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Response:', JSON.stringify(data, null, 2));

    if (res.status === 400 && data.success === false) {
      console.log('✅ Test 2 PASSED: Non-PDF file was correctly rejected with 400!\n');
    } else {
      console.error('❌ Test 2 FAILED');
    }
  } catch (err) {
    console.error('❌ Test 2 Exception:', err.message);
  }

  // Test 3: No File Uploaded
  console.log('--- Test 3: Empty / Missing File (Should Reject) ---');
  try {
    const formData = new FormData();
    // No 'file' field

    const res = await fetch('http://127.0.0.1:5000/api/papers/upload', {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Response:', JSON.stringify(data, null, 2));

    if (res.status === 400 && data.success === false) {
      console.log('✅ Test 3 PASSED: Missing file was correctly rejected with 400!\n');
    } else {
      console.error('❌ Test 3 FAILED');
    }
  } catch (err) {
    console.error('❌ Test 3 Exception:', err.message);
  }

  console.log('=== MODULE 2 BACKEND UPLOAD TESTS COMPLETE ===');
}

runUploadTests();
