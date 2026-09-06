import { Router } from 'express';
import { uploadNotes, listUnits } from '../controllers/kb.controller.js';
import { handleUploadMiddleware } from '../middlewares/upload.middleware.js';
import { aiLimiter, defaultLimiter } from '../middlewares/rate-limit.middleware.js';

const router = Router();

// POST /api/kb/notes   (file + class + subject + unit) — ingest + paid embeddings
router.post('/notes', aiLimiter, handleUploadMiddleware, uploadNotes);

// GET  /api/kb/units?class=&subject=
router.get('/units', defaultLimiter, listUnits);

export default router;
