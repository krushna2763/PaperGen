/**
 * paper-archive.controller.js — /api/library (the "My Papers" screen).
 *
 * Persistence sits ALONGSIDE the generation pipeline: the client writes here
 * after /papers/:jobId/generate returns. Nothing in this file touches the
 * blueprint contract or the generator — it only stores what was produced.
 */
import {
  savePaper, patchPaper, getPaper, deletePaper, duplicatePaper,
  listPapers, facets, stats,
} from '../services/paper-archive-store.js';

/** GET /api/library?q=&class=&subject=&status=&sort= */
export const listHandler = (req, res) => {
  const rows = listPapers({
    q: req.query.q,
    class: req.query.class,
    subject: req.query.subject,
    status: req.query.status,
    sort: req.query.sort,
  });
  return res.status(200).json({ success: true, data: rows, facets: facets() });
};

/** GET /api/library/stats */
export const statsHandler = (req, res) => res.status(200).json({ success: true, data: stats() });

/** GET /api/library/:id  → full record */
export const getHandler = (req, res) => {
  const paper = getPaper(req.params.id);
  if (!paper) return res.status(404).json({ success: false, message: `Paper "${req.params.id}" not found.` });
  return res.status(200).json({ success: true, data: paper });
};

/** POST /api/library  { title, class, subject, totalMarks, source, status, blueprint, questions, slotUnitMap, rejectedCount } */
export const createHandler = (req, res) => {
  const b = req.body || {};
  if (!b.blueprint || typeof b.blueprint !== 'object') {
    return res.status(400).json({ success: false, message: '"blueprint" is required to save a paper.' });
  }
  const row = savePaper(b);
  return res.status(201).json({ success: true, data: row });
};

/** PATCH /api/library/:id  { title?, status?, questions?, slotUnitMap?, totalMarks?, rejectedCount? } */
export const patchHandler = (req, res) => {
  const row = patchPaper(req.params.id, req.body || {});
  if (!row) return res.status(404).json({ success: false, message: `Paper "${req.params.id}" not found.` });
  return res.status(200).json({ success: true, data: row });
};

/** DELETE /api/library/:id */
export const deleteHandler = (req, res) => {
  const ok = deletePaper(req.params.id);
  if (!ok) return res.status(404).json({ success: false, message: `Paper "${req.params.id}" not found.` });
  return res.status(200).json({ success: true, message: 'Paper deleted.' });
};

/** POST /api/library/:id/duplicate */
export const duplicateHandler = (req, res) => {
  const row = duplicatePaper(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: `Paper "${req.params.id}" not found.` });
  return res.status(201).json({ success: true, data: row });
};

export default { listHandler, statsHandler, getHandler, createHandler, patchHandler, deleteHandler, duplicateHandler };
