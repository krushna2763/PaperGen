/**
 * Question Extractor Module
 * Deterministic extraction and structuring of academic questions from cleaned PDF text.
 * 
 * Philosophy: ONE QUESTION = ONE PRIMARY STRUCTURED OBJECT (1 Question = 1 Chunk for future RAG)
 */

export const questionExtractor = {
  /**
   * Extract individual question objects from cleaned text and optional page data
   * @param {string} text - Cleaned raw text of the question paper
   * @param {Array<{pageNumber: number, text: string}>} [pages=[]] - Optional page-level text breakdown
   * @returns {{ questions: Array<Object>, count: number, sections: Array<string>, warnings: Array<string> }}
   */
  extract(text, pages = []) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return {
        questions: [],
        count: 0,
        sections: [],
        warnings: ['Input text is empty. No questions could be extracted.']
      };
    }

    const lines = text.split('\n');
    const rawQuestions = [];
    const detectedSections = new Set();
    const warnings = [];

    let currentSection = null;
    let currentQuestion = null;
    let currentParentNumber = null;
    // Open NUMBERED item ("1. …") of the current main, plus the lettered group
    // header ("A. Fill in the blanks:") it belongs to. Bare-numbered lines
    // under an open Q-form main are that main's items — see the subordination
    // rule in the main-question branch below.
    let currentSub = null;
    let currentGroupLabel = null;
    // A line that is NOTHING but a marks label ("(3 marks)", "[4 Marks]") —
    // tracked in page order as it's seen. OCR's reading-order detection can
    // cluster these right-aligned labels together and emit them as one block
    // AFTER the entire question body instead of inline next to their own
    // heading, so they still get appended as ordinary continuation text
    // below (harmless when the order is intact — finalizeQuestion's own
    // trailing-marks regex picks them up normally) AND recorded here so a
    // post-pass can positionally repair any main question that still has no
    // marks once every line has been scanned (see the ORPHAN MARKS REPAIR
    // block after flushQuestion()).
    const BARE_MARKS_LINE_RE = /^[([]?\s*(\d+(?:\.\d+)?)\s*(?:marks?|mark|m|pts)\s*[)\]]?\s*$/i;
    const orphanMarks = [];

    const hasSubItems = (q) => Array.isArray(q?.subParts) && q.subParts.length > 0;

    // Flush the open question (when it has a stem or numbered items), pushing
    // one record — or several, when numbered "items" restore as standalone
    // questions (see finalizeQuestion).
    const flushQuestion = () => {
      if (!currentQuestion) return;
      if (currentQuestion.text.trim() || hasSubItems(currentQuestion)) {
        const out = finalizeQuestion(currentQuestion, pages);
        (Array.isArray(out) ? out : [out]).forEach((r) => rawQuestions.push(r));
      }
      currentQuestion = null;
      currentSub = null;
      currentGroupLabel = null;
    };

    // Helper: Match Section Header (e.g. "SECTION A - BIOLOGY", "Section 1", "PART B")
    const sectionRegex = /^(?:SECTION|Section|PART|Part)\s+([A-Za-z0-9]+)(?:\s*[-–—:]\s*(.*))?$/i;

    // Helper: Match Main Question Starts.
    //   Q-form  : "Q1.", "Q1)", "Q.1", "Question 1:", or a BARE "Q.1" / "Q1"
    //             line whose stem is on the following lines (stem may be empty).
    //             groups 1 = "Q" flag, 2 = number, 3 = inline stem
    //   bare    : "1.", "1)", "1 - " — a separator/space after the number is
    //             REQUIRED so stray tokens ("2026-27", page numbers) are ignored.
    //             groups 4 = number, 5 = inline stem
    // The separator class includes "," alongside the usual "." — Tesseract OCR
    // (the fallback path for a PDF with no extractable text layer) commonly
    // misreads a numbered item's period as a comma ("2." -> "2,"); without
    // this, that line is never recognized as a new item and gets appended as
    // a raw continuation onto whatever text was already open, corrupting it
    // (observed: it swallowed a main question's own "(N Marks)" label).
    const mainQuestionRegex =
      /^(?:(Q)(?:uestion)?\.?\s*(\d+)(?:[:.,)\-]+\s*|\s+)?(.*)|(\d+)(?:[:.,)\-]+\s*|\s+)(.*))$/i;

    // Helper: Match Sub-question (e.g. "(a) ...", "(b) ...", "(i) ...", "a) ...")
    const subQuestionStartRegex = /^(?:\(?([a-zA-Z]|[ivxLCDM]+)\)[\.\)]?|([a-zA-Z])\.)\s+(.*)$/;

    // Helper: BARE letter sub-label ("A Explain why Java …", "B Implement Java …")
    // — SPPU/autonomous-college tables print the sub label as a lone capital in
    // its own column with no dot, paren or bracket. Tesseract preserves that
    // layout as a single space after the letter. A lone capital followed by
    // whitespace and real question text is a sub-question ONLY when a top-level
    // main is open (never at document start, never inside a lettered item) and
    // the remainder is unmistakably a question (task-verb start or trailing
    // bracketed marks) — prose, instructions and option lists never qualify.
    const bareLetterSubRegex = /^([A-D])\s+(\S.*)$/;
    const BARE_SUB_HAS_MARKS_RE = /(?:\[|\()\s*\d+(?:\.\d+)?\s*(?:marks?|mark|m|pts)?\s*[)\]]/i;
    const BARE_SUB_STARTS_VERB_RE = /^(?:What|Which|Who|Whose|When|Where|Why|How|Define|State|Explain|Describe|Give|Name|List|Identify|Write|Calculate|Derive|Differentiate|Convert|Complete|Fill|Match|Tick|Choose|Select|Arrange|Rewrite|Change|Apply|Discuss|Analyze|Analyse|Summarize|Summarise|Evaluate|Compare|Contrast|Justify|Illustrate|Demonstrate|Outline|Distinguish|Elaborate|Examine|Prove|Show|Determine|Solve|Draw|Design|Develop|Formulate|Interpret|Classify|Comment|Observe|Mention)\b/i;

    // Helper: Match explicit MCQ option format (e.g. "A. Oxygen", "(A) Carbon dioxide")
    const optionRegex = /^(?:(?:\(?([A-Da-d])\)[\.\)]?)|(?:([A-Da-d])[\.\)]))\s+(.+)$/;

    // ROMAN-NUMERAL MCQ OPTIONS: papers write choices as "i) MS Paint",
    // "ii) MS Word", "(iii) MS Excel", "iv) …" after a lettered item inside a
    // "Choose the correct …" question. Those lines are OPTIONS of the open
    // MCQ item — never new sub-questions. Roman labels under NON-MCQ stems
    // (grammar (i)(ii) lists, passage parts, numbering lists) keep their old
    // behaviour and stay untouched.
    const romanTokenRe = /^[ivxlcdm]{1,7}$/i;
    // A stem that asks for "choose/tick/select … the correct" or says
    // multiple-choice → everything under it that looks like an option is one.
    const mcqInstructionRe = /(?:choose|tick|select|pick|mark|encircle|circle)\b[^.\n]{0,80}?(?:the\s+)?correct\b|multiple\s*choice|\bmcq\b/i;
    const looksMcq = (t) => mcqInstructionRe.test(String(t || ''));

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // 1. Check for Section Header
      const sectionMatch = line.match(sectionRegex);
      if (sectionMatch) {
        currentSection = sectionMatch[1].toUpperCase();
        detectedSections.add(currentSection);
        continue;
      }

      // Skip common non-question lines
      if (/^(?:General Instructions|Total Questions|Time Allowed|Maximum Marks|Max Marks|Note:|Instructions:)/i.test(line)) {
        continue;
      }

      // 1b. Horizontal option row of an open numbered item:
      //     "(a) Meadow (b) Market (c) Classroom" — split the WHOLE row so every
      //     option is recovered (the single-option regex below would capture
      //     only "A. Meadow (b) Market (c) Classroom" as one mangled option and
      //     glue the next item into it).
      if (currentSub && currentQuestion) {
        const rowOptions = splitHorizontalOptionLine(line);
        if (rowOptions) {
          currentSub.options = rowOptions;
          currentSub.isMcq = true;
          continue;
        }
      }

      // 2. Check for Sub-question Pattern (e.g. "(a) What is ... [2]", "(b) Explain ... [3]")
      // BARE letter sub-label branch — runs FIRST so a bare "A " line opens a
      // sub even while a previous sub (or sub state) is still open. The inline
      // "A " right after "Q.1." is split off at the main-question open site
      // below (stem-glued sub-label recovery). Here only LINE-START bare
      // labels are recovered. A main is ALWAYS open by the time a bare label
      // appears in this paper family ("Q.2" precedes its image block), so the
      // simple parent==null gate suffices; prose can never match because the
      // single capital must be followed by a task-verb or marks-bearing stem.
      const subMatch = line.match(subQuestionStartRegex);
      // A bare label may open a sub while a TOP-LEVEL MAIN is open OR while a
      // DIRECT lettered sub of that main is open (its SIBLINGS are bare-style
      // too: "A Explain …\nB Implement …"). Deeper nesting (sub-of-sub) never
      // qualifies — those papers use parenthesised/roman styles, not bare caps.
      const bareSubOpenContext = currentQuestion
        && (currentQuestion.parentQuestionNumber == null
            || (/^\w+\([a-z]\)$/i.test(currentQuestion.questionNumber)
                && !String(currentQuestion.parentQuestionNumber || '').includes('(')));
      const bareSubMatch = (!subMatch && bareSubOpenContext)
        ? line.match(bareLetterSubRegex)
        : null;
      if (bareSubMatch
          && (BARE_SUB_HAS_MARKS_RE.test(bareSubMatch[2]) || BARE_SUB_STARTS_VERB_RE.test(bareSubMatch[2]))) {
        const subLetter = bareSubMatch[1].toLowerCase();
        const subText = bareSubMatch[2].trim();
        // Wrap into the same currentQuestion/currentSub shape the standard
        // sub-question branch below builds, byte-for-byte.
        const parentBase = currentParentNumber || currentQuestion.questionNumber.replace(/\(.*\)/, '');
        flushQuestion();
        const qNum = `${parentBase}(${subLetter})`;
        currentQuestion = {
          questionNumber: qNum,
          parentQuestionNumber: parentBase,
          section: currentSection,
          text: subText,
          options: [],
          marks: null,
          type: 'UNKNOWN',
          isMcqContext: looksMcq(subText),
        };
        currentParentNumber = parentBase;
        currentSub = null;
        currentGroupLabel = null;
        continue;
      }
      if (subMatch && currentQuestion) {
        const subLetter = (subMatch[1] || subMatch[2]).toLowerCase();
        const subText = subMatch[3] ? subMatch[3].trim() : '';

        // Check if this is a subquestion rather than an MCQ option:
        // A subquestion typically contains question verbs, has marks, or follows a parent question that had a subquestion (a)
        const hasMarks =
          /(?:\[|\()\s*\d+\s*(?:marks?|mark|m|pts)?\s*(?:\]|\))\s*$/i.test(subText) ||
          // trailing "Mark = 5" / "Marks: 3" (no brackets) — a common autonomous-
          // college style; the marks phrase may sit anywhere near the line end.
          /\bmarks?\s*[=:]\s*\d+(?:\.\d+)?\s*$/i.test(subText);
        // A lettered line that opens with a question word or task verb is a NEW
        // sub-question ("Which …?" is the most common MCQ stem and was missing).
        const startsWithVerb = /^(?:What|Which|Who|Whose|When|Where|Why|How|Define|State|Explain|Describe|Give|Name|List|Identify|Write|Calculate|Derive|Differentiate|Convert|Complete|Fill|Match|Tick|Choose|Select|Arrange|Rewrite|Change|Apply|Discuss|Analyze|Analyse|Summarize|Summarise|Evaluate|Compare|Contrast|Justify|Illustrate|Demonstrate|Outline|Distinguish|Elaborate|Examine|Prove|Show|Determine|Solve|Draw|Design|Develop|Formulate|Interpret|Classify|Comment)\b/i.test(subText);
        const parentHasSub = currentQuestion.questionNumber.includes('(');
        const subToken = String(subMatch[1] || subMatch[2] || '');
        const isRoman = romanTokenRe.test(subToken);
        const isAlphaItem = !isRoman && /^[a-z]$/i.test(subToken);

        // ── LETTERED GROUP HEADER of numbered items ────────────────────────
        // "A. Fill in the blanks:" / "B. Multiple Choice Questions:" — a short
        // colon-terminated label with no marks, no question wording and no
        // blanks is a category header for the NUMBERED items that follow, not
        // a sub-question and not an MCQ option. Main-level context only, so
        // lettered sub-questions keep their legacy behaviour untouched.
        if (!isRoman && currentQuestion.parentQuestionNumber == null
            && !hasMarks && !subText.includes('?') && !/_{2,}/.test(subText)
            && /:$/.test(subText) && subText.split(/\s+/).length <= 6) {
          currentGroupLabel = subText;
          currentSub = null;
          continue;
        }

        // ── ROMAN-NUMERAL OPTION of the OPEN MCQ ITEM ────────────────────────
        // Only inside a lettered item (parent != null) that belongs to an MCQ
        // question, and only when the line is not itself a question/marked
        // item. E.g. after "(a) Which …?" a run of "i) … ii) … iii) …" lines
        // becomes the option list of (a), and of every following item.
        if (isRoman && !hasMarks && !startsWithVerb
            && currentQuestion.parentQuestionNumber != null
            && currentQuestion.isMcqContext === true) {
          if (!Array.isArray(currentQuestion.options)) currentQuestion.options = [];
          currentQuestion.options.push(`${subToken.toLowerCase()}. ${subText}`);
          currentQuestion.type = 'MCQ';
          continue;
        }

        // ── NEW SUB-QUESTION? ────────────────────────────────────────────────
        // A fresh lettered item (a)(b)(c) may legitimately follow an item that
        // already collected its own options (so the old options.length === 0
        // gate must not swallow the next item), but a plain continuation of a
        // non-question line must still merge into the open question.
        // STATEMENT-LIST STEMS: under a True/False, fill-in-the-blank or
        // plurals/opposites instruction, lettered lines are ITEMS of the
        // question — never MCQ options. Recovering them here preserves the
        // observed per-item count, an atomic fact downstream cannot recover
        // once the lines are glued into an option list. MCQ instruction stems
        // ("choose/tick … the correct") are excluded so their option lists
        // keep the legacy behaviour untouched.
        const stemSaysStatements =
          !looksMcq(currentQuestion.text) &&
          /(?:true\s*(?:or|\/)\s*false|state\s+whether|fill\s+in\s+the\s+(?:blanks?|missing)|complete\s+the\s+(?:following\s+)?(?:sentences?|words?|table|passage)|(?:write|give)\s+(?:the\s+)?(?:plurals?|opposites?|synonyms?|antonyms?))/i.test(currentQuestion.text);
        const wantsNewSub =
          hasMarks || startsWithVerb || stemSaysStatements
          || (parentHasSub && (isAlphaItem || currentQuestion.options.length === 0));

        // Open the sub when the main already has a stem, OR when the line itself
        // is unmistakably a sub-question (opens with a task verb, or carries its
        // own marks) — the latter covers a stem-less main like "Q.1" whose parts
        // sit on the following lines. Without this, "A. Define … Mark = 5" under
        // an empty "Q.1" is misread as an MCQ option.
        if (wantsNewSub && (currentQuestion.text.trim() || startsWithVerb || hasMarks)) {
          // Capture parent-derived values BEFORE flushing (flush clears the
          // open question — but the new sub still hangs off the same parent).
          const parentBase = currentParentNumber || currentQuestion.questionNumber.replace(/\(.*\)/, '');
          const parentMcq = currentQuestion.isMcqContext === true
            || looksMcq(currentQuestion.text)
            || looksMcq(subText);
          flushQuestion();

          const baseParent = parentBase;
          const qNum = `${baseParent}(${subLetter})`;
          // MCQ context travels from the parent ("Choose the correct option:")
          // down to its lettered items so each item can collect its own roman
          // option list later.
          const mcqContext = parentMcq;
          currentQuestion = {
            questionNumber: qNum,
            parentQuestionNumber: baseParent,
            section: currentSection,
            text: subText,
            options: [],
            marks: null,
            type: 'UNKNOWN',
            isMcqContext: mcqContext
          };
          currentParentNumber = baseParent;
          currentSub = null;
          currentGroupLabel = null;
          continue;
        }
      }

      // 3. Check for MCQ Option line (e.g. "A. Oxygen", "B. Carbon dioxide")
      const optionMatch = line.match(optionRegex);
      if (optionMatch && currentQuestion) {
        const optLetter = (optionMatch[1] || optionMatch[2]).toUpperCase();
        const optText = optionMatch[3].trim();
        if (['A', 'B', 'C', 'D'].includes(optLetter)) {
          // Options of an open numbered item belong to that item.
          if (currentSub) {
            currentSub.options.push(`${optLetter}. ${optText}`);
            currentSub.isMcq = true;
            continue;
          }
          if (!currentQuestion.options) currentQuestion.options = [];
          currentQuestion.options.push(`${optLetter}. ${optText}`);
          currentQuestion.type = 'MCQ';
          continue;
        }
      }

      // 4. Check for Main Question Start (e.g. "Q1.", "1.", "Q5. (a) What is ...")
      const mainMatch = line.match(mainQuestionRegex);
      if (mainMatch) {
        const isQForm = !!mainMatch[1];
        const num = mainMatch[2] || mainMatch[4];
        let initialText = ((isQForm ? mainMatch[3] : mainMatch[5]) || '').trim();

        // ── NUMBERED ITEM of the open main ──────────────────────────────────
        // A bare-numbered line ("1. …") under an open Q-form main is that
        // main's numbered item (English Unit 3 style: "Q1. … (4 Marks)" then
        // "1. … 2. … 3. … 4. ..."). Promoting it to a MAIN steals the later
        // real Q2/Q3 labels and collapses the paper structure. Lettered-sub
        // context keeps the legacy continuation behaviour (the dangling "5"
        // of a wrapped "Mark =" line must glue to its stem).
        if (!isQForm && currentQuestion && currentQuestion.parentQuestionNumber == null) {
          if (!Array.isArray(currentQuestion.subParts)) currentQuestion.subParts = [];
          currentSub = { text: initialText, options: [], marks: null, group: currentGroupLabel };
          currentQuestion.subParts.push(currentSub);
          continue;
        }

        const isLikelyQuestion =
          parseInt(num, 10) < 200 &&
          !/^(?:marks?|points?|pages?|minutes?|hours?|step)/i.test(initialText) &&
          // An empty inline stem is only a question in the Q-form ("Q.1" with
          // its parts on the next lines); a bare "5" with nothing after is not.
          (initialText.length > 0 || isQForm);

        if (isLikelyQuestion) {
          flushQuestion();

          // Check if initial text starts directly with a subquestion like "(a) What is..."
          const inlineSubMatch = initialText.match(/^\(([a-zA-Z]|[ivxLCDM]+)\)\s+(.*)$/);
          let qNum = `Q${num}`;
          let parentNum = null;

          if (inlineSubMatch) {
            const subLetter = inlineSubMatch[1].toLowerCase();
            initialText = inlineSubMatch[2].trim();
            qNum = `Q${num}(${subLetter})`;
            parentNum = `Q${num}`;
          }

          currentQuestion = {
            questionNumber: qNum,
            parentQuestionNumber: parentNum,
            section: currentSection,
            text: initialText,
            options: [],
            marks: null,
            type: 'UNKNOWN',
            // Mark MCQ stems so roman-numeral choices below them can be
            // recognised as options instead of new sub-questions.
            isMcqContext: looksMcq(initialText)
          };
          currentParentNumber = `Q${num}`;
          currentSub = null;
          currentGroupLabel = null;

          // STEM-GLUED ITEM RECOVERY: OCR sometimes appends bitmap noise and a
          // mid-line enumerator to the SAME physical line as the main stem
          // ("Q2. Look at the picture … (2 x 1 = 2 marks) e rs , 1. Who is…").
          // Split those off exactly as continuation-line noise is split (4c);
          // every gate in splitInlineNumberedItems still applies.
          const stemRecovery = splitInlineNumberedItems(initialText, initialText, 0);
          if (stemRecovery) {
            currentQuestion.text = stripOcrJunkTail(stemRecovery.lead);
            currentQuestion.subParts = [];
            for (const it of stemRecovery.items) {
              currentSub = { text: it.text, options: [], marks: null, group: currentGroupLabel };
              currentQuestion.subParts.push(currentSub);
            }
          }

          // STEM-GLUED SUB-LABEL RECOVERY: SPPU/autonomous tables print the sub
          // label in its own column, so OCR glues it onto the main stem line:
          // "Q.1. A Explain why Java is…". Split the FIRST bare single capital
          // off the stem when the remainder is unmistakably a sub-question
          // (task-verb start or bracketed marks) — exactly the same gates the
          // line-start bare-label branch above applies, so both styles agree.
          const gluedSubMatch = currentQuestion.text.match(/^([A-D])\s+([A-Z].*)$/);
          if (gluedSubMatch
              && (BARE_SUB_HAS_MARKS_RE.test(gluedSubMatch[2]) || BARE_SUB_STARTS_VERB_RE.test(gluedSubMatch[2]))) {
            currentQuestion.questionNumber = `${qNum}(${gluedSubMatch[1].toLowerCase()})`;
            currentQuestion.parentQuestionNumber = qNum;
            currentQuestion.text = gluedSubMatch[2].trim();
            currentParentNumber = qNum;
          }

          extractHorizontalOptions(currentQuestion);
          continue;
        }
      }

      // 4c. OCR mid-line numbered-item recovery (scoped — see the helper's
      // block comment for every gate). Only top-level mains participate;
      // lettered-sub and MCQ-option contexts never reach here (they `continue`
      // in the branches above).
      if (currentQuestion && currentQuestion.parentQuestionNumber == null) {
        const recovered = splitInlineNumberedItems(
          line,
          currentQuestion.text,
          Array.isArray(currentQuestion.subParts) ? currentQuestion.subParts.length : 0
        );
        if (recovered) {
          const leadText = recovered.lead.trim();
          // Junk before the enumerator: drop it when it would glue onto the
          // STEM (where it can break the trailing-marks label) — when an item
          // is open it glues there instead, preserving wrapped-line text.
          if (leadText && !(isOcrJunkFragment(leadText) && !currentSub)) {
            if (currentSub) currentSub.text = currentSub.text ? `${currentSub.text} ${leadText}` : leadText;
            else if (currentQuestion.text) currentQuestion.text = `${currentQuestion.text} ${leadText}`;
            else currentQuestion.text = leadText;
            extractHorizontalOptions(currentQuestion);
          }
          if (!Array.isArray(currentQuestion.subParts)) currentQuestion.subParts = [];
          for (const it of recovered.items) {
            currentSub = { text: it.text, options: [], marks: null, group: currentGroupLabel };
            currentQuestion.subParts.push(currentSub);
          }
          continue;
        }
      }

      // 4b. A bare marks-only line ALWAYS gets recorded in page order (for
      // the orphan-repair pass below), regardless of what happens next.
      const bareMarksMatch = line.match(BARE_MARKS_LINE_RE);
      if (bareMarksMatch) orphanMarks.push(parseFloat(bareMarksMatch[1]));

      // 5. Continuation text for current question, numbered item or option.
      // A bare marks-only line never attaches to an open SUB-ITEM's text — a
      // subquestion has no "(N marks)" trailing convention of its own here,
      // and letting it glue on (as the OCR-scrambled case does) fabricates a
      // per-item mark value the paper never printed for that item. It stays
      // recorded in orphanMarks above either way.
      if (currentQuestion && currentSub) {
        if (!bareMarksMatch) {
          currentSub.text = currentSub.text ? `${currentSub.text} ${line}` : line;
        }
      } else if (currentQuestion) {
        if (currentQuestion.options && currentQuestion.options.length > 0) {
          const lastIdx = currentQuestion.options.length - 1;
          currentQuestion.options[lastIdx] += ` ${line}`;
        } else {
          if (currentQuestion.text) {
            currentQuestion.text += ` ${line}`;
          } else {
            currentQuestion.text = line;
          }
          extractHorizontalOptions(currentQuestion);
        }
      }
    }

    // Push the last open question
    flushQuestion();

    // ORPHAN MARKS REPAIR: when OCR's reading order clusters "(N marks)"
    // labels away from their own question heading, they land as raw
    // continuation noise on whatever was open at the time (usually the last
    // question's last item) — so EVERY main question before that ends up
    // with marks: null, and the unlucky item that absorbed them carries
    // leftover "(N marks)" text. Bounded, deterministic repair: only fires
    // when the number of bare marks-only lines seen on the page EXACTLY
    // equals the number of main (top-level) questions still missing marks —
    // in that case they are assigned back POSITIONALLY, in the same order
    // both appeared. Any mismatch leaves marks null; nothing is ever guessed.
    const mainQuestionsMissingMarks = rawQuestions.filter(
      (q) => q.parentQuestionNumber == null && q.marks == null
    );
    if (orphanMarks.length > 0 && orphanMarks.length === mainQuestionsMissingMarks.length) {
      mainQuestionsMissingMarks.forEach((q, i) => { q.marks = orphanMarks[i]; });
    }
    // MID-TEXT MARKS LABEL HARVEST: finalizeQuestion only reads marks from the
    // END of the stem, so a label printed mid-text — "…answer the questions
    // given below: (4 Marks)" followed by an image's word salad — was missed,
    // then the stray-label strip below deleted the label, losing the only
    // printed marks evidence (IMAGE_BASED mains hit this hardest: their stem
    // legitimately continues after the image words). Deterministic and bounded:
    // harvest ONLY from a record with no marks yet, ONLY the FIRST bracketed
    // marks label — unit-suffixed "(N marks)" OR a BARE bracketed number
    // "[05]" (the "figures to the right indicate full marks" column style,
    // where OCR appends the CO/BL table columns right after the bracket) — and
    // strip just that one occurrence. Never guesses — no label, no harvest;
    // marks stay null and the blueprint warns.
    const FIRST_MARKS_LABEL_RE = /[\[\(]\s*(\d+(?:\.\d+)?)\s*(?:marks?|mark|m|pts)?\s*[\]\)]/i;
    for (const q of rawQuestions) {
      if (q.marks != null || !q.text) continue;
      const m = q.text.match(FIRST_MARKS_LABEL_RE);
      if (!m) continue;
      const parsed = parseFloat(m[1]);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 20) continue;
      q.marks = parsed;
      const idx = q.text.indexOf(m[0]);
      q.text = (q.text.slice(0, idx) + ' ' + q.text.slice(idx + m[0].length)).replace(/\s{2,}/g, ' ').trim();
    }

    // Regardless of whether the repair fired, strip any leftover bare
    // "(N marks)" noise that got glued into a question/item's text — it is
    // never legitimate content, only an OCR reading-order artifact.
    const STRAY_MARKS_RE = /\(\s*\d+(?:\.\d+)?\s*(?:marks?|mark|m|pts)\s*\)/gi;
    for (const q of rawQuestions) {
      if (q.text) q.text = q.text.replace(STRAY_MARKS_RE, '').replace(/\s{2,}/g, ' ').trim();
    }

    // Post-processing & Deduplication
    const validatedQuestions = [];
    const seenTexts = new Set();

    for (const q of rawQuestions) {
      const normalizedStem = q.text.toLowerCase().replace(/[^a-z0-9]/g, '');

      if (!q.text || q.text.trim().length < 5) continue;
      if (seenTexts.has(normalizedStem)) continue;
      seenTexts.add(normalizedStem);

      validatedQuestions.push(q);
    }

    if (validatedQuestions.length === 0 && text.trim().length > 0) {
      warnings.push('Could not detect standard question numbering patterns (e.g. Q1., 1.). Check document formatting.');
    }

    return {
      questions: validatedQuestions,
      count: validatedQuestions.length,
      sections: Array.from(detectedSections),
      warnings
    };
  }
};

