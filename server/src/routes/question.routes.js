import { Router } from 'express';
import { generateQuestions } from '../controllers/question.controller.js';
import { aiLimiter } from '../middlewares/rate-limit.middleware.js';

const router = Router();

// POST /api/questions/generate   (legacy free-form flow — triggers paid Gemini calls)
router.post('/questions/generate', aiLimiter, generateQuestions);

export default router;