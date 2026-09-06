import { Router } from 'express';
import {
  uploadPaper,
  analyzePaper,
  extractPaperText,
  extractPaperQuestions,
  checkPaperIndexed,
  embedPaperQuestions,
  indexPaperQuestions
} from '../controllers/paper.controller.js';
import { generatePaper, jobStatus } from '../controllers/generate.controller.js';
import { handleUploadMiddleware } from '../middlewares/upload.middleware.js';
import { aiLimiter, defaultLimiter } from '../middlewares/rate-limit.middleware.js';

const router = Router();

// SECURITY: two tiers. aiLimiter (tight) covers every route that triggers paid
// Gemini calls or heavy ingest work (Cloudinary upload, PDF fetch/OCR);
// defaultLimiter (loose) covers cheap reads/status checks.

// POST /api/papers/upload
router.post('/upload', aiLimiter, handleUploadMiddleware, uploadPaper);

// POST /api/papers/analyze   (step 1: parse + blueprint + availableUnits, no generation)
router.post('/analyze', aiLimiter, analyzePaper);

// POST /api/papers/extract-text
router.post('/extract-text', aiLimiter, extractPaperText);

// POST /api/papers/extract-questions
router.post('/extract-questions', aiLimiter, extractPaperQuestions);

// POST /api/papers/check-indexed  (source reuse: is this PDF already in Qdrant?)
router.post('/check-indexed', defaultLimiter, checkPaperIndexed);

// POST /api/papers/embed-questions
router.post('/embed-questions', aiLimiter, embedPaperQuestions);

// POST /api/papers/index-questions
router.post('/index-questions', aiLimiter, indexPaperQuestions);

// POST /api/papers/:jobId/generate   (step 2: notes-grounded generation from the posted blueprint + slotUnitMap)
router.post('/:jobId/generate', aiLimiter, generatePaper);

// GET  /api/papers/:jobId/status     (per-slot progress)
router.get('/:jobId/status', defaultLimiter, jobStatus);

export default router;