// Module-level MCQ-instruction probe (same regex as the in-extract looksMcq)
// so finalizeQuestion can classify numbered items without closure capture.
const MCQ_INSTRUCTION_RE = /(?:choose|tick|select|pick|mark|encircle|circle)\b[^.\n]{0,80}?(?:the\s+)?correct\b|multiple\s*choice|\bmcq\b/i;

// ── OCR mid-line numbered-item recovery (scoped) ────────────────────────────
// Tesseract sometimes glues bitmap noise and a sub-question enumerator onto
// ONE physical line after an image-based main's stem:
//   "…(2 x 1 = 2 marks) e rs , 1. Who is teaching Helen in the picture?"
// The line-start-only item rule then never sees the "1.", the whole line is
// glued to the stem as continuation, the question loses a sub-item, and the
// marks-expression fallback downstream assigns the whole total to the single
// surviving item. Recovery SPLITS such a line, but ONLY when every gate holds:
//   1. parent-anchored  — a top-level main question is open (call sites);
//   2. junk-prefix      — the enumerator must NOT sit at line start (that is
//                         the existing bare-numbered path's job, unchanged);
//   3. instruction stem — the parent stem opens with a task verb ("Look at…",
//                         "Answer the following…"); a prose parent never
//                         qualifies;
//   4. declared count   — when a "N x M = T" expression is present (parent
//                         text or this line's junk prefix) the enumerator
//                         must not exceed the declared count and the parent
//                         must still be short of items; with NO expression
//                         anywhere the item must be STRONGLY question-shaped
//                         (task/question verb AND ('?' or a blank));
//   5. item shape       — the recovered text starts with a question/task
//                         verb, or ends with '?', or carries a blank.
// Any doubt aborts the WHOLE recovery (the line stays ordinary continuation
// text — the pre-fix behaviour). Nothing is ever invented: recovery only
// separates text the OCR already produced, never fabricates a missing item.
// Prose enumerators ("Helen was 1. very young …") fail the stem and/or shape
// gates and stay continuation text, exactly as before.
const INLINE_ENUM_TOKEN_RE = /[\s(\[](\d{1,2})\s*[.,):]/g;
const TASK_VERB_RE = /^(?:What|Which|Who|Whom|Whose|When|Where|Why|How|Define|State|Explain|Describe|Give|Name|List|Identify|Write|Calculate|Derive|Differentiate|Convert|Complete|Fill|Match|Tick|Choose|Select|Arrange|Rewrite|Change|Apply|Discuss|Analyze|Analyse|Summarize|Summarise|Evaluate|Compare|Contrast|Justify|Illustrate|Demonstrate|Outline|Distinguish|Elaborate|Examine|Prove|Show|Determine|Solve|Draw|Design|Develop|Formulate|Interpret|Classify|Comment|Mention)\b/i;
const INSTRUCTION_STEM_RE = /^\s*(?:look|answer|choose|fill|complete|write|read|observe|study|examine|see|pick|tick|select|match|state|name|give|solve|attempt|do|identify|define|explain|describe)\b/i;
// Words that mark a text fragment as real PROSE (a wrapped sentence tail),
// not bitmap junk. Any fragment containing one of these is never dropped.
const COMMON_WORD_RE = /\b(?:the|and|of|to|in|is|was|are|for|on|with|his|her|its|their|from|by|at|as|be|been|a|an|not|but|you|your|he|she|they|we)\b/i;

/**
 * True when a short text fragment is OCR/bitmap JUNK ("e rs ,") rather than
 * real prose: no question verb, no '?' or blank, none of the common English
 * function words, and either tiny or a run of ≤3-letter lowercase fragments.
 * Used ONLY to decide whether junk glued ahead of a recovered enumerator may
 * be discarded — real wrapped-line tails always survive.
 */
function isOcrJunkFragment(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (TASK_VERB_RE.test(t) || /\?|_{2,}/.test(t) || COMMON_WORD_RE.test(t)) return false;
  // Any single alphabetic token of 5+ letters is a real word — never junk.
  if (/(?:^|\s)[A-Za-z]{5,}(?:\s|$)/.test(t)) return false;
  if (t.length <= 10) return true;
  return /^(?:[a-z]{1,3}\s*){1,4}[.,;:]*$/.test(t);
}

/**
 * Strip a trailing OCR junk TAIL from a stem that carries a marks expression
 * ("…(2 x 1 = 2 marks) e rs ," → "…(2 x 1 = 2 marks)"). Bitmap noise lands
 * between the printed marks label and the first sub-item; glued there it
 * breaks the trailing-marks regex exactly like OCR reading-order noise does.
 * The tail is only removed when (a) the stem contains a "N x M = T"
 * expression, (b) the tail is junk by isOcrJunkFragment, and (c) the tail is
 * short — real sentence words (any common word, question verb, '?' or a
 * blank) are always kept.
 */
function stripOcrJunkTail(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/\s+([A-Za-z]{1,3}(?:\s+[A-Za-z]{1,3}){0,3})\s*[.,;:]*$/);
  if (m && m[1].length <= 12 && marksExpressionOperands(t) && isOcrJunkFragment(m[1])) {
    t = t.slice(0, m.index).trim();
  }
  return t;
}

