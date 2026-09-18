/**
 * adaptive-feedback.agent.js — ADAPTIVE TARGETED-REGENERATION FEEDBACK.
 *
 * A retry that receives the SAME static instruction on every attempt has no
 * way to tell whether its previous attempt is being rejected for the reason
 * it thinks. This module reads the actual previous CANDIDATE text plus the
 * validators' own rejection reasons and builds a corrective feedback block
 * naming the SPECIFIC thing that failed — the literal banned word actually
 * used, the exact phrase reused from the reference, the concrete topic words
 * to reintroduce (lifted straight from the topic-fidelity gate's own KEEP
 * clause), or the requested difficulty versus what was judged. Fully
 * generic — every detector reads the candidate/reasons text, never a
 * hardcoded story, unit, or subject.
 *
 * Pure, deterministic, no AI calls. The validators remain the sole authority
 * on pass/fail — this only makes their existing verdicts more actionable for
 * the next generation attempt.
 */
import { findBroadSummaryTrigger } from './reference-novelty.agent.js';

const NARROWER_DEMAND_SUGGESTIONS =
  'a character trait, a specific event, a cause/effect relationship, a consequence, evidence from one event, or an application';

/** letter → subPart index, e.g. 'd' → 3. */
function indexOfLetter(letter) {
  return letter.charCodeAt(0) - 97;
}

/** Every `(x)` item-letter reference inside a reason string, deduped, in order.
 * The literal plural `term(s)` (grounding reason boilerplate) is NOT a letter
 * reference — excluded by lookbehind. */
function lettersIn(reason) {
  const letters = [];
  const re = /(?<!term ?)\(([a-z])\)/g;
  let m = re.exec(reason);
  while (m) {
    if (!letters.includes(m[1])) letters.push(m[1]);
    m = re.exec(reason);
  }
  return letters;
}

/** Longest contiguous run of shared literal words (length >= 3) between two texts, or null. */
function longestSharedPhrase(a, b) {
  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const wa = words(a);
  const wb = words(b);
  let best = [];
  for (let i = 0; i < wa.length; i++) {
    for (let j = 0; j < wb.length; j++) {
      let k = 0;
      while (i + k < wa.length && j + k < wb.length && wa[i + k] === wb[j + k]) k++;
      if (k > best.length) best = wa.slice(i, i + k);
    }
  }
  return best.length >= 3 ? best.join(' ') : null;
}

function subPartTextAt(candidate, letter) {
  const parts = Array.isArray(candidate?.subParts) ? candidate.subParts : [];
  return String(parts[indexOfLetter(letter)]?.text || '').trim();
}

/** The candidate text a reason without a `(x)` letter refers to: the whole
 * question — top-level stem plus every sub-part (a multi-item question's
 * rejected content usually lives in subParts, not in the bare stem). */
function wholeCandidateText(candidate) {
  const parts = Array.isArray(candidate?.subParts) ? candidate.subParts : [];
  return [String(candidate?.text || ''), ...parts.map((p) => String(p?.text || ''))]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');
}

function refTextAt(slot, letter) {
  const items = Array.isArray(slot?.items) ? slot.items : [];
  const item = items[indexOfLetter(letter)];
  return String(item?.referenceText || item?.topicAnchor || '').trim();
}

/** Same classification the main loop uses below — shared so a history scan
 * and the live loop never disagree about what counts as "reused reference
 * wording" vs "drifted off topic". No duplicate taxonomy: these mirror the
 * exact predicates inlined in buildAdaptiveFeedback's own loop. */
function isReuseReason(reason) {
  return /SAME_DEMAND_SHAPE|SAME_INFORMATION_DEMAND|NEAR_PARAPHRASE|EXACT_COPY|near-verbatim restatement/.test(reason)
    || /paraphrase of the reference question/i.test(reason)
    || /same construction and meaning/i.test(reason)
    || /restates the reference question/i.test(reason)
    // PHASE 6 E2E: the AI quality validator emits FREE-TEXT paraphrase
    // verdicts (e.g. "Paraphrase: sub-part (b) is effectively the reference
    // task '...' with only the parity and upper limit changed (…) — same
    // construction, same academic purpose — not a NEW question."). Recognize
    // those shapes generically so the failure-specific anti-paraphrase
    // directive fires for them too (no subject/topic-specific terms).
    || /(^|\n)\s*paraphrase\s*:/i.test(reason)
    || (/\breference\b/i.test(reason)
      && /effectively|same construction|only the [a-z ]+changed/i.test(reason));
}
function isDriftReason(reason) {
  return /topic mismatch/i.test(reason);
}

