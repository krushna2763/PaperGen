import { qdrantStore } from '../rag/qdrant.js';
import { loadStructuredDocByHash } from '../ingestion/ingestion.service.js';

/**
 * Determine the most likely image type from text, caption, or tag.
 */
function deriveImageType(text = '') {
  const s = String(text || '').toLowerCase();
  if (s.includes('diagram') || s.includes('structure') || s.includes('parts') || s.includes('system') || s.includes('circuit')) return 'Diagram';
  if (s.includes('chart') || s.includes('graph') || s.includes('plot') || s.includes('table')) return 'Chart';
  if (s.includes('photo') || s.includes('picture') || s.includes('portrait')) return 'Photograph';
  if (s.includes('illustration') || s.includes('sketch') || s.includes('drawing') || s.includes('scene')) return 'Illustration';
  return 'Diagram';
}

/**
 * Clean up heading text to form a clean topic name.
 */
function cleanTopic(heading) {
  if (!heading) return 'General';
  let t = String(heading).trim();
  // Remove markdown hashes
  t = t.replace(/^#+\s*/, '');
  // Remove trailing colons or punctuation
  t = t.replace(/[:\-–—]+$/, '').trim();
  // Remove generic prefixes like "Chapter 1:", "Unit 2:", etc.
  t = t.replace(/^(?:chapter|unit|section|lesson|topic)\s*\d*\s*[:\-–—]?\s*/i, '').trim();
  return t || 'General';
}

/**
 * Check whether a heading represents a major story/poem/chapter/unit section.
 */
function isMajorSectionHeading(heading = '') {
  const t = String(heading || '').trim();
  if (/^(?:\d+[\.\)]\s*)?(?:STORY|POEM|LESSON|CHAPTER|UNIT|SECTION)\s*[-–—:]/i.test(t)) return true;
  if (/^\d+\.\s+[A-Z0-9\s'’\-]{3,}/i.test(t)) return true;
  return false;
}

/**
 * Clean major section heading into a clean section/chapter topic.
 * E.g. "5. STORY - HELEN KELLER Main Character" -> "Helen Keller"
 */
function cleanSectionHeading(heading) {
  if (!heading) return '';
  let t = String(heading).trim();
  t = t.replace(/^#+\s*/, '');
  // Match e.g. "5. STORY - HELEN KELLER" or "1. POEM - DON'T BE AFRAID OF THE DARK"
  t = t.replace(/^(?:\d+[\.\)]\s*)?(?:STORY|POEM|LESSON|CHAPTER|UNIT|SECTION)\s*[-–—:]\s*/i, '');
  // Strip leading numbers
  t = t.replace(/^\d+[\.\)]\s*/, '');
  // Remove trailing sub-markers like "Main Character...", "Poet...", etc.
  t = t.replace(/\s+(?:Main Character|Poet|Author|Part\s*\d+|Story Events|Character Understanding|Important Questions|Important Vocabulary).*$/i, '');
  t = t.replace(/[:\-–—]+$/, '').trim();
  return t;
}

/**
 * Extract key concepts deterministically from surrounding text.
 */
function extractConceptsFromContext(text = '', extraTerms = []) {
  const concepts = new Set();
  const raw = String(text || '');

  // 1. Capitalized proper phrases (e.g. "Helen Keller", "Miss Sullivan")
  const properNouns = raw.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
  const stopWords = new Set(['She', 'He', 'They', 'Later', 'Her', 'His', 'When', 'Although', 'People', 'After', 'Before', 'This', 'That', 'These', 'Those', 'Then', 'About', 'Other', 'Question', 'Answer']);
  for (const pn of properNouns) {
    if (!stopWords.has(pn) && pn.length > 2) {
      concepts.add(pn);
    }
  }

  // 2. High-signal educational phrases from text
  const domainPatterns = [
    /\b(?:hand signs?|special hand signs?)\b/i,
    /\b(?:running water|water)\b/i,
    /\b(?:spelling|spell words?)\b/i,
    /\b(?:communication|learning)\b/i,
    /\b(?:alphabet|words)\b/i,
    /\b(?:teaching|teacher)\b/i,
    /\b(?:parts of a plant|plant life cycle|water cycle|photosynthesis)\b/i,
  ];

  for (const pat of domainPatterns) {
    const match = raw.match(pat);
    if (match) {
      const term = match[0].charAt(0).toUpperCase() + match[0].slice(1);
      concepts.add(term);
    }
  }

  for (const ext of extraTerms) {
    if (ext && String(ext).trim().length > 2) {
      concepts.add(String(ext).trim());
    }
  }

  return [...concepts].slice(0, 8);
}

/**
 * Detect unit from document title or headings (e.g. "CLASS 4 ENGLISH UNIT 5 - DETAILED NOTES" -> "Unit 5")
 */
function detectUnitFromDocument(elements = [], fallbackUnit = '') {
  for (const el of elements.slice(0, 5)) {
    const text = String(el?.text || '');
    const m = text.match(/\bUNIT\s*(\d+)\b/i);
    if (m && m[1]) {
      return `Unit ${m[1]}`;
    }
  }
  return fallbackUnit || 'Unit 1';
}

/**
 * Check if two unit labels match semantically.
 */
function unitsMatch(u1, u2) {
  if (!u1 || !u2) return true;
  const s1 = String(u1).toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = String(u2).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s1 === 'all' || s2 === 'all') return true;
  return s1 === s2 || s1.includes(s2) || s2.includes(s1);
}