/**
 * Parse the two operands of an exam marks expression ("2 x 1 = 2", "1x3=3",
 * "3X1=3") — orientation-agnostic. Papers write both "1x3=3" (1 mark × 3
 * items) and "3X1=3" (3 items × 1 mark); which operand is the item count is
 * disambiguated downstream against ACTUAL extracted items, never here.
 * @param {string} text - any text that may contain the expression
 * @returns {{ a: number, b: number } | null}
 */
function marksExpressionOperands(text) {
  const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+)\s*=\s*\d+/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > 0 && b > 0 ? { a, b } : null;
}

/**
 * @param {string} text - candidate item text
 * @param {boolean} strong - true → require verb-start AND ('?' or blank);
 *   false → verb-start OR '?' OR blank suffices (used when a declared item
 *   count already constrains the split).
 */
function looksQuestionShaped(text, strong) {
  const t = String(text || '').trim();
  if (!t) return false;
  const verbStart = TASK_VERB_RE.test(t);
  const endsQuestion = /\?\s*$/.test(t);
  const hasBlank = /_{2,}/.test(t);
  return strong ? (verbStart && (endsQuestion || hasBlank)) : (verbStart || endsQuestion || hasBlank);
}

/**
 * Split ONE physical OCR line into [junk-prefix, numbered items] when it
 * carries a mid-line numbered sub-question after image/OCR noise (gates in
 * the block comment above). Returns null whenever any gate fails — the line
 * then stays ordinary continuation text, byte-for-byte as before.
 * @param {string} line - the raw (already trimmed) line to inspect
 * @param {string} instructionProbe - text whose START decides gate 3 (the
 *   open parent's stem, or the same line when the stem itself is being split)
 * @param {number} existingItems - sub-parts the parent already has
 * @returns {{ lead: string, items: Array<{num:number, text:string}> } | null}
 */
