/**
 * school-template.controller.js — /api/school-templates CRUD (visual layer).
 *
 * POST   /api/school-templates          { name, schoolName, visual }        create
 * POST   /api/school-templates          { name, schoolName, seed:{template,format} }
 * POST   /api/school-templates/seed     { template, format }  -> visual (not saved)
 * GET    /api/school-templates?schoolName=
 * GET    /api/school-templates/:id
 * PUT    /api/school-templates/:id       { name?, schoolName?, visual? }
 * DELETE /api/school-templates/:id
 *
 * Everything persisted is VISUAL ONLY — the store's whitelist sanitizer drops
 * any structural key, so a SchoolTemplate can never carry sections, question
 * types, item counts or marks.
 */
import {
  buildSchoolTemplate,
  saveSchoolTemplate,
  listSchoolTemplates,
  getSchoolTemplate,
  deleteSchoolTemplate,
  seedFromReference,
  sanitizeSchoolTemplateVisual,
} from '../services/school-template-store.js';

const publicRow = (t) => ({
  id: t.id,
  name: t.name,
  schoolName: t.schoolName,
  visual: t.visual,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

export const createSchoolTemplate = async (req, res, next) => {
  try {
    const body = req.body || {};
    const visual = body.seed && typeof body.seed === 'object'
      ? seedFromReference({ template: body.seed.template, format: body.seed.format })
      : body.visual;

    const { errors, template } = buildSchoolTemplate({
      name: body.name,
      schoolName: body.schoolName,
      visual,
    });
    if (errors.length > 0) {
      return res.status(422).json({ success: false, message: 'SchoolTemplate validation failed.', errors });
    }
    const saved = saveSchoolTemplate(template);
    return res.status(201).json({ success: true, message: `SchoolTemplate "${saved.name}" saved.`, data: publicRow(saved) });
  } catch (error) {
    console.error('[SchoolTemplate Controller] create error:', error);
    next(error);
  }
};

/** Preview a seed without persisting — powers the client editor's "seed from reference". */
export const seedSchoolTemplate = async (req, res, next) => {
  try {
    const body = req.body || {};
    const visual = seedFromReference({ template: body.template, format: body.format });
    return res.status(200).json({ success: true, data: { visual } });
  } catch (error) {
    console.error('[SchoolTemplate Controller] seed error:', error);
    next(error);
  }
};

export const listSchoolTemplatesHandler = async (req, res, next) => {
  try {
    const schoolName = req.query.schoolName != null ? String(req.query.schoolName).trim() : '';
    if (!schoolName) {
      return res.status(400).json({ success: false, message: '"schoolName" query param is required — SchoolTemplates are scoped per school.' });
    }
    const items = listSchoolTemplates({ schoolName }).map((t) => ({
      id: t.id,
      name: t.name,
      schoolName: t.schoolName,
      hasLogo: !!t.visual?.header?.logo?.dataUri,
      pageSize: t.visual?.page?.size,
      updatedAt: t.updatedAt,
    }));
    return res.status(200).json({ success: true, data: items });
  } catch (error) {
    console.error('[SchoolTemplate Controller] list error:', error);
    next(error);
  }
};

export const getSchoolTemplateHandler = async (req, res, next) => {
  try {
    const t = getSchoolTemplate(req.params.id);
    if (!t) return res.status(404).json({ success: false, message: `SchoolTemplate "${req.params.id}" not found.` });
    return res.status(200).json({ success: true, data: publicRow(t) });
  } catch (error) {
    console.error('[SchoolTemplate Controller] get error:', error);
    next(error);
  }
};

export const updateSchoolTemplateHandler = async (req, res, next) => {
  try {
    const existing = getSchoolTemplate(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: `SchoolTemplate "${req.params.id}" not found.` });
    const body = req.body || {};

    const { errors, template } = buildSchoolTemplate({
      id: existing.id,
      createdAt: existing.createdAt,
      name: body.name != null ? body.name : existing.name,
      schoolName: body.schoolName != null ? body.schoolName : existing.schoolName,
      // Merge: an absent `visual` keeps the stored look; a partial one is
      // re-sanitized against the defaults (missing sub-keys reset to default —
      // callers send the full visual object, which the editor always has).
      visual: body.visual != null ? sanitizeSchoolTemplateVisual(body.visual) : existing.visual,
    });
    if (errors.length > 0) {
      return res.status(422).json({ success: false, message: 'SchoolTemplate validation failed.', errors });
    }
    const saved = saveSchoolTemplate(template);
    return res.status(200).json({ success: true, message: `SchoolTemplate "${saved.name}" updated.`, data: publicRow(saved) });
  } catch (error) {
    console.error('[SchoolTemplate Controller] update error:', error);
    next(error);
  }
};

export const deleteSchoolTemplateHandler = async (req, res, next) => {
  try {
    const removed = deleteSchoolTemplate(req.params.id);
    if (!removed) return res.status(404).json({ success: false, message: `SchoolTemplate "${req.params.id}" not found.` });
    return res.status(200).json({ success: true, message: 'SchoolTemplate deleted.' });
  } catch (error) {
    console.error('[SchoolTemplate Controller] delete error:', error);
    next(error);
  }
};

export default {
  createSchoolTemplate,
  seedSchoolTemplate,
  listSchoolTemplatesHandler,
  getSchoolTemplateHandler,
  updateSchoolTemplateHandler,
  deleteSchoolTemplateHandler,
};
