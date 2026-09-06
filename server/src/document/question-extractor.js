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

    // Helper: Match Section Header (e.g. "SECTION A - BIOLOGY", "Section 1", "PART B")
    const sectionRegex = /^(?:SECTION|Section|PART|Part)\s+([A-Za-z0-9]+)(?:\s*[-–—:]\s*(.*))?$/i;

    // Helper: Match Main Question Starts.
    //   Q-form  : "Q1.", "Q1)", "Q.1", "Question 1:", or a BARE "Q.1" / "Q1"
    //             line whose stem is on the following lines (stem may be empty).
    //             groups 1 = "Q" flag, 2 = number, 3 = inline stem
    //   bare    : "1.", "1)", "1 - " — a separator/space after the number is
    //             REQUIRED so stray tokens ("2026-27", page numbers) are ignored.
    //             groups 4 = number, 5 = inline stem
    const mainQuestionRegex =
      /^(?:(Q)(?:uestion)?\.?\s*(\d+)(?:[:.)\-]+\s*|\s+)?(.*)|(\d+)(?:[:.)\-]+\s*|\s+)(.*))$/i;

    // Helper: Match Sub-question (e.g. "(a) ...", "(b) ...", "(i) ...", "a) ...")
    const subQuestionStartRegex = /^(?:\(?([a-zA-Z]|[ivxLCDM]+)\)[\.\)]?|([a-zA-Z])\.)\s+(.*)$/;

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

      // 2. Check for Sub-question Pattern (e.g. "(a) What is ... [2]", "(b) Explain ... [3]")
      const subMatch = line.match(subQuestionStartRegex);
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
        const wantsNewSub =
          hasMarks || startsWithVerb
          || (parentHasSub && (isAlphaItem || currentQuestion.options.length === 0));

        // Open the sub when the main already has a stem, OR when the line itself
        // is unmistakably a sub-question (opens with a task verb, or carries its
        // own marks) — the latter covers a stem-less main like "Q.1" whose parts
        // sit on the following lines. Without this, "A. Define … Mark = 5" under
        // an empty "Q.1" is misread as an MCQ option.
        if (wantsNewSub && (currentQuestion.text.trim() || startsWithVerb || hasMarks)) {
          rawQuestions.push(finalizeQuestion(currentQuestion, pages));

          const baseParent = currentParentNumber || currentQuestion.questionNumber.replace(/\(.*\)/, '');
          const qNum = `${baseParent}(${subLetter})`;
          // MCQ context travels from the parent ("Choose the correct option:")
          // down to its lettered items so each item can collect its own roman
          // option list later.
          const mcqContext =
            currentQuestion.isMcqContext === true
            || looksMcq(currentQuestion.text)
            || looksMcq(subText);
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
          continue;
        }
      }

      // 3. Check for MCQ Option line (e.g. "A. Oxygen", "B. Carbon dioxide")
      const optionMatch = line.match(optionRegex);
      if (optionMatch && currentQuestion) {
        const optLetter = (optionMatch[1] || optionMatch[2]).toUpperCase();
        const optText = optionMatch[3].trim();
        if (['A', 'B', 'C', 'D'].includes(optLetter)) {
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

        const isLikelyQuestion =
          parseInt(num, 10) < 200 &&
          !/^(?:marks?|points?|pages?|minutes?|hours?|step)/i.test(initialText) &&
          // An empty inline stem is only a question in the Q-form ("Q.1" with
          // its parts on the next lines); a bare "5" with nothing after is not.
          (initialText.length > 0 || isQForm);

        if (isLikelyQuestion) {
          if (currentQuestion && currentQuestion.text.trim()) {
            rawQuestions.push(finalizeQuestion(currentQuestion, pages));
          }

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

          extractHorizontalOptions(currentQuestion);
          continue;
        }
      }

      // 5. Continuation text for current question or option
      if (currentQuestion) {
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
    if (currentQuestion && currentQuestion.text.trim()) {
      rawQuestions.push(finalizeQuestion(currentQuestion, pages));
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

/**
 * Finalize question attributes: clean text, parse marks, deduce type, map page
 */
function finalizeQuestion(question, pages = []) {
  let text = question.text.trim();
  let marks = question.marks;

  // 1. Extract trailing marks. Bracketed ("[5]", "(5 marks)"), bare ("… 5 marks"),
  //    or the bracket-less "Mark = 5" / "Marks: 3" style used by many autonomous
  //    colleges. The marks phrase is stripped from the stem either way.
  const marksMatch =
    text.match(/(?:\[|\()\s*(\d+(?:\.\d+)?)\s*(?:marks?|mark|m|pts)?\s*(?:\]|\))\s*$/i) ||
    text.match(/[\s([]\s*(\d+(?:\.\d+)?)\s*(?:marks?|mark|pts)\s*[)\]]?\s*$/i) ||
    text.match(/\bmarks?\s*[=:]\s*(\d+(?:\.\d+)?)\s*$/i);
  if (marksMatch) {
    const parsedMarks = parseFloat(marksMatch[1]);
    if (!isNaN(parsedMarks) && parsedMarks > 0 && parsedMarks <= 20) {
      marks = parsedMarks;
      text = text.substring(0, marksMatch.index).trim().replace(/[.\s,–-]+$/, '').trim();
    }
  }

  text = text.replace(/[\s\t\n]+/g, ' ').trim();

  // 2. Classify Question Type
  let type = question.type || 'UNKNOWN';
  if (question.options && question.options.length >= 2) {
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