function splitInlineNumberedItems(line, instructionProbe, existingItems) {
  const s = String(line || '').trim();
  if (!s) return null;
  if (!INSTRUCTION_STEM_RE.test(String(instructionProbe || ''))) return null;

  const tokens = [...s.matchAll(INLINE_ENUM_TOKEN_RE)];
  // The FIRST enumerator must sit after junk: a line-START enumerator is the
  // existing bare-numbered path's territory (behaviour unchanged).
  const firstIdx = tokens.findIndex((t) => t.index > 0);
  if (firstIdx === -1) return null;
  const usable = tokens.slice(firstIdx);
  const lead = s.slice(0, usable[0].index).trim();

  const items = [];
  for (let k = 0; k < usable.length; k++) {
    const tok = usable[k];
    const num = Number(tok[1]);
    const start = tok.index + tok[0].length;
    const end = k + 1 < usable.length ? usable[k + 1].index : s.length;
    const text = s.slice(start, end).trim();
    if (num < 1 || !text) return null;
    const operands = marksExpressionOperands(`${instructionProbe} ${lead}`);
    if (operands) {
      const declared = Math.max(operands.a, operands.b);
      if (num > declared || existingItems + items.length >= declared) return null;
      if (!looksQuestionShaped(text, false)) return null;
    } else if (!looksQuestionShaped(text, true)) {
      return null;
    }
    items.push({ num, text });
  }
  return items.length > 0 ? { lead, items } : null;
}

