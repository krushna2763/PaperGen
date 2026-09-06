import { storageService } from '../services/storage.service.js';
import { pdfParser } from '../document/pdf-parser.js';
import { questionExtractor } from '../document/question-extractor.js';
import { runReferenceAnalysis } from '../agents/reference-paper-analyzer.agent.js';
import { analyzeTemplate } from '../blueprint/template-analyzer.js';
import { embeddingService } from '../rag/embeddings.js';
import { qdrantStore } from '../rag/qdrant.js';
import { createJob } from '../services/job-store.js';
import { deriveAvailableUnits } from '../blueprint/available-units.js';

/**
 * Controller for Question Paper PDF uploads
 */
export const uploadPaper = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded. Please provide a PDF file in the "file" field.'
      });
    }

    console.log(`[Paper Controller] Processing upload for: ${req.file.originalname} (${req.file.size} bytes)`);

    // Upload to Cloudinary via Storage Service
    const storedFile = await storageService.uploadPdf(req.file);

    console.log(`[Paper Controller] Successfully uploaded to Cloudinary: ${storedFile.publicId}`);

    return res.status(200).json({
      success: true,
      message: 'PDF uploaded successfully',
      data: {
        file: {
          url: storedFile.url,
          publicId: storedFile.publicId,
          originalName: storedFile.originalName,
          mimeType: storedFile.mimeType,
          size: storedFile.size
        }
      }
    });
  } catch (error) {
    console.error('[Paper Controller] Upload error:', error);
    next(error);
  }
};

/**
 * Controller for extracting text from an uploaded PDF
 */
export const extractPaperText = async (req, res, next) => {
  try {
    const { fileUrl } = req.body;

    if (!fileUrl || typeof fileUrl !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid "fileUrl" parameter in the request body.'
      });
    }

    console.log(`[Paper Controller] Initiating text extraction for document at: ${fileUrl}`);

    // 1. Download PDF buffer from storage service
    const pdfBuffer = await storageService.downloadFileBuffer(fileUrl);

    // 2. Parse and clean PDF text
    const extractionResult = await pdfParser.parseBuffer(pdfBuffer);

    console.log(`[Paper Controller] Text extracted: ${extractionResult.pageCount} page(s), ${extractionResult.characterCount} char(s), status: ${extractionResult.extractionStatus}`);

    if (extractionResult.warnings && extractionResult.warnings.length > 0) {
      console.warn('[Paper Controller] Extraction warnings:', extractionResult.warnings);
    }

    return res.status(200).json({
      success: true,
      message: 'PDF text extracted successfully',
      data: {
        extraction: {
          text: extractionResult.text,
          pageCount: extractionResult.pageCount,
          characterCount: extractionResult.characterCount,
          extractionStatus: extractionResult.extractionStatus,
          extractionMethod: extractionResult.extractionMethod,
          pdfInfo: extractionResult.pdfInfo,
          ...(extractionResult.ocr ? { ocr: extractionResult.ocr } : {}),
          ...(extractionResult.warnings ? { warnings: extractionResult.warnings } : {})
        }
      }
    });
  } catch (error) {
    console.error('[Paper Controller] Text extraction error:', error);
    next(error);
  }
};

/**
 * Controller for extracting individual academic questions from a PDF
 */