/** Reference text for a letter (or the whole slot's items when no letter). */
function refTextForLetter(slot, letter) {
  if (letter) return refTextAt(slot, letter);
  const items = Array.isArray(slot?.items) ? slot.items : [];
  return items
    .map((it) => String(it?.referenceText || it?.topicAnchor || '').trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * Build one corrective feedback block from the previous candidate + the
 * reasons it was rejected for. Returns '' when nothing specific could be
 * identified — the raw reasons already reach the prompt unchanged elsewhere;
 * this is an ADDITIVE enrichment, never a replacement, and never invents a
 * correction it cannot ground in the actual candidate/reason text.
 * @param {Object} opts
 * @param {Object|null} opts.previousCandidate - the rejected question object
 * @param {string[]} opts.reasons - the rejection reasons for that candidate
 * @param {Object} [opts.requirements] - { difficulty, ... }
 * @param {Object|null} [opts.slot] - the blueprint slot (for reference text lookup)
 * @param {string[]} [opts.priorReasons] - rejection reasons from EARLIER rounds
 *   for this SAME slot (not the current/latest round, which is `reasons`).
 *   Without this, a slot that was rejected for reusing the reference's own
 *   wording (attempt 1) and then, having been told to change the wording,
 *   drifts to sharing no topic terms at all (attempt 2) gets feedback that
 *   only ever reacts to the MOST RECENT failure — nothing tells attempt 3 not
 *   to swing back to the first extreme. This adds one guard clause per
 *   opposite-extreme pair actually observed in this slot's own history.
 * @returns {string}
 */
export function buildAdaptiveFeedback({ previousCandidate, reasons, requirements = {}, slot = null, priorReasons = [] }) {
  const list = Array.isArray(reasons) ? reasons : [];
  if (!previousCandidate || list.length === 0) return '';

  const history = Array.isArray(priorReasons) ? priorReasons : [];
  const historyHasReuse = history.some(isReuseReason);
  const historyHasDrift = history.some(isDriftReason);

  const bullets = [];
  const seen = new Set();

  for (const reason of list) {
    const letters = lettersIn(reason);
    const isNoveltyDemand = isReuseReason(reason);
    const isTopicMismatch = isDriftReason(reason);
    const isImageDependency = /\(image-dependency check\)|image dependency\b|answered from class notes.*without inspecting the diagram|diagram.*not necessary evidence/i.test(reason);
    const isFormatMismatch = /Content-format mismatch|expected slot type|item form is/i.test(reason);
    // PHASE 6.1 — a coding-task candidate that only swapped the reference's
    // fixed number(s) and/or a print/display/output synonym.
    const isParameterSwap = /PARAMETER_SWAP/.test(reason);
    // Positional-concept mismatch from the LLM slot validator: sub-part a
    // answered item b's concept (and/or vice versa) — a SWAP, not a rewrite.
    const isPositionalSwap = /matches the expected part [a-z](?:\s+concept)?\b|does not match the expected part [a-z] concept|swapped\/mismatched against the blueprint anchors|swapped.*positional|against its positional/i.test(reason);
    // PHASE 6 — answerability/ambiguity: the stem does not pose a clear,
    // answerable request (answerabilityIssues wording), or the semantic
    // validator flagged an unclear/vague stem.
    const isAmbiguity = /answerable request|cannot be answered as a choice question|unclear|ambiguous|vague/i.test(reason);
    // PHASE 6 — cognitive-demand quality: the semantic validator judged the
    // question too easy / recall-only for the requested difficulty. Structure
    // stays locked; the COGNITIVE demand must rise instead.
    const isCognitiveDemand = /too easy|more cognitive|cognitive demand|deeper reasoning|higher.{0,20}(difficulty|cognitive)/i.test(reason);
    // Deterministic grounding shortfall (grounding.agent.js): some content
    // terms matched but coverage/term-count fell below the floor. The literal
    // strings the check emits are matched so the directive can quote them.
    const isGroundingShortfall = /is not fully supported by (unit|the retrieved notes)/i.test(reason) || /content term\(s\) covered/i.test(reason);

    if (isNoveltyDemand) {
      for (const letter of letters.length > 0 ? letters : [null]) {
        const key = `demand:${letter ?? 'all'}`;
        if (seen.has(key)) continue;
        // A reason letter may point outside the candidate's own subParts
        // (e.g. the candidate produced fewer items than the slot declared);
        // fall back to the whole candidate so the directive is never lost.
        let candText = letter ? subPartTextAt(previousCandidate, letter) : wholeCandidateText(previousCandidate);
        if (!candText && letter) candText = wholeCandidateText(previousCandidate);
        const where = letter ? `for (${letter}) ` : '';
        const trigger = findBroadSummaryTrigger(candText);
        if (trigger) {
          seen.add(key);
          bullets.push(
            `Your previous attempt ${where}used "${trigger}", which repeats a broad moral/theme-summary demand. `
            + `Do not use that word or its synonyms again — change the information demand completely. `
            + `Choose a concrete angle instead: ${NARROWER_DEMAND_SUGGESTIONS}.`
          );
          continue;
        }
        const refText = slot ? refTextForLetter(slot, letter) : '';
        const phrase = refText ? longestSharedPhrase(candText, refText) : null;
        // This slot already failed the OPPOSITE way earlier (drifted off
        // topic entirely) — without this, correcting the current reuse
        // problem has no reason not to swing back to that same drift.
        const driftGuard = historyHasDrift
          ? ' Earlier you also tried dropping the topic entirely and that failed too — keep a light topical connection to the reference item while still asking something new.'
          : '';
        if (phrase) {
          seen.add(key);
          bullets.push(
            `Your previous attempt ${where}reused the phrase "${phrase}" almost verbatim from the reference. `
            + `Do not reuse this exact wording — ask about a different fact, angle, or reasoning step on the same topic.${driftGuard}`
          );
        } else if (candText) {
          seen.add(key);
          bullets.push(
            `Your previous attempt ${where}was judged too similar in meaning to its reference item even though the wording `
            + `differed. Change the underlying question being asked, not just the phrasing — a cosmetic rewrite of `
            + `the same ask will be rejected again. Build the new item around a DIFFERENT detail, event, or `
            + `relationship than the reference item uses.${driftGuard}`
          );
        }
      }
    } else if (isTopicMismatch) {
      for (const letter of letters.length > 0 ? letters : [null]) {
        const key = `topic:${letter}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const keepMatch = reason.match(/KEEP:[^.]*\./);
        const where = letter ? `for (${letter}) ` : '';
        // This slot already failed the OPPOSITE way earlier (reused the
        // reference's own wording almost verbatim) — without this, fixing
        // today's drift has no reason not to swing back to that reuse.
        const reuseGuard = historyHasReuse
          ? ' Do not fix this by going back to the reference\'s own wording either — you already tried that and it was rejected as too similar.'
          : '';
        bullets.push(
          `Your previous attempt ${where}drifted away from the reference topic entirely. `
          + (keepMatch ? keepMatch[0] : "Reintroduce the reference item's own topic in new wording.") + reuseGuard
        );
      }
    } else if (isImageDependency) {
      for (const letter of letters.length > 0 ? letters : [null]) {
        const key = `image:${letter ?? 'all'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const where = letter ? `(${letter}) ` : '';
        const notSupported = /not visibly supported/i.test(reason);
        bullets.push(
          notSupported
            ? `IMAGE DEPENDENCE: your previous attempt ${where}made a claim the image does not actually show. `
              + `Rewrite it around something the image genuinely depicts — do not invent visual detail that isn't there.`
            : `IMAGE DEPENDENCE: your previous attempt ${where}could be answered from notes/subject knowledge alone, `
              + `without ever looking at the image. The student-facing question text MUST explicitly require inspecting the picture `
              + `(use visual relational wording such as "Observe the diagram and identify...", "Locate in the depicted architecture...", "Based on the position/layers shown in the figure...") `
              + `to ask about visible spatial layout, layer hierarchy (bottom/middle/top), relative arrangement, or component grouping shown in the figure `
              + `(an object, layer, position, or relationship shown) — never general textbook recall (e.g. simply asking which service model provides Virtual Machines or which layer contains Runtime Environment). `
              + `Frame the question around details only obtainable from the diagram: tier positioning (base/intermediate/top) and which components are visually grouped inside that container. `
              + `Keep the same type, marks, and unit.`
        );
      }
    } else if (isFormatMismatch) {
      for (const letter of letters.length > 0 ? letters : [null]) {
        const key = `format:${letter ?? 'all'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const where = letter ? `(${letter}) ` : '';
        bullets.push(
          `FORMAT MISMATCH: your previous attempt ${where}did not match the expected question format or item type (e.g. wrote an EXPLAIN essay for a SHORT_ANSWER item). `
          + `If an item is SHORT_ANSWER (<= 1 mark), write a concise 1-2 sentence direct identification/statement ask (e.g. "Identify...", "State..."), NOT an open-ended explain essay. `
          + `Ensure each sub-part strictly matches its own declared item type.`
        );
      }
    } else if (isParameterSwap) {
      for (const letter of letters.length > 0 ? letters : [null]) {
        const key = `paramswap:${letter ?? 'all'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const where = letter ? `(${letter}) ` : '';
        bullets.push(
          `CODE TASK: your previous attempt ${where}only changed a fixed number and/or swapped a print/display/output `
          + `synonym — the underlying task is unchanged, so it is still a paraphrase. Do not rewrite the wording or the `
          + `numbers; instead change the INPUT MODEL (accept the bound/value from the user, or generalize to an `
          + `arbitrary array/list/parameter) or the OPERATION performed (e.g. print → sum → count → search) while `
          + `testing the same programming construct. Keep the same answer form, structure, marks and difficulty.`
        );
      }
    } else if (isPositionalSwap) {
      // One directive per candidate (key without letter): the failure is the
      // sub-part ORDERING itself — the pairs (a↔a, b↔b) must move as a set.
      const key = 'positional';
      if (!seen.has(key)) {
        seen.add(key);
        const refBits = slot && Array.isArray(slot.items)
          ? slot.items.map((it, ix) => `(${String.fromCharCode(97 + ix)}) ${String(it?.referenceText || it?.topicAnchor || '').trim().slice(0, 100)}`).filter((b) => b.length > 6).join(' | ')
          : '';
        bullets.push(
          `CONCEPT ORDERING: your previous attempt kept valid content but attached it to the WRONG sub-part slot — `
          + `part (a) must sit on reference item (a)'s concept, part (b) on item (b)'s, in the same order, never swapped. `
          + (refBits
            ? `Re-issue the SAME content re-assigned to the correct positional items; the reference items in order are: ${refBits}.`
            : `Re-issue the SAME content re-assigned to the correct positional items as listed in the slot spec.`)
        );
      }
    } else if (isGroundingShortfall) {
      for (const letter of letters.length > 0 ? letters : [null]) {
        const key = `ground:${letter ?? 'all'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const missing = reason.match(/missing:\s*([^.]+)\.?$/i);
        const covMatch = reason.match(/\((\d+)% < (\d+)%\)/);
        const where = letter ? `for (${letter}) ` : '';
        const covBit = covMatch ? ` (your previous attempt covered only ${covMatch[1]}%; the floor is ${covMatch[2]}%)` : '';
        bullets.push(
          `EVIDENCE GROUNDING: your previous attempt ${where}used wording the unit notes do not support${covBit}. `
          + (missing && missing[1] && missing[1].trim() !== '—'
            ? `Rewrite the ${letter ? `(${letter}) ` : ''}item so it asks about concepts the notes actually cover — these unsupported terms caused the rejection: ${missing[1].trim()}. Replace or drop them; do not just insert them decoratively.`
            : `Rewrite the ${letter ? `(${letter}) ` : ''}item using concepts and vocabulary the retrieved unit notes actually cover.`)
        );
      }
    } else if (isAmbiguity) {
      for (const letter of letters.length > 0 ? letters : [null]) {
        const key = `ambiguity:${letter ?? 'all'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const where = letter ? `(${letter}) ` : '';
        bullets.push(
          `AMBIGUITY: your previous attempt ${where}did not pose a clear, answerable request. `
          + `Rewrite it with ONE explicit task (explain/compare/calculate/choose…), enough context to answer unambiguously, `
          + `and exactly one defensible correct answer. Keep the same type, marks, item count, topic and unit.`
        );
      }
    } else if (isCognitiveDemand) {
      for (const letter of letters.length > 0 ? letters : [null]) {
        const key = `cognitive:${letter ?? 'all'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const where = letter ? `(${letter}) ` : '';
        bullets.push(
          `COGNITIVE DEMAND: your previous attempt ${where}relied on direct recall where the paper requires deeper thinking. `
          + `Raise the demand WITHOUT changing the structure: ask the student to apply the concept to a situation, trace a `
          + `cause/effect chain, draw an inference from given conditions, or compare two instances — never just name or define.`
        );
      }
    } else if (/difficulty/i.test(reason) && requirements.difficulty) {
      const key = 'difficulty';
      if (!seen.has(key)) {
        seen.add(key);
        bullets.push(
          `DIFFICULTY: your previous attempt was judged — "${reason}" — this paper requires `
          + `${requirements.difficulty} difficulty. Add a genuine reasoning, application, or inference step; `
          + `do not rely on direct recall alone.`
        );
      }
    }
  }

  if (bullets.length === 0) return '';
  return 'ADAPTIVE FEEDBACK ON YOUR PREVIOUS ATTEMPT (fix these specific issues, then produce a genuinely NEW candidate):\n'
    + bullets.map((b) => `- ${b}`).join('\n');
}

export default { buildAdaptiveFeedback };
