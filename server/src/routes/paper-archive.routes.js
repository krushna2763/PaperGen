import { Router } from 'express';
import {
  listHandler, statsHandler, getHandler, createHandler, patchHandler, deleteHandler, duplicateHandler,
} from '../controllers/paper-archive.controller.js';
import { defaultLimiter } from '../middlewares/rate-limit.middleware.js';

/**
 * /api/library — stored question papers for the "My Papers" screen.
 *
 * No paid AI calls here (pure persistence), so the loose read tier covers
 * everything. Mounted on its own base so it never collides with the
 * /api/papers/:jobId/* generation routes.
 *
 * `/stats` is declared before `/:id` so the id param does not swallow it.
 */
const router = Router();

router.get('/', defaultLimiter, listHandler);
router.get('/stats', defaultLimiter, statsHandler);
router.get('/:id', defaultLimiter, getHandler);
router.post('/', defaultLimiter, createHandler);
router.post('/:id/duplicate', defaultLimiter, duplicateHandler);
router.patch('/:id', defaultLimiter, patchHandler);
router.delete('/:id', defaultLimiter, deleteHandler);

export default router;
