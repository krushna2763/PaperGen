import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runQuestionExtractionTests() {
  console.log('=== RUNNING MODULE 4 QUESTION EXTRACTION TESTS ===\n');

  // Test 1: Extract questions directly from raw text with MCQs, marks, subquestions & sections
  console.log('--- Test 1: Direct Text with MCQs, Subquestions, Sections & Marks ---');
  const complexPaperText = `
St. Xavier High School
Class 10 Science - Midterm Examination
Time Allowed: 3 Hours
Maximum Marks: 80

SECTION A - BIOLOGY

Q1. Which gas is released during the light reaction of photosynthesis? [1]
A. Carbon dioxide
B. Oxygen
C. Nitrogen
D. Hydrogen

Q2. State whether True or False:
Chlorophyll is located in the inner membrane of the mitochondria. (1 Mark)

Q3. Fill in the blank:
The functional filtration unit of the human kidney is called ________. [1]

Q4. Explain the process of aerobic respiration in detail. How does it differ from anaerobic respiration in terms of ATP yield? [5 Marks]

Q5. (a) What is transpiration? [2]
(b) Explain two factors that affect the rate of transpiration in plants. [3]

SECTION B - CHEMISTRY

6. What is a balanced chemical equation? Why should chemical equations be balanced? [3 Marks]

Q7. Which of the following is a displacement reaction?
(A) 2H2 + O2 -> 2H2O
(B) Zn + CuSO4 -> ZnSO4 + Cu
(C) CaCO3 -> CaO + CO2
(D) NaOH + HCl -> NaCl + H2O

Q8. Define Ohm's Law and calculate the current flowing through a 5 ohm resistor connected to a 10V battery. [3]
`;

  try {
    const res = await fetch('http://127.0.0.1:5000/api/papers/extract-questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: complexPaperText }),
    });

    const data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log(`Questions Extracted: ${data.data?.count}`);
    console.log(`Detected Sections: [${data.data?.sections?.join(', ')}]`);
    console.log('Extracted Question Objects:');
    data.data?.questions?.forEach(q => {
      console.log(`- [${q.questionNumber}] (Sec: ${q.section || 'None'}, Type: ${q.type}, Marks: ${q.marks}): "${q.text}"`);
      if (q.options?.length > 0) {
        console.log(`   Options (${q.options.length}): ${q.options.join(' | ')}`);
      }
    });

    const q1 = data.data?.questions?.find(q => q.questionNumber === 'Q1');
    const q2 = data.data?.questions?.find(q => q.questionNumber === 'Q2');
    const q3 = data.data?.questions?.find(q => q.questionNumber === 'Q3');
    const q4 = data.data?.questions?.find(q => q.questionNumber === 'Q4');
    const q5a = data.data?.questions?.find(q => q.questionNumber === 'Q5(a)');
    const q7 = data.data?.questions?.find(q => q.questionNumber === 'Q7');

    const assertions = [
      data.data?.count >= 8,
      q1?.type === 'MCQ' && q1?.options?.length === 4 && q1?.marks === 1,
      q2?.type === 'TRUE_FALSE' && q2?.marks === 1,
      q3?.type === 'FILL_IN_THE_BLANK' && q3?.marks === 1,
      q4?.marks === 5 && q4?.type === 'LONG_ANSWER',
      q5a?.parentQuestionNumber === 'Q5' && q5a?.marks === 2,
      q7?.type === 'MCQ' && q7?.options?.length === 4
    ];

    if (assertions.every(Boolean)) {
      console.log('✅ Test 1 PASSED: All question types, MCQs, subquestions, marks & sections correctly extracted!\n');
    } else {
      console.error('❌ Test 1 FAILED assertions:', assertions);
    }
  } catch (err) {
    console.error('❌ Test 1 Exception:', err.message);
  }

  // Test 2: Upload real multi-page PDF & extract questions via fileUrl
  console.log('--- Test 2: End-to-End PDF Upload -> Question Extraction ---');
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

    // 2. Call POST /extract-questions with fileUrl
    const extractRes = await fetch('http://127.0.0.1:5000/api/papers/extract-questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileUrl: uploadedUrl }),
    });

    const extractData = await extractRes.json();
    console.log(`Status: ${extractRes.status}`);
    console.log(`Questions Extracted from PDF: ${extractData.data?.count}`);
    console.log(`Sections: [${extractData.data?.sections?.join(', ')}]`);
    extractData.data?.questions?.forEach(q => {
      console.log(`- [${q.questionNumber}] (Sec: ${q.section}, Page: ${q.metadata?.pageNumber}): "${q.text}"`);
    });

    if (
      extractRes.status === 200 &&
      extractData.success &&
      extractData.data?.count === 8 &&
      extractData.data?.sections?.includes('A') &&
      extractData.data?.sections?.includes('B')
    ) {
      console.log('✅ Test 2 PASSED: 8 structured question objects extracted from multi-page PDF!\n');
    } else {
      console.error('❌ Test 2 FAILED');
    }
  } catch (err) {
    console.error('❌ Test 2 Exception:', err.message);
  }

  // Test 3: Empty body error validation
  console.log('--- Test 3: Empty Body Validation ---');
  try {
    const res = await fetch('http://127.0.0.1:5000/api/papers/extract-questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (res.status === 400 && data.success === false) {
      console.log('✅ Test 3 PASSED: Returned 400 for empty request body!\n');
    } else {
      console.error('❌ Test 3 FAILED');
    }
  } catch (err) {
    console.error('❌ Test 3 Exception:', err.message);
  }

  console.log('=== MODULE 4 QUESTION EXTRACTION TESTS COMPLETE ===');
}

runQuestionExtractionTests();
