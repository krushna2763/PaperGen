import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper: Cosine Similarity between two vectors
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function runEmbeddingTests() {
  console.log('=== RUNNING MODULE 5 GEMINI EMBEDDINGS TESTS ===\n');

  // Test 1: Direct Batch Embedding & Semantic Sanity Experiment
  console.log('--- Test 1: Semantic Sanity Experiment (Related vs Unrelated Concepts) ---');
  const sampleQuestions = [
    { questionNumber: 'QA', text: 'What is photosynthesis?' },
    { questionNumber: 'QB', text: 'How do green plants prepare their food using sunlight and chlorophyll?' },
    { questionNumber: 'QC', text: 'What is the capital of France?' }
  ];

  try {
    const res = await fetch('http://127.0.0.1:5000/api/papers/embed-questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions: sampleQuestions }),
    });

    const data = await res.json();
    console.log(`HTTP Status: ${res.status}`);
    console.log(`Embedding Model: ${data.data?.embeddingModel}`);
    console.log(`Vector Dimension: ${data.data?.vectorDimension}`);
    console.log(`Questions Embedded: ${data.data?.count}`);

    const vecA = data.data?.questions?.find(q => q.questionNumber === 'QA')?.embedding;
    const vecB = data.data?.questions?.find(q => q.questionNumber === 'QB')?.embedding;
    const vecC = data.data?.questions?.find(q => q.questionNumber === 'QC')?.embedding;

    if (vecA && vecB && vecC) {
      const simRelated = cosineSimilarity(vecA, vecB);
      const simUnrelated = cosineSimilarity(vecA, vecC);

      console.log(`\nSemantic Similarity Results:`);
      console.log(`- Sim(QA "Photosynthesis", QB "Plants prepare food"): ${simRelated.toFixed(4)} (Expected: HIGH)`);
      console.log(`- Sim(QA "Photosynthesis", QC "Capital of France"):  ${simUnrelated.toFixed(4)} (Expected: LOW)`);

      if (simRelated > simUnrelated && data.data.vectorDimension > 0) {
        console.log('✅ Test 1 PASSED: Gemini embeddings generated and demonstrated high semantic correlation for related concepts!\n');
      } else {
        console.error('❌ Test 1 FAILED: Semantic sanity check did not show expected correlation');
      }
    } else {
      console.error('❌ Test 1 FAILED: Did not receive all 3 vectors');
    }
  } catch (err) {
    console.error('❌ Test 1 Exception:', err.message);
  }

  // Test 2: Full End-to-End Paper Embeddings (PDF -> Questions -> Embeddings)
  console.log('--- Test 2: End-to-End Extraction & Embedding of 8 Questions ---');
  try {
    const pdfPath = path.join(__dirname, 'sample_class10_science_exam.pdf');
    const pdfBuffer = fs.readFileSync(pdfPath);
    const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
    const formData = new FormData();
    formData.append('file', blob, 'sample_class10_science_exam.pdf');

    // 1. Upload
    const uploadRes = await fetch('http://127.0.0.1:5000/api/papers/upload', {
      method: 'POST',
      body: formData,
    });
    const uploadData = await uploadRes.json();
    const uploadedUrl = uploadData.data?.file?.url;

    // 2. Extract Questions
    const extractRes = await fetch('http://127.0.0.1:5000/api/papers/extract-questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileUrl: uploadedUrl }),
    });
    const extractData = await extractRes.json();
    const extractedQuestions = extractData.data?.questions || [];
    console.log(`Extracted ${extractedQuestions.length} questions from paper.`);

    // 3. Generate Embeddings for all extracted questions
    const embedRes = await fetch('http://127.0.0.1:5000/api/papers/embed-questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions: extractedQuestions }),
    });

    const embedData = await embedRes.json();
    console.log(`Embedding Status: ${embedRes.status}`);
    console.log(`Questions Embedded: ${embedData.data?.count}`);
    console.log(`Model: ${embedData.data?.embeddingModel}`);
    console.log(`Dimension: ${embedData.data?.vectorDimension}`);

    // Verify each question has embedding vector attached and metadata preserved
    const allValid = embedData.data?.questions?.every(q => 
      q.questionNumber &&
      q.text &&
      Array.isArray(q.embedding) &&
      q.embedding.length === embedData.data.vectorDimension
    );

    if (embedRes.status === 200 && embedData.success && embedData.data?.count === 8 && allValid) {
      console.log('Sample Vector Preview for Q1:');
      console.log(`- Question: "${embedData.data.questions[0].text}"`);
      console.log(`- Vector [first 5 values]: [${embedData.data.questions[0].embedding.slice(0, 5).map(v => v.toFixed(5)).join(', ')}, ...] (Total dim: ${embedData.data.vectorDimension})`);
      console.log('✅ Test 2 PASSED: All 8 questions converted into semantic vectors with preserved metadata!\n');
    } else {
      console.error('❌ Test 2 FAILED');
    }
  } catch (err) {
    console.error('❌ Test 2 Exception:', err.message);
  }

  // Test 3: Error Handling (Empty Body)
  console.log('--- Test 3: Empty Body Validation ---');
  try {
    const res = await fetch('http://127.0.0.1:5000/api/papers/embed-questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions: [] }),
    });
    const data = await res.json();
    console.log(`Status: ${res.status}, Message: ${data.message || data.error}`);
    if (res.status === 200 && data.data?.count === 0) {
      console.log('✅ Test 3 PASSED: Empty array returned 0 count safely!\n');
    }
  } catch (err) {
    console.error('❌ Test 3 Exception:', err.message);
  }

  console.log('=== MODULE 5 EMBEDDING TESTS COMPLETE ===');
}

runEmbeddingTests();
