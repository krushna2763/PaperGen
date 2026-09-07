import { Router } from 'express';
import { generateQuestions } from '../controllers/question.controller.js';
import { listForClient } from '../blueprint/question-types/index.js';
import { aiLimiter } from '../middlewares/rate-limit.middleware.js';

const router = Router();

// POST /api/questions/generate   (legacy free-form flow — triggers paid Gemini calls)
router.post('/questions/generate', aiLimiter, generateQuestions);

// GET /api/question-types — the REGISTRY, served so the client renders form
// fields from the same source of truth (adding a type needs no client change).
router.get('/question-types', (_req, res) => {
  res.status(200).json({ success: true, data: listForClient() });
});

export default router;