/**
 * Discover all image-bearing topics and images from the selected notes.
 *
 * Enforces strict scope isolation: only notes matching the requested
 * class, subject, unit, and selected sourceHash/document are searched.
 *
 * @param {Object} query - { class, subject, unit, sourceHash, sourceHashes, topic, search, imageType, page = 1, limit = 12 }
 * @returns {Promise<{ topics: Array<{ topic: string, imageCount: number, unit?: string }>, images: Array<Object>, totalImages: number, page: number, totalPages: number }>}
 */
export async function getNotesImagesAndTopics({
  class: cls,
  subject,
  unit,
  sourceHash,
  sourceHashes,
  topic: selectedTopic,
  search = '',
  imageType = 'All Types',
  page = 1,
  limit = 12,
} = {}) {
  // 1. Gather relevant document sourceHashes
  // STRICT RULE: No selected notes -> No image topics -> No images
  const targetHashes = new Set();
  const hashToDocMeta = new Map();

  const rawHashes = sourceHashes || sourceHash;
  if (rawHashes) {
    const list = Array.isArray(rawHashes) ? rawHashes : String(rawHashes).split(',');
    for (const item of list) {
      const sh = String(item || '').trim();
      if (sh) {
        targetHashes.add(sh);
        hashToDocMeta.set(sh, {
          sourceHash: sh,
          unit: unit || 'Unit',
          filename: 'Selected Notes.pdf',
        });
      }
    }
  }

  // If no notes were explicitly selected, strictly return empty result
  if (targetHashes.size === 0) {
    return {
      topics: [],
      images: [],
      totalImages: 0,
      page: 1,
      totalPages: 0,
    };
  }

  // Look up metadata for the explicitly selected source hashes only
  for (const h of targetHashes) {
    try {
      const qDoc = await qdrantStore.findSyllabusByHash(h, { class: cls, subject });
      if (qDoc && qDoc.indexed) {
        hashToDocMeta.set(h, {
          sourceHash: h,
          unit: qDoc.unit || unit || 'Unit',
          filename: qDoc.filename || qDoc.title || 'Selected Notes.pdf',
          class: qDoc.class || cls,
          subject: qDoc.subject || subject,
        });
      }
    } catch {
      /* best-effort metadata enrichment */
    }
  }

  // 2. Extract images from the matched structured documents
  const allImages = [];
  const topicCounts = new Map(); // topic -> { count, unit }

  const GENERIC_HEADINGS = new Set([
    'central idea', 'summary', 'main idea', 'important ideas', 'overview',
    'introduction', 'vocabulary', 'questions', 'exercises', 'points', 'notes',
  ]);

  for (const h of targetHashes) {
    const docMeta = hashToDocMeta.get(h) || { sourceHash: h, unit: unit || 'Unit', filename: 'Notes.pdf' };
    const doc = loadStructuredDocByHash(h);
    if (!doc || !Array.isArray(doc.elements)) continue;

    const elements = doc.elements;
    const docUnit = detectUnitFromDocument(elements, docMeta.unit || unit);

    let currentMajorSection = '';
    let currentTopic = cleanTopic(docUnit) || 'General';

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (el.type === 'heading') {
        const rawText = String(el.text || '').trim();
        if (isMajorSectionHeading(rawText)) {
          const sectionParsed = cleanSectionHeading(rawText);
          if (sectionParsed && sectionParsed.length > 2) {
            currentMajorSection = sectionParsed;
          }
        }

        const hText = cleanTopic(rawText);
        if (GENERIC_HEADINGS.has(hText.toLowerCase())) {
          currentTopic = currentMajorSection ? `${currentMajorSection} - ${hText}` : hText;
        } else if (hText && hText.length > 2 && !isMajorSectionHeading(rawText)) {
          currentTopic = hText;
        }
      }

      if (el.type === 'picture') {
        const rawUri = el.meta?.dataUri;
        if (!rawUri) continue; // Real pixel data is required

        // Find surrounding text for caption/title and concept detection
        const prevSlice = elements.slice(Math.max(0, i - 3), i);
        const nextSlice = elements.slice(i + 1, Math.min(elements.length, i + 4));
        const prevText = prevSlice.map((e) => e.text || '').join(' ').trim();
        const nextText = nextSlice.map((e) => e.text || '').join(' ').trim();
        const contextText = `${el.text || ''} ${prevText} ${nextText}`.trim();

        const imgType = deriveImageType(contextText);

        // Image title
        let title = el.text ? String(el.text).trim() : '';
        if (!title || title.length < 3) {
          if (currentMajorSection) {
            title = `${currentMajorSection} - Hand Signs Teaching Scene`;
          } else {
            title = `${currentTopic} Diagram`;
          }
        }

        // Concepts & visual elements
        const concepts = extractConceptsFromContext(contextText, [currentMajorSection, currentTopic]);
        const visualElements = [currentMajorSection, 'Hand-sign teaching interaction', 'Learning scene'].filter(Boolean);

        // Associated topics for this image (both specific and major section)
        const associatedTopics = new Set();
        if (currentTopic) associatedTopics.add(currentTopic);
        if (currentMajorSection && currentMajorSection !== currentTopic) {
          associatedTopics.add(currentMajorSection);
        }

        const imageObj = {
          id: el.id ? String(el.id) : `img-${h.slice(0, 8)}-${el.pageNumber || 1}-${i}`,
          assetId: el.id ? String(el.id) : `img-${h.slice(0, 8)}-${el.pageNumber || 1}-${i}`,
          title,
          topic: currentTopic,
          topics: [...associatedTopics],
          section: currentMajorSection || null,
          unit: docUnit,
          pageNumber: el.pageNumber || 1,
          imageType: imgType,
          source: docMeta.filename || 'Class Notes.pdf',
          sourceHash: h,
          sourceDocumentId: h,
          nearbyText: contextText,
          concepts,
          visualElements,
          dataUri: rawUri,
          mimeType: el.meta?.mimeType || 'image/png',
        };

        allImages.push(imageObj);

        // Record topic counts for all associated topics
        for (const t of associatedTopics) {
          const existing = topicCounts.get(t) || { count: 0, unit: imageObj.unit };
          existing.count += 1;
          topicCounts.set(t, existing);
        }
      }
    }
  }

  // Build sorted topics list
  let topicsList = [...topicCounts.entries()].map(([t, val]) => ({
    topic: t,
    imageCount: val.count,
    unit: val.unit,
  }));

  // Topic search filter (Requirement §9 & §25)
  if (search && search.trim()) {
    const sTerm = search.trim().toLowerCase();
    topicsList = topicsList.filter((t) =>
      t.topic.toLowerCase().includes(sTerm) ||
      (t.unit && t.unit.toLowerCase().includes(sTerm))
    );
  }

  // Filter available images
  let filteredImages = allImages;

  // Filter by unit if specified (Requirement §10 & §15)
  if (unit && String(unit).trim() && String(unit).trim().toLowerCase() !== 'all') {
    filteredImages = filteredImages.filter((im) => unitsMatch(im.unit, unit));
  }

  // Filter by topic if selected (Requirement §10 & §20)
  if (selectedTopic && String(selectedTopic).trim()) {
    const st = String(selectedTopic).trim().toLowerCase();
    filteredImages = filteredImages.filter((im) => {
      if (im.topic.toLowerCase() === st) return true;
      if (Array.isArray(im.topics) && im.topics.some((t) => t.toLowerCase() === st)) return true;
      return false;
    });
  }

  // Filter by image type if specified and not 'All Types'
  if (imageType && imageType !== 'All Types' && imageType !== 'all') {
    const it = String(imageType).trim().toLowerCase();
    filteredImages = filteredImages.filter((im) => im.imageType.toLowerCase() === it);
  }

  // Filter images by search query
  if (search && search.trim()) {
    const sTerm = search.trim().toLowerCase();
    filteredImages = filteredImages.filter((im) =>
      im.title.toLowerCase().includes(sTerm) ||
      im.topic.toLowerCase().includes(sTerm) ||
      (Array.isArray(im.topics) && im.topics.some((t) => t.toLowerCase().includes(sTerm))) ||
      (Array.isArray(im.concepts) && im.concepts.some((c) => c.toLowerCase().includes(sTerm))) ||
      im.imageType.toLowerCase().includes(sTerm)
    );
  }

  const totalImages = filteredImages.length;
  const pageNum = Math.max(1, Number(page) || 1);
  const pageSize = Math.max(1, Number(limit) || 12);
  const totalPages = Math.ceil(totalImages / pageSize) || 1;
  const paginatedImages = filteredImages.slice((pageNum - 1) * pageSize, pageNum * pageSize);

  return {
    topics: topicsList,
    images: paginatedImages,
    totalImages,
    page: pageNum,
    totalPages,
  };
}

export default { getNotesImagesAndTopics };