export const extractPaperQuestions = async (req, res, next) => {
  try {
    const { fileUrl, text, pages } = req.body;

    let textToProcess = text;
    let pageData = pages || [];
    let parsedData = null;

    // If fileUrl is provided without text, fetch and parse the PDF first
    if (!textToProcess && fileUrl) {
      if (typeof fileUrl !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'The provided "fileUrl" is invalid.'
        });
      }

      console.log(`[Paper Controller] Fetching PDF from ${fileUrl} for question extraction`);
      const pdfBuffer = await storageService.downloadFileBuffer(fileUrl);
      parsedData = await pdfParser.parseBuffer(pdfBuffer);
      textToProcess = parsedData.text;
      pageData = parsedData.pages;
    }

    if (!textToProcess || typeof textToProcess !== 'string' || textToProcess.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide either a valid "fileUrl" or non-empty "text" in the request body.'
      });
    }

    console.log(`[Paper Controller] Extracting questions from text (${textToProcess.length} chars)`);

    // Execute deterministic question extraction
    const extractionResult = questionExtractor.extract(textToProcess, pageData);

    console.log(`[Paper Controller] Extracted ${extractionResult.count} question(s) across sections: [${extractionResult.sections.join(', ')}]`);

    // REFERENCE PAPER ANALYZER AGENT: build the canonical Reference Paper
    // Specification from the already-extracted questions (deterministic, no
    // LLM — structure/topics/marks are DISCOVERED, never invented). Non-fatal:
    // a failed spec must never break extraction — the caller simply falls
    // back to free-form generation.
    let blueprint = null;
    try {
      const analysis = runReferenceAnalysis({ questions: extractionResult.questions, text: textToProcess });
      blueprint = analysis.spec;
      console.log(
        `[Paper Controller] Reference Paper Analyzer: ${analysis.summary.questionCount} question(s), ` +
        `${analysis.summary.totalMarks ?? 'unknown'} total mark(s), ` +
        `${analysis.summary.sectionCount} section(s)${analysis.summary.marksComplete ? '' : ' (marks incomplete)'} ` +
        `(analyzer=${blueprint.analyzer?.determinism ?? 'deterministic'})`
      );
      if (analysis.warnings.length > 0) {
        console.warn(`[Paper Controller] Analyzer warnings (${analysis.warnings.length}):`, analysis.warnings.slice(0, 4));
      }
    } catch (err) {
      console.warn('[Paper Controller] Reference Paper Analyzer failed (non-fatal):', err.message);
    }

    // Build the UNIVERSAL visual TEMPLATE of the reference (deterministic, no
    // LLM). Structure (blueprint) and visuals (template) are kept separate —
    // the renderer later consumes both. Non-fatal like the blueprint.
    let template = null;
    try {
      template = analyzeTemplate({
        text: textToProcess,
        pages: pageData,
        questions: extractionResult.questions,
        blueprint,
      });
      console.log(
        `[Paper Controller] Template analyzed: sections=${template.sections.present}, ` +
        `header=${Object.keys(template.header.present).filter((k) => template.header.present[k]).length} field(s), ` +
        `numbering=${template.numbering.style}, marks=${template.marks.style}`
      );
    } catch (err) {
      console.warn('[Paper Controller] Template analysis failed (non-fatal):', err.message);
    }

    return res.status(200).json({
      success: true,
      message: extractionResult.warnings.length > 0 
        ? 'Questions extracted with warnings' 
        : 'Questions extracted successfully',
      data: {
        questions: extractionResult.questions,
        count: extractionResult.count,
        sections: extractionResult.sections,
        warnings: extractionResult.warnings,
        // Additive: the LOCKED structural blueprint of the reference paper
        ...(blueprint ? { blueprint } : {}),
        // Additive: the UNIVERSAL visual template of the reference paper
        // (header block, instruction heading, numbering/marks/option styles).
        ...(template ? { template } : {}),
        // Additive: tells the caller whether OCR was used to recover this PDF
        extractionMethod: parsedData?.extractionMethod,
        ...(parsedData?.extractionStatus ? { extractionStatus: parsedData.extractionStatus } : {}),
        ...(parsedData?.ocr ? { ocr: parsedData.ocr } : {})
      }
    });
  } catch (error) {
    console.error('[Paper Controller] Question extraction error:', error);
    next(error);
  }
};

/**
 * POST /api/papers/analyze   { fileUrl, class, subject }
 *   -> { jobId, blueprint, availableUnits }
 *
 * Step 1 of the two-step flow: parse the reference paper, extract its LOCKED
 * blueprint (deterministic, no LLM) and the full unit list for the class +
 * subject. Generation is a separate call so the teacher can review and assign
 * units in between. Response is UNWRAPPED — the contract is exactly the object
 * above and the client synthesizes no fallback.
 */
