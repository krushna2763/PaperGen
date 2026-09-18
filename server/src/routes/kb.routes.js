import { Router } from 'express';
import { uploadNotes, listDocuments, listUnits, listTopics, topicCoverage, listNotesImages } from '../controllers/kb.controller.js';
import { handleUploadMiddleware } from '../middlewares/upload.middleware.js';
import { aiLimiter, defaultLimiter } from '../middlewares/rate-limit.middleware.js';

const router = Router();

// POST /api/kb/notes   (file + class + subject + unit) — ingest + paid embeddings
router.post('/notes', aiLimiter, handleUploadMiddleware, uploadNotes);

// GET  /api/kb/documents?class=&subject= — ingested notes files (Mode B KB picker)
router.get('/documents', defaultLimiter, listDocuments);

// GET  /api/kb/units?class=&subject=
router.get('/units', defaultLimiter, listUnits);

// GET  /api/kb/topics?class=&subject=&unit=  — detected topics in ONE unit's notes
//      (coverage embeds the topic → paid call → aiLimiter tier)
router.get('/topics', aiLimiter, listTopics);

// GET  /api/kb/topics/coverage?class=&subject=&unit=&topic= — typed-topic check
router.get('/topics/coverage', aiLimiter, topicCoverage);

// GET  /api/kb/notes/images & /api/kb/images — image-bearing topics and images from selected notes
router.get('/notes/images', defaultLimiter, listNotesImages);
router.get('/images', defaultLimiter, listNotesImages);

export default router;
