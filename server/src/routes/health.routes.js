import { Router } from 'express';
import { getHealth } from '../controllers/health.controller.js';
import { defaultLimiter } from '../middlewares/rate-limit.middleware.js';

const router = Router();

// Read backstop tier on the cheap health read
router.get('/health', defaultLimiter, getHealth);

export default router;