export const analyzePaper = async (req, res, next) => {
  try {
    const { fileUrl } = req.body || {};
    const cls = String(req.body?.class ?? '').trim();
    const subject = String(req.body?.subject ?? '').trim();

    if (!fileUrl || typeof fileUrl !== 'string') {
      return res.status(400).json({ success: false, message: '"fileUrl" is required.' });
    }
    if (!cls) return res.status(400).json({ success: false, message: '"class" is required.' });
    if (!subject) return res.status(400).json({ success: false, message: '"subject" is required.' });

    const buffer = await storageService.downloadFileBuffer(fileUrl);
    const parsed = await pdfParser.parseBuffer(buffer);
    const extracted = questionExtractor.extract(parsed.text, parsed.pages);

    const analysis = runReferenceAnalysis({ questions: extracted.questions, text: parsed.text });
    const blueprint = analysis.spec;

    const unitsWithNotes = await qdrantStore.listUnitsWithNotes({ class: cls, subject });
    const availableUnits = deriveAvailableUnits({ unitsWithNotes });

    const jobId = createJob(blueprint);

    console.log(
      `[Paper Controller] analyze: job ${jobId} — ${blueprint.questions.length} slot(s), ` +
      `${(blueprint.sections || []).length} section(s), ${availableUnits.length} syllabus unit(s) with notes.`
    );

    return res.status(200).json({ jobId, blueprint, availableUnits });
  } catch (error) {
    console.error('[Paper Controller] analyze error:', error);
    next(error);
  }
};

/**
 * Controller for checking whether a previously processed PDF (by content
 * SHA-256 hash) is already embedded + indexed in Qdrant. Lets the client skip
 * the expensive re-ingestion pipeline (download → extract → embed → index)
 * on repeated generations with the same uploaded paper.
 */
export const checkPaperIndexed = async (req, res, next) => {
  try {
    const { sourceHash } = req.body;
    if (!sourceHash || typeof sourceHash !== 'string' || sourceHash.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a "sourceHash" (SHA-256 of the PDF bytes) in the request body.'
      });
    }

    const existing = await qdrantStore.findExistingByHash(sourceHash.trim());

    return res.status(200).json({
      success: true,
      data: existing, // { indexed, sourceDocumentId, pointCount }
    });
  } catch (error) {
    console.error('[Paper Controller] Source-hash check error:', error);
    next(error);
  }
};

/**
 * Controller for generating Gemini embedding vectors for extracted questions
 */
export const embedPaperQuestions = async (req, res, next) => {
  try {
    const { questions, fileUrl, sourceHash } = req.body;

    // Source reuse: if this exact PDF (content hash) is already embedded and
    // indexed, skip the embedding API calls entirely.
    if (sourceHash && typeof sourceHash === 'string' && sourceHash.trim().length > 0) {
      const existing = await qdrantStore.findExistingByHash(sourceHash.trim());
      if (existing.indexed) {
        console.log(`[Paper Controller] Source already indexed (hash ${sourceHash.slice(0, 12)}…) — skipping embedding (${existing.pointCount} point(s) reused).`);
        return res.status(200).json({
          success: true,
          message: 'Source already indexed — embedding skipped.',
          data: {
            reused: true,
            sourceDocumentId: existing.sourceDocumentId,
            count: 0,
            questions: [],
            vectorDimension: 0,
            embeddingModel: process.env.EMBEDDING_MODEL || null,
          }
        });
      }
    }

    let questionsToEmbed = questions;

    // If fileUrl provided without pre-extracted questions, run pipeline
    if (!questionsToEmbed && fileUrl) {
      if (typeof fileUrl !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'The provided "fileUrl" is invalid.'
        });
      }

      console.log(`[Paper Controller] Auto-extracting questions from ${fileUrl} for embeddings`);
      const pdfBuffer = await storageService.downloadFileBuffer(fileUrl);
      const parsedData = await pdfParser.parseBuffer(pdfBuffer);
      const extracted = questionExtractor.extract(parsedData.text, parsedData.pages);
      questionsToEmbed = extracted.questions;
    }

    if (!questionsToEmbed || !Array.isArray(questionsToEmbed) || questionsToEmbed.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide an array of "questions" or a valid "fileUrl" in the request body.'
      });
    }

    console.log(`[Paper Controller] Generating embeddings for ${questionsToEmbed.length} question(s)`);

    // Call embedding service
    const embeddingResult = await embeddingService.embedQuestions(questionsToEmbed);

    console.log(`[Paper Controller] Embeddings complete. Count: ${embeddingResult.count}, Dimension: ${embeddingResult.vectorDimension}`);

    return res.status(200).json({
      success: true,
      message: 'Questions embedded successfully',
      data: {
        count: embeddingResult.count,
        embeddingModel: embeddingResult.embeddingModel,
        vectorDimension: embeddingResult.vectorDimension,
        questions: embeddingResult.questions
      }
    });
  } catch (error) {
    console.error('[Paper Controller] Embedding generation error:', error);
    next(error);
  }
};