/**
 * Split an MCQ option ROW into its options: "(a) Meadow (b) Market (c) Class…"
 * → ["A. Meadow", "B. Market", "C. Classroom"]. Requires ≥ 2 lettered tokens
 * (a single letter must stay a sub-question/continuation) and tolerates
 * "a)"/"A."/"(A)" styles. Returns null when the line is not an option row.
 */
function splitHorizontalOptionLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  const matches = [...s.matchAll(/(?:\(?)([A-Da-d])(?:\)|\.)\s*([^()]*?)(?=(?:\(?[A-Da-d][\).])|$)/g)];
  if (matches.length < 2) return null;
  const options = matches
    .map((m) => `${m[1].toUpperCase()}. ${m[2].trim()}`)
    .filter((o) => o.length > 3);
  if (options.length !== matches.length || options.length < 2) return null;
  return options;
}

/**
 * Finalize question attributes: clean text, parse marks, deduce type, map page.
 * When a Q-form main recovered NUMBERED items ("1. … 2. …") but no real
 * lettered sub-questions, each numbered item is restored as a standalone
 * question record ("Q1(1)", "Q1(2)" …) so blueprint grouping keeps the
 * per-item structure instead of gluing everything into the stem. Mixed
 * numbered-item groups (fill-blank + MCQ items under one main) classify each
 * restored record from its own text; a uniform MCQ group keeps the whole
 * question as one MCQ record with per-item option counts.
 *
 * @returns {Object|Array<Object>} a single record, or an array when numbered
 *   items were restored separately.
 */
