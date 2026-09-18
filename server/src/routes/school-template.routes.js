import { Router } from 'express';
import {
  createSchoolTemplate,
  seedSchoolTemplate,
  listSchoolTemplatesHandler,
  getSchoolTemplateHandler,
  updateSchoolTemplateHandler,
  deleteSchoolTemplateHandler,
} from '../controllers/school-template.controller.js';
import { defaultLimiter } from '../middlewares/rate-limit.middleware.js';

const router = Router();

// SchoolTemplates are the VISUAL layer only — no paid AI, no heavy ingest — so
// the loose read tier covers every verb (create/update just persist a small
// JSON blob; the limiter still stops a write binge).

// POST /api/school-templates/seed   { template, format } -> visual (not saved)
router.post('/seed', defaultLimiter, seedSchoolTemplate);

// POST /api/school-templates        { name, schoolName, visual | seed }
router.post('/', defaultLimiter, createSchoolTemplate);

// GET  /api/school-templates?schoolName=
router.get('/', defaultLimiter, listSchoolTemplatesHandler);

// GET  /api/school-templates/:id
router.get('/:id', defaultLimiter, getSchoolTemplateHandler);

// PUT  /api/school-templates/:id     { name?, schoolName?, visual? }
router.put('/:id', defaultLimiter, updateSchoolTemplateHandler);

// DELETE /api/school-templates/:id
router.delete('/:id', defaultLimiter, deleteSchoolTemplateHandler);

export default router;