/**
 * Controller for indexing embedded questions into Qdrant vector store
 */
export const indexPaperQuestions = async (req, res, next) => {
  try {
    const { questions, sourceDocumentId, sourceHash, class: docClass, subject, fileUrl } = req.body;

    // Source reuse: if this exact PDF is already indexed, nothing to do.
    if (sourceHash && typeof sourceHash === 'string' && sourceHash.trim().length > 0) {
      const existing = await qdrantStore.findExistingByHash(sourceHash.trim());
      if (existing.indexed) {
        console.log(`[Paper Controller] Source already indexed (hash ${sourceHash.slice(0, 12)}…) — skipping indexing.`);
        return res.status(200).json({
          success: true,
          message: 'Source already indexed — nothing to do.',
          data: {
            reused: true,
            sourceDocumentId: existing.sourceDocumentId,
            indexedCount: 0,
            skippedCount: 0,
            collection: process.env.QDRANT_COLLECTION || null,
            vectorDimension: 0,
          }
        });
      }
    }

    let questionsToIndex = questions;

    // If fileUrl provided without pre-embedded questions, run full pipeline
    if (!questionsToIndex && fileUrl) {
      if (typeof fileUrl !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'The provided "fileUrl" is invalid.'
        });
      }

      console.log(`[Paper Controller] Running full pipeline for Qdrant indexing: ${fileUrl}`);
      const pdfBuffer = await storageService.downloadFileBuffer(fileUrl);
      const parsedData = await pdfParser.parseBuffer(pdfBuffer);
      const extracted = questionExtractor.extract(parsedData.text, parsedData.pages);
      const embedded = await embeddingService.embedQuestions(extracted.questions);
      questionsToIndex = embedded.questions;
    }

    if (!questionsToIndex || !Array.isArray(questionsToIndex) || questionsToIndex.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide an array of "questions" with embeddings, or a valid "fileUrl" to run the full pipeline.'
      });
    }

    console.log(`[Paper Controller] Indexing ${questionsToIndex.length} question(s) into Qdrant`);

    const result = await qdrantStore.upsertQuestions(questionsToIndex, {
      sourceDocumentId: sourceDocumentId || undefined,
      sourceHash: sourceHash || undefined,
      class: docClass || undefined,
      subject: subject || undefined,
    });

    console.log(`[Paper Controller] Qdrant indexing complete: ${result.indexedCount} points in "${result.collection}"`);

    return res.status(200).json({
      success: true,
      message: result.skippedCount > 0
        ? `Questions indexed with ${result.skippedCount} skipped`
        : 'Questions indexed successfully',
      data: {
        collection: result.collection,
        sourceDocumentId: result.sourceDocumentId,
        indexedCount: result.indexedCount,
        skippedCount: result.skippedCount,
        vectorDimension: result.vectorDimension,
        skippedDetails: result.skippedDetails,
      }
    });
  } catch (error) {
    console.error('[Paper Controller] Qdrant indexing error:', error);
    next(error);
  }
};
