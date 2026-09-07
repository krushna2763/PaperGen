/**
 * template.controller.js — /api/templates CRUD (Mode B templates).
 *
 * POST   /api/templates        { name, class, subject, blueprint }
 * GET    /api/templates?class=&subject=
 * GET    /api/templates/:id
 * DELETE /api/templates/:id
 *
 * Persisted payload is STRUCTURE ONLY — the store's sanitizer strips units,
 * topics, anchors, generated content and everything else non-structural, so a
 * template stays reusable across any unit assignment.
 */
import { buildTemplate, saveTemplate, listTemplates, getTemplate, deleteTemplate } from '../services/template-store.js';

export const createTemplate = async (req, res, next) => {
  try {
    const body = req.body || {};
    const { errors, template } = buildTemplate({
      name: body.name,
      class: body.class ?? body.blueprint?.paper?.class,
      subject: body.subject ?? body.blueprint?.paper?.subject,
      blueprint: body.blueprint,
    });
    if (errors.length > 0) {
      return res.status(422).json({ success: false, message: 'Template validation failed.', errors });
    }
    const saved = saveTemplate(template);
    return res.status(201).json({
      success: true,
      message: `Template "${saved.name}" saved.`,
      data: { id: saved.id, name: saved.name, class: saved.class, subject: saved.subject, blueprint: saved.blueprint, createdAt: saved.createdAt },
    });
  } catch (error) {
    console.error('[Template Controller] create error:', error);
    next(error);
  }
};

export const listTemplatesHandler = async (req, res, next) => {
  try {
    const cls = req.query.class != null ? String(req.query.class).trim() : null;
    const subject = req.query.subject != null ? String(req.query.subject).trim() : null;
    if (!cls || !subject) {
      return res.status(400).json({ success: false, message: '"class" and "subject" query params are required — templates are scoped to class and subject.' });
    }
    const items = listTemplates({ class: cls, subject }).map((t) => ({
      id: t.id,
      name: t.name,
      class: t.class,
      subject: t.subject,
      questionCount: t.blueprint.questions.length,
      totalMarks: t.blueprint.questions.reduce((a, q) => a + (q.marks?.total ?? 0), 0),
      createdAt: t.createdAt,
    }));
    return res.status(200).json({ success: true, data: items });
  } catch (error) {
    console.error('[Template Controller] list error:', error);
    next(error);
  }
};

export const getTemplateHandler = async (req, res, next) => {
  try {
    const t = getTemplate(req.params.id);
    if (!t) return res.status(404).json({ success: false, message: `Template "${req.params.id}" not found.` });
    return res.status(200).json({
      success: true,
      data: { id: t.id, name: t.name, class: t.class, subject: t.subject, blueprint: t.blueprint, createdAt: t.createdAt },
    });
  } catch (error) {
    console.error('[Template Controller] get error:', error);
    next(error);
  }
};

export const deleteTemplateHandler = async (req, res, next) => {
  try {
    const removed = deleteTemplate(req.params.id);
    if (!removed) return res.status(404).json({ success: false, message: `Template "${req.params.id}" not found.` });
    return res.status(200).json({ success: true, message: 'Template deleted.' });
  } catch (error) {
    console.error('[Template Controller] delete error:', error);
    next(error);
  }
};

export default { createTemplate, listTemplatesHandler, getTemplateHandler, deleteTemplateHandler };