function finalizeQuestion(question, pages = []) {
  // NUMBERED-ITEM RESTORATION: a Q-form main that recovered numbered items
  // ("1. … 2. …" under "Q1. … (4 Marks)") emits each item as its own record
  // ("Q1(1)", "Q1(2)" …) and nothing else — the main's stem is only an
  // instruction. The group header / main stem decides MCQ context for items
  // that did not recover their own option row.
  if (Array.isArray(question.subParts) && question.subParts.length > 0) {
    const mcqGroup = MCQ_INSTRUCTION_RE.test(String(question.text || ''))
      || question.subParts.some((sp) => String(sp?.group || '').length > 0 && MCQ_INSTRUCTION_RE.test(sp.group));
    const itemRecords = question.subParts.map((sp, idx) => {
      const rec = {
        questionNumber: `${question.questionNumber}(${idx + 1})`,
        parentQuestionNumber: question.questionNumber,
        section: question.section,
        type: 'UNKNOWN',
        text: String(sp.text || '').trim(),
        options: Array.isArray(sp.options) ? sp.options : [],
        marks: null,
        __mcqGroup: mcqGroup,
        metadata: {}
      };
      return finalizeQuestion(rec, pages);
    });
    // Emit the MAIN record too (stem + its own trailing marks, e.g. "(4 Marks)")
    // so blueprint grouping keeps the real instruction and total instead of
    // synthesising a marks-less parent. Stem-less mains keep the legacy
    // synthesise-on-group behaviour.
    if (String(question.text || '').trim()) {
      const mainRec = {
        questionNumber: question.questionNumber,
        parentQuestionNumber: question.parentQuestionNumber || null,
        section: question.section,
        type: 'UNKNOWN',
        text: String(question.text || '').trim(),
        options: [],
        marks: question.marks ?? null,
        metadata: {}
      };
      return [finalizeQuestion(mainRec, pages), ...itemRecords];
    }
    return itemRecords;
  }
  let text = question.text.trim();
  let marks = question.marks;

  // 1. Extract trailing marks. Bracketed ("[5]", "(5 marks)", or the bare
  //    bracketed number "[05]" an SPPU-style marks column prints, where OCR
  //    often appends the CO/BL table columns right after it), bare ("… 5 marks"),
  //    or the bracket-less "Mark = 5" / "Marks: 3" style used by many autonomous
  //    colleges. The marks phrase is stripped from the stem either way.
  const marksMatch =
    text.match(/(?:\[|\()\s*(\d+(?:\.\d+)?)\s*(?:marks?|mark|m|pts)?\s*(?:\]|\))\s*$/i) ||
    text.match(/[\s([]\s*(\d+(?:\.\d+)?)\s*(?:marks?|mark|pts)\s*[)\]]?\s*$/i) ||
    text.match(/\bmarks?\s*[=:]\s*(\d+(?:\.\d+)?)\s*$/i);
  // BARE BRACKETED MARKS anywhere in the stem ("… [05] COl BL2" / "… [05]"):
  // when the trailing-label regexes above all miss — the marks column sits
  // mid-line because OCR glued the CO/BL table cells onto the same line — the
  // FIRST bare bracketed integer is the printed marks figure. Guarded so real
  // bracketed content can never be misread as marks: the number must be small
  // (≤ 20), the bracket must carry NO words inside, and the token must not be
  // part of a "N x M = T" expression or a preceding "(N marks)" label (the
  // unit-suffixed label always wins). Marks are read, never stripped here —
  // finalizeQuestion only removes END-of-stem labels; mid-stem cleanup stays
  // with the harvest pass.
  if (marks == null) {
    const bareMatch = text.match(/\s[\[(]\s*(\d{1,2})\s*[\])](?=\s|$)/);
    if (bareMatch
        && !/[=xX×*]\s*$/.test(text.slice(0, bareMatch.index))
        && !/\((?:[^)]*)\)\s*$/.test(text.slice(0, bareMatch.index + 1))) {
      const parsedBare = parseFloat(bareMatch[1]);
      if (Number.isFinite(parsedBare) && parsedBare > 0 && parsedBare <= 20) {
        marks = parsedBare;
      }
    }
  }
  if (marksMatch) {
    // When the trailing number is the RIGHT OPERAND of a printed marks
    // expression ("…(2 x 1 = 2 marks)", "…(3 x 1 =3 marks)"), it is part of
    // that expression — not a standalone whole-question label. Stripping it
    // here used to truncate the stem to "…(2 x 1 =" (spacing-dependent: only
    // when a space precedes the total), destroying the "N x M = T" string the
    // blueprint's per-item marks fallback needs to propagate marks to every
    // sub-item. Leave expression operands in place; the blueprint keeps the
    // expression verbatim and parses the numbers itself.
    const isExpressionOperand = /[=xX×*]\s*$/.test(text.slice(0, marksMatch.index));
    const parsedMarks = parseFloat(marksMatch[1]);
    if (!isExpressionOperand && !isNaN(parsedMarks) && parsedMarks > 0 && parsedMarks <= 20) {
      marks = parsedMarks;
      text = text.substring(0, marksMatch.index).trim().replace(/[.\s,–-]+$/, '').trim();
    }
  }

  text = text.replace(/[\s\t\n]+/g, ' ').trim();

  // 2. Classify Question Type. Numbered-item records classify from their own
  // text first ("2. Nasruddin claimed that he was good at ____" is a fill-blank
  // even though its parent main also said "choose the correct answer"), and a
  // MCQ group instruction counts as MCQ context for its items.
  let type = question.type || 'UNKNOWN';
  if (question.options && question.options.length >= 2) {
    type = 'MCQ';
  } else if (question.__mcqGroup && /\?\s*$/.test(text)) {
    // Item of a "choose the correct answer" group: only a question-form item
    // is an (option list lost to layout) MCQ — a blank sentence under the same
    // header is a fill item ("A. Fill in the blanks:" / "B. MCQ:" mixed slot).
    type = 'MCQ';
  } else if (/^(?:State whether True or False|True or False|Write True or False)/i.test(text) || /\b\(True\/False\)/i.test(text)) {
    type = 'TRUE_FALSE';
  } else if (/\b(?:fill in the blanks?|fill in the missing)\b/i.test(text) || /_{3,}/.test(text)) {
    type = 'FILL_IN_THE_BLANK';
  } else if (marks && marks >= 4) {
    type = 'LONG_ANSWER';
  } else if (marks && marks <= 3) {
    type = 'SHORT_ANSWER';
  } else if (/^(?:What is|Define|State|Name|Give|Identify|Why|How|Explain|Differentiate|Calculate|Derive|Describe)\b/i.test(text)) {
    type = 'SHORT_ANSWER';
  } else {
    type = 'SHORT_ANSWER';
  }

  // 3. Map to Source Page if page info is available
  let pageNumber = null;
  if (pages && pages.length > 0) {
    const searchSnippet = text.substring(0, 30).toLowerCase();
    for (const page of pages) {
      if (page.text && page.text.toLowerCase().includes(searchSnippet)) {
        pageNumber = page.pageNumber;
        break;
      }
    }
  }

  return {
    questionNumber: question.questionNumber,
    parentQuestionNumber: question.parentQuestionNumber || null,
    section: question.section || null,
    type,
    text,
    options: question.options || [],
    marks: marks !== undefined ? marks : null,
    metadata: {
      pageNumber: pageNumber || (pages.length === 1 ? 1 : null)
    }
  };
}

/**
 * Check and extract horizontal MCQ options in question text
 */
function extractHorizontalOptions(question) {
  if (!question || !question.text) return;

  const matches = [...question.text.matchAll(/(?:\(?([A-Da-d])\)|\b([A-Da-d])\.)\s+([^\(\)\n]+?)(?=(?:\(?[A-Da-d]\)|\b[A-Da-d]\.|$))/g)];
  if (matches.length >= 3) {
    const firstOptionIdx = matches[0].index;
    const stem = question.text.substring(0, firstOptionIdx).trim();
    const options = matches.map(m => {
      const letter = (m[1] || m[2]).toUpperCase();
      const optText = m[3].trim();
      return `${letter}. ${optText}`;
    });

    question.text = stem;
    question.options = options;
    question.type = 'MCQ';
  }
}

export default questionExtractor;
