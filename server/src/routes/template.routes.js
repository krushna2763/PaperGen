import { Router } from 'express';
import { createTemplate, listTemplatesHandler, getTemplateHandler, deleteTemplateHandler } from '../controllers/template.controller.js';
import { defaultLimiter } from '../middlewares/rate-limit.middleware.js';

const router = Router();

// Templates trigger NO paid AI calls (structure persistence only) — the loose
// read tier covers reads; the same tier covers writes so a template binge
// cannot flood the store.
// POST   /api/templates        { name, class, subject, blueprint }   (structure only)
router.post('/', defaultLimiter, createTemplate);

// GET    /api/templates?class=&subject=
router.get('/', defaultLimiter, listTemplatesHandler);

// GET    /api/templates/:id
router.get('/:id', defaultLimiter, getTemplateHandler);

// DELETE /api/templates/:id
router.delete('/:id', defaultLimiter, deleteTemplateHandler);

export default router;
