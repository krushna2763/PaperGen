
import { geminiClient } from '../services/gemini-client.service.js';
import { parseJsonObject, normalizeQuestionText } from './agent-utils.js';
import { isCodingTask } from '../blueprint/question-intent.js';
import { cleanAcademicText, labelSlotItemDependencies } from '../rag/image-grounding.service.js';

/**
 * Validation Agent (Module 11)
 *
 * Two-stage validation:
 *   1. Fast deterministic checks (pure JavaScript, no LLM) — structure,
 *      required fields, marks, type, normalized exact duplicates.
 *   2. Batch LLM quality validation — one Gemini call for ALL questions that
 *      pass the deterministic stage (academic relevance, difficulty, class,
 *      subject, completeness, grammar, meaningfulness, appropriateness).
 *
 * Batch validation turns N per-question LLM calls into 1, cutting the dominant
 * latency + rate-limit churn of the pipeline.
 */
const VALID_TYPES = ['MCQ', 'SHORT_ANSWER', 'LONG_ANSWER', 'TRUE_FALSE', 'FILL_IN_THE_BLANK', 'IMAGE_BASED', 'MIXED'];

const IMAGE_DEPENDENCY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          letter: { type: 'string' },
          dependsOnImage: { type: 'boolean' },
          visuallySupported: { type: 'boolean' },
          notesSupported: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['letter', 'dependsOnImage', 'visuallySupported'],
      },
    },
  },
  required: ['items'],
};

const BATCH_VALIDATION_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          questionId: { type: 'string' },
          valid: { type: 'boolean' },
          classMatch: { type: 'boolean' },
          subjectMatch: { type: 'boolean' },
          difficultyMatch: { type: 'boolean' },
          relevant: { type: 'boolean' },
          issues: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
        },
        required: ['questionId', 'valid', 'issues', 'reason'],
      },
    },
  },
  required: ['results'],
};

function formatContext(context, limit = 5) {
  const slice = Array.isArray(context) ? context.slice(0, limit) : [];
  if (slice.length === 0) return '(no retrieved context available)';

  return slice
    .map((q, i) => `[${q.questionNumber || `source-${i + 1}`}] ${q.text}`)
    .join('\n');
}

function formatQuestions(questions) {
  return questions
    .map((q) => {
      const extras = [];
      if (q.passage) extras.push(`Passage: ${q.passage}`);
      if (Array.isArray(q.subParts) && q.subParts.length > 0) {
        extras.push(`Sub-parts: ${q.subParts
          .map((sp) => {
            const opts = Array.isArray(sp.options) && sp.options.length > 0
              ? ` [options: ${sp.options.join(' | ')}]`
              : '';
            return sp.text + opts;
          })
          .join(' | ')}`);
      }
      if (Array.isArray(q.options) && q.options.length > 0) {
        extras.push(`Options: ${q.options.join(' | ')}`);
      }
      if (q.columns && Array.isArray(q.columns.left) && Array.isArray(q.columns.right)) {
        extras.push(`Column A: ${q.columns.left.join(' | ')}`);
        extras.push(`Column B: ${q.columns.right.join(' | ')}`);
      }
      if (Array.isArray(q.choices) && q.choices.length > 0) {
        extras.push(`Internal choices (OR branches): ${q.choices
          .map((c) => c.text + (Array.isArray(c.subParts) && c.subParts.length ? ` [${c.subParts.join(' | ')}]` : ''))
          .join('  OR  ')}`);
      }
      return `[ID: ${q.questionId}] Text: ${q.text} | Type: ${q.type} | Marks (total): ${q.marks} | Claimed difficulty: ${q.difficulty}${extras.length > 0 ? '\n  ' + extras.join('\n  ') : ''}`;
    })
    .join('\n');
}

const CHECKLIST = `EVALUATION CHECKLIST (mark each per question):
1. classMatch — appropriate for the stated class level?
2. subjectMatch — within the stated subject?
3. difficultyMatch — does the actual question match the REQUESTED difficulty (not the claimed one)? Easy = direct recall; Medium = conceptual understanding + moderate reasoning; Difficult = multi-step reasoning/analysis.
4. relevant — based on concepts from the retrieved context / topic, not invented content?
5. Completeness — complete, makes sense independently, has a clear expected answer?
6. Grammar & clarity — no ambiguous or awkward wording?
7. Academic appropriateness — school-appropriate, meaningful, correctly formed?

Rules:
- If ANY checklist item clearly fails for a question, set its "valid" to false and list the issue(s).
- Do not penalize for being a NEW scenario — new scenarios are desired.
- "valid" must be true only when the question fully passes.
- PARAPHRASE DETECTION: reject simple surface-level paraphrases of reference questions. Same concept/topic is allowed; same question construction with different words, simple synonym replacement, or minor number/name changes when the underlying question is effectively copied must be rejected. The goal is NEW QUESTION with the SAME ACADEMIC PURPOSE/CONCEPT, not a reworded copy.
- CODING TASKS ("write/implement a program/function/method to X"): swapping only a fixed number or a print/display/output synonym is still a paraphrase and must be rejected. A genuine transformation — the input becomes user-supplied/parameterized, the task generalizes (e.g. to an array/arbitrary size), or the operation changes (e.g. print → sum → count) while the same programming construct is tested — is NOT a paraphrase, even though it necessarily reuses domain vocabulary (the language name, the construct name) that cannot be avoided.`;

