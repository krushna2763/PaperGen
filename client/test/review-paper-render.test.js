/**
 * review-paper-render.test.js — the ReviewPaper render path, exercised across
 * the module boundary that the fingerprint tests never cross.
 *
 * The existing staleness tests assert `staleSlots` / `paperFingerprints` over
 * *blueprint* slot objects. The review screen never looks up those objects — it
 * looks up the questions that `buildPaperModel` produces, which have a
 * different shape. Nothing tested whether the screen's stale lookup, its
 * "not generated yet" empty state, or its per-slot regenerate actually land on
 * the right question. These tests build the real model from a real manual
 * blueprint and assert against it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBlueprint } from '../../server/src/blueprint/blueprint-normalizer.js';
import { buildManualBlueprint } from '../../server/src/blueprint/manual-blueprint.js';
import { buildPaperModel } from '../src/services/paperLayout.js';
import { paperFingerprints, staleSlots } from '../src/services/staleness.js';
import { slotKey, slotIsStale } from '../src/components/blueprintUnits.js';
import { mergeRegeneratedResult } from '../src/services/regenResult.js';

function bp3() {
  return normalizeBlueprint(
    buildManualBlueprint({
      paper: { class: '4', subject: 'English', maximumMarks: 15 },
      sections: [],
      questions: [
        { type: 'SHORT_ANSWER', section: null, itemCount: 1, topic: 't1', difficulty: 'Easy', marks: { mode: 'whole', total: 5 } },
        { type: 'SHORT_ANSWER', section: null, itemCount: 1, topic: 't2', difficulty: 'Easy', marks: { mode: 'whole', total: 5 } },
        { type: 'SHORT_ANSWER', section: null, itemCount: 1, topic: 't3', difficulty: 'Easy', marks: { mode: 'whole', total: 5 } },
      ],
    }).blueprint
  );
}

/** Orchestrator-shaped accepted questions, one per slot, in slot order. */
function generatedFor(bp, textPrefix = 'ORIGINAL') {
  return bp.questions.map((q, i) => ({
    questionId: `g${i}`,
    slotIndex: i,
    type: q.type,
    text: `${textPrefix} slot ${i}`,
  }));
}

function modelQuestions(model) {
  return [...model.sections.flatMap((s) => s.questions), ...model.unsectionedQuestions];
}

test('the review screen keys a model question by the SAME field the fingerprint map uses', () => {
  // paperFingerprints keys every slot by `slotKey(blueprintQuestion)`. The
  // review screen keys the rendered question by `slotKey(modelQuestion)`. For
  // the two to be the same key space by construction (not by a lucky
  // `"Q" + number` reconstruction), the model question has to carry the slot
  // label through. Assert the field, not just the resulting string.
  const bp = bp3();
  const model = buildPaperModel({
    questions: generatedFor(bp),
    blueprint: bp,
    settings: { class: '4' },
    subject: 'English',
    format: {},
  });
  const mqs = modelQuestions(model);
  assert.equal(mqs.length, 3);
  mqs.forEach((mq, i) => {
    assert.equal(mq.label, bp.questions[i].label, `model question ${i} must carry blueprint label ${bp.questions[i].label}`);
    assert.equal(slotKey(mq), slotKey(bp.questions[i]), 'both sides must resolve to the same slot key');
  });
});

test('an edit to one slot marks exactly that rendered question stale', () => {
  const bp = bp3();
  const gen = paperFingerprints(bp, { Q1: { unit: 1 }, Q2: { unit: 1 }, Q3: { unit: 1 } });

  const edited = structuredClone(bp);
  edited.questions[1].totalMarks = 8; // Q2 marks changed
  const staled = staleSlots(gen, paperFingerprints(edited, { Q1: { unit: 1 }, Q2: { unit: 1 }, Q3: { unit: 1 } }));
  assert.deepEqual(staled, ['Q2']);

  const model = buildPaperModel({
    questions: generatedFor(edited),
    blueprint: edited,
    settings: { class: '4' },
    subject: 'English',
    format: {},
  });
  const [q1, q2, q3] = modelQuestions(model);
  assert.equal(slotIsStale(staled, q1), false);
  assert.equal(slotIsStale(staled, q2), true, 'the edited slot must render its stale dot / banner');
  assert.equal(slotIsStale(staled, q3), false);
});

test('a stale slot whose generated question came back empty hits the not-generated empty state', () => {
  // The review row shows "Not generated yet" when `isStale && !hasGeneratedText`
  // (ReviewPaper PaperQuestionRow). Reproduce that exact condition through the
  // real model: one slot stale, its generated question has blank text.
  const bp = bp3();
  const gen = paperFingerprints(bp, { Q1: { unit: 1 }, Q2: { unit: 1 }, Q3: { unit: 1 } });

  const edited = structuredClone(bp);
  edited.questions[2].totalMarks = 7; // Q3 stale
  const staled = staleSlots(gen, paperFingerprints(edited, { Q1: { unit: 1 }, Q2: { unit: 1 }, Q3: { unit: 1 } }));
  assert.deepEqual(staled, ['Q3']);

  const questions = generatedFor(edited);
  questions[2].text = '   '; // Q3's generated content came back blank
  const model = buildPaperModel({
    questions,
    blueprint: edited,
    settings: { class: '4' },
    subject: 'English',
    format: {},
  });
  const q3 = modelQuestions(model).find((q) => slotKey(q) === 'Q3');
  assert.ok(q3, 'Q3 still renders as a row');
  const isStale = slotIsStale(staled, q3);
  const hasGeneratedText = Boolean(q3.text && q3.text.trim().length > 0);
  assert.equal(isStale, true);
  assert.equal(hasGeneratedText, false, 'blank generated text -> the empty-state branch renders');
});

test('regenerating one stale slot renders the fresh content AT that slot, not as an extra', () => {
  const bp = bp3();
  // Server has no single-slot mode: it regenerates the whole paper and returns
  // every accepted question in slot order. The regen response for "Q2 stale":
  const regenResponse = {
    questions: generatedFor(bp, 'REGENERATED'),
    rejected: [],
    meta: {},
  };
  const prev = { questions: generatedFor(bp, 'ORIGINAL'), rejected: [] };

  const merged = mergeRegeneratedResult(prev, regenResponse);
  const model = buildPaperModel({
    questions: merged.questions,
    blueprint: bp,
    settings: { class: '4' },
    subject: 'English',
    format: {},
  });

  // No question may be stranded as an unplaced extra.
  const extras = (model.layoutWarnings || []).filter((w) => Array.isArray(w.extraQuestionNumbers));
  assert.deepEqual(extras, [], 'no regenerated question should render as an unplaced extra');

  // Every slot shows the regenerated text, in order.
  const texts = modelQuestions(model).map((q) => q.text);
  assert.deepEqual(texts, ['REGENERATED slot 0', 'REGENERATED slot 1', 'REGENERATED slot 2']);
});