export const validationAgent = {
  /**
   * Fast deterministic checks (pure JavaScript, no LLM).
   * @param {Object} question - { questionId, text, type, marks, difficulty }
   * @param {Object} [opts]
   *   - compareTexts: string[] raw texts to check normalized exact duplicates against
   *   - validTypes: string[] allowed types (blueprint mode widens the set)
   *   - useFullText: compare duplicates on fullText (passage+parts) instead of the bare stem
   * @returns {{ ok: boolean, reasons: string[] }}
   */
  deterministicCheck(question, opts = {}) {
    const { compareTexts = [], validTypes = VALID_TYPES, useFullText = false, blueprint = null, slotIndex = null } = opts;
    const text = String(question?.text || '').trim();
    const dupText = useFullText ? String(question?.fullText || question?.text || '').trim() : text;
    const reasons = [];

    if (!text || text.length < 5) {
      reasons.push('Question text is empty or too short.');
    } else {
      // Type-aware minimum meaningful text check.
      const type = String(question?.type || '').toUpperCase();
      const isPassage = type === 'PASSAGE' || /passage|comprehension/i.test(text);
      const isMatch = type === 'MATCH_THE_FOLLOWING';
      const isInternalChoice = type === 'INTERNAL_CHOICE';
      const isDiagram = type === 'DRAWING' || type === 'IMAGE_BASED' || /draw|sketch|label the diagram|diagram|image/i.test(text);
      // For passage/match/internal-choice/diagram, skip the semantic length check —
      // their content lives in passage/columns/choices fields.
      if (!isPassage && !isMatch && !isInternalChoice && !isDiagram) {
        // Strip HTML-like tags and normalize whitespace for a meaningful length check.
        const plainText = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        // Very short text that looks like a fragment (e.g. "a", "Q1", "b)")
        // is acceptable as a sub-part label, but a main question should be longer.
        const hasSubParts = Array.isArray(question?.subParts) && question.subParts.length > 0;
        if (!hasSubParts && plainText.length < 10) {
          reasons.push(`Question text "${plainText}" is too short to be a meaningful standalone question.`);
        }
      }
    }
    if (/\b(?:undefined|null)\b|\[object Object\]/i.test(text)) {
      reasons.push('Question text contains placeholder artifacts (undefined/null/[object Object]).');
    }
    // Incomplete output detection: abrupt truncation or unfinished fragments.
    if (text.length > 5) {
      // Ends mid-word (no space before end, no punctuation, not ending with
      // a closing bracket/parenthesis/quote).
      const endsAbruptly = /\S$/.test(text) && !/[.!?:;)\]>"'…]$/i.test(text) && !/\s{2,}$/.test(text);
      const hasSubParts = Array.isArray(question?.subParts) && question.subParts.length > 0;
      const isPassage = String(question?.type || '').toUpperCase() === 'PASSAGE' || /passage|comprehension/i.test(text);
      if (endsAbruptly && !hasSubParts && !isPassage && text.length > 15) {
        reasons.push('Question text appears abruptly truncated — no closing punctuation and ends mid-word.');
      }
    }
    // MARKS: blueprint marks are authoritative (blueprint-validator skips the
    // check when the reference marks are unknown). The deterministic gate must
    // agree, otherwise a reference slot whose printed marks could not be
    // parsed (e.g. a "Match the following" block without a marks column)
    // becomes ungeneratable — the generator faithfully emits no marks and this
    // check rejects it forever (deadlock observed live: 0/5 accepted).
    const slotMarksKnown = (() => {
      if (slotIndex == null || !blueprint || !Array.isArray(blueprint.questions)) return true;
      const slot = blueprint.questions[slotIndex];
      return slot == null || slot.totalMarks != null;
    })();
    if (slotMarksKnown && !(Number.isFinite(question?.marks) && question.marks > 0)) {
      reasons.push(`Invalid or missing marks value: ${question?.marks ?? '(none)'}.`);
    }
    if (!validTypes.includes(question?.type)) {
      reasons.push(`Invalid question type: ${question?.type || '(missing)'}.`);
    }
    if (!question?.difficulty) {
      reasons.push('Missing difficulty field.');
    }

    const norm = normalizeQuestionText(dupText);
    if (norm && compareTexts.some(t => normalizeQuestionText(t) === norm && String(t) !== dupText)) {
      reasons.push('Exact duplicate of another question (after normalization).');
    }

    return { ok: reasons.length === 0, reasons };
  },

  /**
   * Cheap deterministic pre-checks (legacy single-question entry).
   * Returns an invalid result object or null when pre-checks pass.
   * @param {Object} question
   * @returns {Object|null}
   */
  preCheck(question) {
    const result = this.deterministicCheck(question);
    if (result.ok) return null;
    return {
      valid: false,
      reason: result.reasons.join('; '),
      issues: result.reasons,
      classMatch: null,
      subjectMatch: null,
      difficultyMatch: null,
      relevant: null,
    };
  },

  /**
   * LLM quality validation of a single generated question.
   * @param {Object} question - { questionId, text, type, marks, difficulty }
   * @param {Object} requirements - { class, subject, topic?, difficulty, questionType? }
   * @param {Array<Object>} context - Retrieved source questions
   * @returns {Promise<{ valid, reason, issues, classMatch, subjectMatch, difficultyMatch, relevant }>}
   */
  async validate(question, requirements, context) {
    const [result] = await this.validateBatch([question], requirements, context);
    return result;
  },

  /**
   * Batch LLM validation — ONE Gemini call for all questions.
   * Deterministic failures are short-circuited locally; only structurally
   * valid questions reach the LLM.
   *
   * @param {Array<Object>} questions - { questionId, text, type, marks, difficulty }
   * @param {Object} requirements - { class, subject, topic?, difficulty, questionType? }
   * @param {Array<Object>} context - Retrieved source questions
   * @returns {Promise<Array<{ questionId, valid, reason, issues, classMatch, subjectMatch, difficultyMatch, relevant }>>}
   */
  async validateBatch(questions, requirements, context) {
    const results = [];
    const llmInput = [];
    const blueprint = requirements?.blueprint || null;
    // Blueprint mode widens the accepted type set to the blueprint's own types.
    const validTypes = blueprint
      ? [...new Set([...VALID_TYPES, ...blueprint.questions.map((q) => q.type)])]
      : VALID_TYPES;

    for (const question of questions) {
      const local = this.deterministicCheck(question, { validTypes, blueprint, slotIndex: question?.slotIndex ?? null });
      if (local.ok) {
        llmInput.push(question);
      } else {
        results.push({
          questionId: question.questionId,
          valid: false,
          reason: local.reasons.join('; '),
          issues: local.reasons,
          classMatch: null,
          subjectMatch: null,
          difficultyMatch: null,
          relevant: null,
        });
      }
    }

    if (llmInput.length > 0) {
      const blueprintBlock = blueprint
        ? `
LOCKED BLUEPRINT SLOT EXPECTATIONS (structure is enforced deterministically; judge CONTENT only):
${llmInput
          .map((q) => {
            const slot = q.slotIndex != null ? blueprint.questions[q.slotIndex] : null;
            if (!slot) return null;
            const rule = slot.optionalRule ? `, optionalRule=any ${slot.optionalRule.n}` : '';
            const pat = slot.pattern && typeof slot.pattern === 'object' ? slot.pattern : {};
            const patBits = [
              pat.answerForm ? `answerForm=${pat.answerForm}` : null,
              pat.instructionType ? `construction=${pat.instructionType}` : null,
              Number.isFinite(Number(pat.maxOptionCount)) ? `perItemOptions=${Math.round(Number(pat.maxOptionCount))}` : null,
            ].filter(Boolean);
            const itemRefs = (Array.isArray(slot.items) && slot.items.length > 0 ? slot.items : [])
              .filter((it) => it?.referenceText)
              .slice(0, 6);
            const anchors = itemRefs.length > 0
              ? itemRefs.map((it, ix) => `- part ${String.fromCharCode(97 + (ix % 26))}: ${String(it.referenceText).slice(0, 150)}${it.marks != null ? ` (${it.marks} mark${it.marks === 1 ? '' : 's'})` : ''}`).join('\n      ')
              : ((Array.isArray(slot.referenceItems) && slot.referenceItems.length > 0)
                  ? slot.referenceItems.slice(0, 2).map((r) => `- ${String(r).slice(0, 180)}`).join('\n      ')
                  : null);
            // MIXED SLOT — a slot like "Fill in the blanks AND choose the
            // correct answer" carries fill-blank items beside MCQ items. Its
            // single `type` is only the dominant one; each item's real form is
            // in items[].type. Spell it out so the LLM does not fail the
            // option-less fill items for "not being MCQs".
            const slotItems = Array.isArray(slot.items) ? slot.items : [];
            const itemForms = slotItems.map((it) => String(it?.type || '').toUpperCase()).filter(Boolean);
            const isMixed = String(slot?.type || '').toUpperCase() === 'MIXED'
              || (itemForms.length > 1 && new Set(itemForms).size > 1);
            const mixedNote = isMixed
              ? `\n      MIXED SLOT — each item keeps its OWN form: ${slotItems.map((it, ix) => `${String.fromCharCode(97 + ix)}=${String(it?.type || 'MCQ').toUpperCase()}${Number(it?.optionCount) >= 2 ? ` (${it.optionCount} options)` : ' (NO options — plain item / keep the blank)'}`).join(', ')}. Do NOT mark the slot invalid because the "no options" items lack options — that is the reference construction.`
              : '';
            // PHASE 6.1 — a PROGRAMMING/CODE-WRITING item ("write a program
            // to X") is an imperative task, not an academic question; a
            // different concrete OPERATION on the same construct (print →
            // sum → count) is the intended transformation, not a topic drift.
            const codingItemLetters = slotItems
              .map((it, ix) => (isCodingTask(it?.referenceText) ? String.fromCharCode(97 + ix) : null))
              .filter(Boolean);
            const codingNote = codingItemLetters.length > 0
              ? `\n      CODING ITEM(S) ${codingItemLetters.join(', ')} — these are programming/code-writing tasks. A different concrete OPERATION on the SAME underlying construct (e.g. print → sum → count → search over the same kind of loop/condition) is a VALID transformation, not a topic drift — do NOT fail topicMatch/positional concept solely because the concrete operation changed, as long as the same programming construct is exercised.`
              : '';
            return `[ID: ${q.questionId}] expected slot ${q.slotIndex + 1} (${slot.label}): type=${slot.type}, totalMarks=${slot.totalMarks}, items=${slot.itemCount}${rule}${patBits.length ? ', ' + patBits.join(', ') : ''}${mixedNote}${codingNote}\n      Reference items IN ORDER — each NEW sub-part must stay on the SAME concept as its positional counterpart (sub-part a ↔ item a, b ↔ b, …) with the same per-part marks; never swap, drop or merge concepts; new wording/scenario is expected:\n      ${anchors || '(no reference items available)'}`;
          })
          .filter(Boolean)
          .join('\n')}
The slot's TYPE, MARKS, ITEM COUNT, OPTION COUNT and PASSAGE presence are enforced deterministically by a separate blueprint validator — do NOT mark a question invalid for those here. Only judge CONTENT: (a) topicMatch — same educational concept area as the slot's reference topic anchors (never fail for a new scenario or new wording); (b) content-format consistency with the slot type (an MCQ slot must contain choice items, a passage slot must ask about its own passage) — EXCEPT a slot tagged "MIXED SLOT", where each item follows its own listed form and option-less items are correct as written; (c) relevance, difficulty, completeness, grammar, appropriateness.
`
        : '';

      const checklist = blueprint
        ? `${CHECKLIST}
8. topicMatch — stays in the SAME concept area as the slot's reference topic anchors? Same topic + new wording/scenario is exactly what is wanted; drifting to an unrelated topic is the failure case. For grouped questions check EACH sub-part against its OWN positional anchor (the anchors are listed in the same order as the sub-parts).
9. blueprintMatch — content only: is the question's CONTENT consistent with its expected slot type/answer form (e.g. an MCQ slot should actually contain multiple-choice items each with options and one correct choice; a TRUE_FALSE slot plain statements without options; a FILL_IN_THE_BLANK slot sentences with a blank)? For a slot tagged "MIXED SLOT", judge each item against ITS OWN listed form — an option-less fill-in-the-blank item beside MCQ items is correct, not a violation. Never fail on item counts or marks here — those are checked deterministically.
10. imageDependency (IMAGE_BASED slots ONLY — ignore for every other type) — could this item be fully answered using ONLY class notes/story knowledge, without ever looking at the attached image? If yes, it FAILS regardless of phrasing. The image must be NECESSARY evidence, not merely referenced — do not pass a question just because it says "look at the picture" or "observe the image"; the actual information demand must require the image's specific visible content (an object, action, person, or relationship shown in it).`
        : CHECKLIST;

      const prompt = `You are a strict question quality validator for school examinations.

Evaluate EACH GENERATED question below against the requirements and retrieved context.

REQUIREMENTS:
- Class: ${requirements.class}
- Subject: ${requirements.subject}
- Topic: ${requirements.topic || 'general (concepts from retrieved context)'}
- Requested difficulty: ${requirements.difficulty}
- Requested question type: ${requirements.questionType || 'any appropriate'}

GENERATED QUESTIONS (evaluate each one individually by its questionId):
${formatQuestions(llmInput)}
${blueprintBlock}
RETRIEVED CONTEXT (concepts the questions should be based on):
${formatContext(context)}

${checklist}

OUTPUT FORMAT: Respond with ONLY a JSON object (no prose) containing one result per questionId:
{ "results": [ { "questionId": "...", "valid": true|false, "classMatch": true|false, "subjectMatch": true|false, "difficultyMatch": true|false, "relevant": true|false, "issues": ["..."], "reason": "one-line summary" } ] }`;

      const rawText = await geminiClient.generateContent(prompt, {
        responseMimeType: 'application/json',
        responseSchema: BATCH_VALIDATION_SCHEMA,
        temperature: 0.2,
      });

      const parsed = parseJsonObject(rawText);
      const rawResults = Array.isArray(parsed?.results) ? parsed.results : [];
      const byId = new Map(rawResults.map(r => [r.questionId, r]));
      const hadAnyResults = rawResults.length > 0;

      for (const question of llmInput) {
        const r = byId.get(question.questionId);
        if (!r) {
          if (hadAnyResults) {
            // Partial/truncated LLM response: some questions got a verdict but
            // this one did not. Deterministic + similarity gates already passed,
            // so accept with a warning instead of burning a regeneration round.
            results.push({
              questionId: question.questionId,
              valid: true,
              reason: 'No LLM validation result returned (truncated response); accepted on deterministic checks.',
              issues: [],
              classMatch: null,
              subjectMatch: null,
              difficultyMatch: null,
              relevant: null,
            });
          } else {
            results.push({
              questionId: question.questionId,
              valid: false,
              reason: 'No validation result returned for this question.',
              issues: ['No validation result returned.'],
              classMatch: null,
              subjectMatch: null,
              difficultyMatch: null,
              relevant: null,
            });
          }
          continue;
        }
        const valid = r.valid === true;
        const issues = Array.isArray(r.issues) ? r.issues.filter(i => typeof i === 'string') : [];
        const reason = typeof r.reason === 'string' && r.reason.trim()
          ? r.reason.trim()
          : issues.length > 0 ? issues.join('; ') : valid ? 'Passed validation.' : 'Failed validation.';
        results.push({
          questionId: question.questionId,
          valid,
          reason,
          issues,
          classMatch: r.classMatch ?? null,
          subjectMatch: r.subjectMatch ?? null,
          difficultyMatch: r.difficultyMatch ?? null,
          relevant: r.relevant ?? null,
        });
      }
    }

    return results;
  },

  /**
   * SELECTIVE vision-verification gate for IMAGE_BASED slots ONLY (never
   * invoked for any other question type — see the caller in
   * orchestrator.agent.js, which filters to IMAGE_BASED before calling this).
   * The batch LLM validator's checklist item 10 asks the SAME question as a
   * side effect of general quality judging, which is unreliable (it may or
   * may not notice on any given call); this is a dedicated, one-purpose check
   * using the actual image (via the existing vision route — Token Harbor
   * mimo-v2.5:free, never Gemini) so the verdict does not depend on whether
   * the generic judge happened to catch it.
   *
   * Two failure modes, both real per-item facts, never a keyword check:
   *   - dependsOnImage=false — the item is answerable from notes/story
   *     knowledge alone; the image contributes nothing.
   *   - visuallySupported=false — the item's premise/claim is not actually
   *     shown in the image (a hallucinated visual detail).
   *
   * Fails OPEN on any provider/parse error — a vision outage must never turn
   * into a silent slot rejection; the metadata check (candidate-selector's
   * imageRelationshipOk) and the general LLM judge's own checklist item 10
   * remain in place as a safety net either way.
   *
   * SEMANTIC IMAGE GROUNDING (optional): when the caller passes the slot's
   * ImageGrounding object, the grounded topic/concepts and the observation
   * targets the vision analysis actually extracted ride INSIDE the prompt so
   * the verdict is anchored in what the image really depicts. The check stays
   * exactly as strict — the grounding only removes the judge's guesswork about
   * what the image contains (it no longer has to re-derive what "JDK/JRE/JVM
   * diagram" shows from pixels alone).
   *
   * @param {Object} opts
   * @param {Object} opts.question - normalized generated question
   * @param {number|null} opts.slotIndex
   * @param {Object|null} opts.blueprint - locked blueprint
   * @param {Object|null} [opts.imageGrounding] - slot's ImageGrounding (optional)
   * @returns {Promise<{ ok: boolean, reasons: string[] }>}
   */
  async checkImageDependency({ question, slotIndex = null, blueprint = null, imageGrounding = null }) {
    const slot = slotIndex != null && blueprint ? blueprint.questions?.[slotIndex] ?? null : null;
    if (!slot) return { ok: true, reasons: [] };
    const images = Array.isArray(slot.imageAssets) ? slot.imageAssets.filter(Boolean) : [];
    // Gate scope = slots that actually CARRY an image asset (label-agnostic):
    // the blueprint normalizer can re-derive an analyze-declared IMAGE_BASED
    // slot to MIXED (heterogeneous item types) while KEEPING its imageAssets —
    // such a slot's question must still be image-dependent, so it stays in
    // scope. A slot with NO asset (whatever its type label) has nothing to
    // verify against and passes immediately (frugality contract: never spend
    // a vision call without pixels).
    if (images.length === 0) return { ok: true, reasons: [] };

    const parts = Array.isArray(question?.subParts) && question.subParts.length > 0
      ? question.subParts.map((sp, i) => ({ letter: String(sp?.label || String.fromCharCode(97 + i)), text: String(sp?.text || '').trim() }))
      : [{ letter: 'a', text: String(question?.text || '').trim() }];
    const usable = parts.filter((p) => p.text.length > 0);
    if (usable.length === 0) return { ok: true, reasons: [] };

    // If the imageGrounding analysis determined that the image and notes have an alignment mismatch, reject immediately
    if (imageGrounding && imageGrounding.alignment && imageGrounding.alignment.aligned === false) {
      const label = slot.label || `Q${slotIndex + 1}`;
      return {
        ok: false,
        reasons: [
          `${label}: Selected image and syllabus notes are not sufficiently related (${imageGrounding.alignment.message || 'No meaningful match'}). Ensure both the image and syllabus notes cover the same academic topic.`
        ],
      };
    }

    // SEMANTIC IMAGE GROUNDING (optional, additive) — grounded facts about the
    // image from the reference-image vision analysis, so the judge anchors its
    // verdict in what the image actually depicts instead of guessing.
    const ri = imageGrounding?.status === 'ok' ? imageGrounding.referenceImage ?? null : null;
    const groundingBlock = ri ? [
      `GROUND TRUTH extracted from the image itself (treat as authoritative):`,
      `- Topic: ${ri.topic ?? 'unknown'}`,
      ri.concepts?.length ? `- Concepts/labels depicted: ${ri.concepts.join(', ')}` : null,
      ri.visualElements?.length ? `- Elements actually shown: ${ri.visualElements.join('; ')}` : null,
      ri.relationships?.length ? `- Relationships the image expresses: ${ri.relationships.join('; ')}` : null,
    ].filter(Boolean).join('\n') : '';

    const notesChunks = (Array.isArray(imageGrounding?.notesTextEvidence) ? imageGrounding.notesTextEvidence : [])
      .map((n) => typeof n === 'string' ? n : n?.text)
      .filter(Boolean)
      .slice(0, 5);
    const notesBlock = notesChunks.length > 0
      ? `SYLLABUS NOTES retrieved for this question (academic ground truth):\n${notesChunks.join('\n---\n')}`
      : '';

    // ITEM-LEVEL IMAGE DEPENDENCY (spec correction) — each generated sub-part
    // is judged against its POSITIONAL reference item's dependency class, not
    // a blanket "everything must be answerable from pixels" rule:
    //   IMAGE_DEPENDENT  — the reference item explicitly asks about something
    //                      shown in the image ("shown in the diagram"); the
    //                      generated part must likewise require the image.
    //   IMAGE_CONTEXTUAL — the reference item shares the image's topic but its
    //                      answer is topic-grounded knowledge (e.g. "which
    //                      component is required for developing Java
    //                      applications? give one reason"); the generated part
    //                      must stay on topic but must NOT be rejected merely
    //                      because it can be answered without the image.
    // Deterministic labels from the reference paper's own item texts; when the
    // reference shows no explicit visual cue anywhere, the conservative legacy
    // model applies (every part held to visual dependency).
    const itemDeps = slot?.items ? labelSlotItemDependencies(slot) : [];
    const depNote = (i) => {
      const d = itemDeps[i];
      if (d === 'IMAGE_DEPENDENT') {
        return 'The REFERENCE item at this position explicitly asks about something SHOWN in the image — the generated item must likewise require observing the image to answer.';
      }
      if (d === 'IMAGE_CONTEXTUAL') {
        return 'The REFERENCE item at this position is CONTEXTUAL: it belongs to the image topic but its answer is topic knowledge, not a unique visual feature. The generated item must stay on the image topic, but being answerable WITHOUT the image is CORRECT for this item — do not fail it for that.';
      }
      return '';
    };

    const prompt = `You are checking whether exam questions genuinely require looking at an attached image AND are grounded in the provided syllabus notes.

${groundingBlock ? `${groundingBlock}\n\n` : ''}${notesBlock ? `${notesBlock}\n\n` : ''}ITEMS TO CHECK (each is one part of an image exam question):
${usable.map((p, i) => `(${p.letter}) ${p.text}${depNote(i) ? `\n    [Reference relationship] ${depNote(i)}` : ''}`).join('\n')}

For EACH item judge three facts, USING the reference relationship noted above:
1. dependsOnImage — could a student answer this using ONLY general subject/notes/story knowledge, WITHOUT ever looking at the image? If yes, dependsOnImage = false. If answering genuinely requires observing something specific the image shows (an object, action, person, label, or relationship), dependsOnImage = true. A question that merely SAYS "look at the picture" but could be answered without it is still false.${ri?.concepts?.length ? ` Use the ground truth above: an item is image-dependent ONLY when it asks about concepts/elements/relationships actually listed there.` : ''}
2. visuallySupported — is the premise or claim the item makes actually consistent with what the image shows (not an invented detail)?${ri ? ' The ground truth above defines what the image shows.' : ''}
3. notesSupported — if the item makes an academic claim or reference to the lesson/notes, is it supported by the syllabus notes above? (If no syllabus notes are provided or the question only asks for direct observation of what the image depicts, notesSupported = true).

${itemDeps.some((d) => d === 'IMAGE_CONTEXTUAL') ? 'IMPORTANT: apply dependsOnImage STRICTLY only to items whose reference relationship says the reference itself is image-DEPENDENT. For items marked CONTEXTUAL, dependsOnImage = false is EXPECTED and must not be reported as a failure — judge only visuallySupported and notesSupported for them.\n' : ''}
Respond with ONLY JSON: { "items": [ { "letter": "a", "dependsOnImage": true|false, "visuallySupported": true|false, "notesSupported": true|false, "note": "one short phrase" } ] }`;

    let parsed;
    try {
      const raw = await geminiClient.generateContent(prompt, {
        responseMimeType: 'application/json',
        responseSchema: IMAGE_DEPENDENCY_SCHEMA,
        temperature: 0.1,
        images,
      });
      parsed = parseJsonObject(raw);
    } catch {
      return { ok: true, reasons: [] };
    }

    const byLetter = new Map((Array.isArray(parsed?.items) ? parsed.items : []).map((it) => [String(it?.letter ?? ''), it]));
    const label = slot.label || `Q${slotIndex + 1}`;
    const marksBit = slot.totalMarks != null ? `, ${slot.totalMarks} total marks` : '';
    const reasons = [];
    for (let i = 0; i < usable.length; i++) {
      const p = usable[i];
      const verdict = byLetter.get(p.letter);
      if (!verdict) continue; // no result returned for this item — never manufacture a failure
      // Item-level exemption: a CONTEXTUAL reference item's generated part is
      // allowed to be answerable without the image — that is the reference's
      // own relationship with the image, faithfully preserved.
      const dep = itemDeps[i];
      if (verdict.dependsOnImage === false && dep === 'IMAGE_CONTEXTUAL') continue;
      if (verdict.dependsOnImage === false) {
        reasons.push(
          `${label}(${p.letter}) is answerable without the image (image-dependency check) — it does not require observing `
          + `the picture. KEEP: the slot's IMAGE_BASED type${marksBit} and unit. CHANGE: require identifying, describing, `
          + `or comparing something actually VISIBLE in the image.`
        );
      } else if (verdict.visuallySupported === false) {
        reasons.push(
          `${label}(${p.letter}) makes a claim not visually supported by the image (image-dependency check) — what the `
          + `question/answer assumes is not shown. Rewrite it around something the image actually depicts.`
        );
      } else if (verdict.notesSupported === false) {
        reasons.push(
          `${label}(${p.letter}) makes an academic claim not supported by the syllabus notes (notes-grounding check) — `
          + `the question must align with the retrieved syllabus notes content.`
        );
      }
    }
    return { ok: reasons.length === 0, reasons };
  },

  /**
   * Deterministic per-item topic fidelity check.
   * Compares each generated sub-part against its corresponding positional
   * reference item using topic anchors or derived content terms.
   * @param {Object} question - generated question
   * @param {Object} slot - blueprint slot with items[].referenceText / items[].topicAnchor
   * @returns {{ ok: boolean, reasons: string[] }}
   */
  checkPerItemTopicFidelity(question, slot, opts = {}) {
    const reasons = [];
    if (!question || !slot) return { ok: true, reasons };

    const slotType = String(slot.type || '').toUpperCase();
    const imageBearing = Array.isArray(slot.imageAssets) && slot.imageAssets.length > 0;
    // ITEM-LEVEL dependency labels for the reference items (deterministic).
    const itemDeps = (imageBearing || slotType === 'IMAGE_BASED') && Array.isArray(slot.items)
      ? labelSlotItemDependencies(slot)
      : [];

    // IMAGE_BASED without a usable image has nothing to verify (frugality
    // contract) and without items there is no per-item model — both fall
    // through to the legacy skip.
    if (slotType === 'IMAGE_BASED' && !imageBearing) return { ok: true, reasons };

    const parts = Array.isArray(question.subParts) ? question.subParts : [];
    const refItems = Array.isArray(slot.items) && slot.items.length > 0 ? slot.items : [];
    if (refItems.length === 0 || parts.length === 0) return { ok: true, reasons };

    const label = slot.label || question.questionId || 'question';
    const STOP_WORDS = new Set([
      'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
      'before', 'after', 'above', 'below', 'between', 'under', 'again',
      'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
      'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
      'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than',
      'too', 'very', 'just', 'because', 'but', 'and', 'or', 'if', 'while',
      'about', 'against', 'that', 'this', 'these', 'those', 'what', 'which',
      'who', 'whom', 'whose', 'name', 'list', 'give', 'explain', 'describe',
      'write', 'mention', 'state', 'define', 'differentiate', 'compare',
      'following', 'correct', 'true', 'false', 'fill', 'blanks', 'match',
      'column', 'columns', 'choose', 'select', 'mark', 'tick', 'put',
    ]);

    // OCR/table noise from marks-column papers ("… [05] COl BL2" lines read
    // from a table) must never become topic anchors: it inflates the coverage
    // denominator AND the KEEP instruction would tell the generator to write
    // "col, bl3" into the question. Generic meta-token shapes only —
    // course-outcome / Bloom-level / mapping codes (CO1, COl, BL2, PO3, BT4,
    // K2, Q3) and bare numbers — never subject-specific words.
    const META_TOKEN = /^(co\d?[li]?|bl\d?[li]?|po\d+|ps\d+|bt\d+|k\d+|q\d+|marks?|mks?)$/i;
    const isAnchorNoise = (w) => META_TOKEN.test(w) || /^\d/.test(w);

    function extractTerms(text) {
      return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
    }

    // Prefix-stem match: "applications" matches anchor "application" (and
    // vice versa) so a correct candidate is never rejected over a plural/
    // singular form. Requires >=4-char overlap to avoid false prefixes.
    function termMatches(genWord, anchorWord) {
      if (genWord === anchorWord) return true;
      const min = Math.min(genWord.length, anchorWord.length);
      if (min < 4) return genWord === anchorWord;
      const n = Math.min(min, Math.max(4, min - 1));
      return genWord.slice(0, n) === anchorWord.slice(0, n);
    }

    function coverageRatio(terms, anchors) {
      if (anchors.length === 0) return 1;
      let matched = 0;
      for (const a of anchors) {
        if (terms.some((t) => termMatches(t, a))) matched++;
      }
      return matched / anchors.length;
    }

    // SEMANTIC IMAGE GROUNDING as the PRIMARY topic anchor (spec preference
    // order: grounding topic → grounding concepts → structured item anchor →
    // cleaned item text). When the slot carries vision-extracted grounding,
    // its topic/concepts are validated academic terms for this image's topic;
    // a generated part that engages ANY of them is topic-grounded even if it
    // does not reuse the reference item's own wording.
    const grounding = opts.imageGrounding ?? slot.imageGrounding ?? null;
    const ri = grounding?.status === 'ok' ? grounding.referenceImage ?? null : null;
    const groundTerms = ((imageBearing || slotType === 'IMAGE_BASED') && ri)
      ? extractTerms(cleanAcademicText([ri.topic, ...(Array.isArray(ri.concepts) ? ri.concepts : [])].filter(Boolean).join(' ')))
        .filter((t) => !isAnchorNoise(t))
      : [];

    const maxPairs = Math.min(parts.length, refItems.length);
    for (let i = 0; i < maxPairs; i++) {
      const letter = String.fromCharCode(97 + (i % 26));
      const refItem = refItems[i];
      const part = parts[i];
      if (!part) continue;

      // IMAGE_DEPENDENT parts are exempt from literal vocabulary overlap:
      // their real evidence is the image + the locked unit/topic, and the
      // image-dependency gate (better-informed, vision-based) owns their
      // correctness. Holding them to the reference's exact wording would
      // reject a valid visual question phrased differently from the
      // reference's own sentence.
      if (itemDeps[i] === 'IMAGE_DEPENDENT') continue;

      // Derive anchor terms from reference item. Non-academic noise (marks
      // like [02], CO/BL metadata, OCR artifacts such as "COl BL3", section
      // codes) is stripped BEFORE matching so it can never steer the topic
      // gate — the anchor must be the item's academic text.
      const anchorSource = refItem.topicAnchor || refItem.referenceText || '';
      const anchorTerms = extractTerms(cleanAcademicText(anchorSource));
      const genText = [part.text, ...(Array.isArray(part.options) ? part.options : [])].join(' ');
      const genTerms = extractTerms(genText);
      // Defense in depth: the extractor also drops residual meta-token shapes
      // so noise never feeds the coverage math or the KEEP instruction.
      const cleanAnchors = anchorTerms.filter((t) => !isAnchorNoise(t));

      if (cleanAnchors.length === 0 && groundTerms.length === 0) continue; // Fail open — insufficient reference info.

      // Preference order in action: when the item anchor is empty after
      // cleaning (pure OCR/marks noise), the GROUNDING topic/concepts become
      // the effective anchor — a part must then engage the image's actual
      // topic to pass. When both exist, either signal can ground the part
      // (grounding first, cleaned item text as secondary evidence).
      const effectiveAnchors = cleanAnchors.length > 0 ? cleanAnchors : groundTerms;
      const coverage = coverageRatio(genTerms, effectiveAnchors);
      const groundingHit = groundTerms.length > 0
        && genTerms.some((g) => groundTerms.some((t) => termMatches(g, t)));
      if (coverage >= 0.25 || groundingHit) continue;
      if (coverage < 0.25 && !groundingHit && genTerms.length > 0) {
        // Name the SPECIFIC reference terms the rewrite dropped — without this,
        // "shares no meaningful terms" gives the regeneration prompt nothing to
        // act on, and a retry told (by the novelty gate) to move away from the
        // reference's wording has no counter-signal telling it which of the
        // reference's own words it still needs to keep some of, so the two
        // gates can fight for every retry without ever converging.
        const missing = [...new Set(effectiveAnchors.filter((t) => !genTerms.some((g) => termMatches(g, t))))].slice(0, 6);
        const keepBit = missing.length > 0
          ? ` KEEP: reuse at least one or two of the reference's own topic words — ${missing.join(', ')} — the same underlying idea, in new wording.`
          : (groundTerms.length > 0
            ? ` KEEP: stay on the image topic — engage one of: ${groundTerms.slice(0, 6).join(', ')}.`
            : '');
        reasons.push(
          `${label}(${letter}): topic mismatch — generated content shares no meaningful terms with reference "${String(cleanAcademicText(anchorSource)).slice(0, 80)}".${keepBit}`
        );
      }
    }

    return { ok: reasons.length === 0, reasons };
  },
};

export default validationAgent;