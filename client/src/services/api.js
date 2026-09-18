import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 600000, // 10min: agentic generation runs many sequential LLM calls + retry rounds
});

export const healthService = {
  check: async () => {
    const response = await api.get('/health');
    return response.data;
  },
};

export const paperService = {
  /**
   * Upload a PDF question paper
   * @param {File} file - PDF file object
   * @param {Function} onProgress - Optional callback for upload progress percentage
   */
  upload: async (file, onProgress) => {
    const formData = new FormData();
    formData.append('file', file);

    const response = await api.post('/papers/upload', formData, {
      headers: {
        // Let Axios/browser automatically set multipart boundary
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          onProgress(percent);
        }
      },
    });

    return response.data;
  },

  /**
   * Extract and clean text from an uploaded PDF via backend parser
   * @param {string} fileUrl - Public URL of the uploaded PDF
   */
  extractText: async (fileUrl) => {
    const response = await api.post('/papers/extract-text', { fileUrl });
    return response.data;
  },

  /**
   * Extract individual structured question objects from PDF or text
   * @param {Object} params - { fileUrl, text, pages }
   */
  extractQuestions: async (params) => {
    const response = await api.post('/papers/extract-questions', params);
    return response.data;
  },

  /**
   * Step 1 of the two-step flow: parse the reference paper into its locked
   * blueprint + the syllabus unit list. No generation.
   * @param {Object} params - { fileUrl, class, subject }
   * @returns {Promise<{ jobId, blueprint, availableUnits }>} (unwrapped)
   */
  analyze: async (params) => {
    const response = await api.post('/papers/analyze', params);
    return response.data;
  },

  /**
   * Step 2: notes-grounded generation from the reviewed blueprint + the
   * teacher's unit assignment. Body carries everything; no server-side state.
   * @param {string} jobId
   * @param {Object} body - { blueprint, difficulty, slotUnitMap }
   * @returns {Promise<{ success, message, data }>}
   */
  generate: async (jobId, body) => {
    const response = await api.post(`/papers/${jobId}/generate`, body);
    return response.data;
  },

  /**
   * Per-slot generation progress and final result retrieval.
   * @param {string} jobId
   * @returns {Promise<{ done, slots: Array<{ slot, label, state, attempts }>, status, progressPercent, currentStage, result?, error? }>}
   */
  status: async (jobId) => {
    const response = await api.get(`/papers/${jobId}/status`);
    return response.data;
  },

  /**
   * Return the SSE telemetry stream endpoint URL for a given job.
   * @param {string} jobId
   * @returns {string}
   */
  getStreamUrl: (jobId) => `/api/papers/${encodeURIComponent(jobId)}/stream`,

  /**
   * Cancel an active generation job.
   * @param {string} jobId
   * @param {string} [reason]
   * @returns {Promise<{ success: boolean, status: string, message: string }>}
   */
  cancel: async (jobId, reason) => {
    const response = await api.post(`/papers/${encodeURIComponent(jobId)}/cancel`, { reason });
    return response.data;
  },

  /**
   * Check whether a previously uploaded PDF (by content SHA-256 hash) is
   * already embedded + indexed in Qdrant, so re-generating from the same
   * paper skips the expensive re-ingestion pipeline.
   * @param {Object} params - { sourceHash }
   */
  checkIndexed: async (params) => {
    const response = await api.post('/papers/check-indexed', params);
    return response.data;
  },

  /**
   * Generate Gemini embedding vectors for an array of structured questions
   * @param {Object} params - { questions, fileUrl, sourceHash }
   */
  embedQuestions: async (params) => {
    const response = await api.post('/papers/embed-questions', params);
    return response.data;
  },

  /**
   * Index embedded question vectors into the Qdrant vector store
   * @param {Object} params - { questions, sourceDocumentId, sourceHash, class, subject, fileUrl }
   */
  indexQuestions: async (params) => {
    const response = await api.post('/papers/index-questions', params);
    return response.data;
  },
};

export const kbService = {
  /**
   * Note documents indexed for a class + subject (one entry = one ingested
   * notes file, grouped from the syllabus corpus by content hash). Mode B
   * "Select from Knowledge Base" lists and picks from these.
   * @param {Object} params - { class, subject }
   * @returns {Promise<{ success, data: Array<{ id, title, class, subject, units: Array<{ id, label, chunkCount }>, chunkCount, ingestedAt, filename }> }>}
   */
  listDocuments: async (params) => {
    const response = await api.get('/kb/documents', { params });
    return response.data;
  },

  /**
   * Syllabus units that have notes indexed for a class + subject.
   * @param {Object} params - { class, subject }
   * @returns {Promise<{ success, data: Array<{ id, label, chunkCount }> }>}
   */
  listUnits: async (params) => {
    const response = await api.get('/kb/units', { params });
    return response.data;
  },

  /**
   * Topics (detected chapters) in ONE unit's notes — combobox suggestions for
   * the manual builder. Suggestions only; the teacher may type their own.
   * @param {Object} params - { class, subject, unit }
   * @returns {Promise<{ success, data: Array<{ topic, chunkCount }> }>}
   */
  listTopics: async (params) => {
    const response = await api.get('/kb/topics', { params });
    return response.data;
  },

  /**
   * Coverage check for a (usually typed) topic against a unit's indexed notes.
   * Advisory — unmatched topics warn inline, never block.
   * @param {Object} params - { class, subject, unit, topic }
   * @returns {Promise<{ success, data: { matched, chunkCount, topScore } }>}
   */
  topicCoverage: async (params) => {
    const response = await api.get('/kb/topics/coverage', { params });
    return response.data;
  },

  /**
   * Upload notes for one (class, subject, unit). `form` is a FormData with
   * file + class + subject + unit.
   */
  uploadNotes: async (form) => {
    const response = await api.post('/kb/notes', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  /**
   * List images and image-bearing topics extracted from notes.
   * Filterable by class, subject, unit, sourceHash, topic, or search.
   * @param {Object} params - { class, subject, unit, sourceHash, topic, search }
   * @returns {Promise<{ success, data: { topics: Array<{ topic, count, units }>, images: Array<Object>, totalImages } }>}
   */
  listNotesImages: async (params) => {
    const response = await api.get('/kb/notes/images', { params });
    return response.data;
  },
};

export const manualService = {
  /**
   * Mode B step 1: submit the teacher-built blueprint. Returns the SAME shape
   * as /papers/analyze, so the existing confirm + generate steps run unchanged.
   * @param {Object} body - { blueprint, slotUnitMap? }
   * @returns {Promise<{ jobId, blueprint, availableUnits }>} (unwrapped)
   */
  create: async (body) => {
    const response = await api.post('/papers/manual', body);
    return response.data;
  },
};

export const templateService = {
  /**
   * Save the current structure as a template (structure ONLY — no units,
   * topics or generated content; the server sanitizer strips anything else).
   * @param {Object} body - { name, blueprint }
   * @returns {Promise<{ success, data: { id, name } }>}
   */
  save: async (body) => {
    const response = await api.post('/templates', body);
    return response.data;
  },

  /**
   * List saved templates for a class + subject.
   * @param {Object} params - { class, subject }
   * @returns {Promise<{ success, data: Array<{ id, name, questionCount, totalMarks }> }>}
   */
  list: async (params) => {
    const response = await api.get('/templates', { params });
    return response.data;
  },

  /**
   * Load one template (its structure blueprint) into the builder.
   * @param {string} id
   */
  get: async (id) => {
    const response = await api.get(`/templates/${id}`);
   return response.data;
  },

  delete: async (id) => {
    const response = await api.delete(`/templates/${id}`);
    return response.data;
  },
};

export const questionService = {
  /**
   * The QUESTION TYPE REGISTRY (GET /api/question-types) — the client renders
   * builder fields from the same source of truth the server validates against.
   * @returns {Promise<{ success, data: Array<Object> }>}
   */
  listTypes: async () => {
    const response = await api.get('/question-types');
    return response.data;
  },

  /**
   * Run the Agentic RAG question generation pipeline (Modules 7-11)
   * @param {Object} params - { class, subject, topic, difficulty, questionCount, questionType }
   */
  generate: async (params) => {
    const response = await api.post('/questions/generate', params);
    return response.data;
  },
};

export const libraryService = {
  list: async (params) => {
    const response = await api.get('/library', { params });
    return response.data;
  },
  stats: async () => {
    const response = await api.get('/library/stats');
    return response.data;
  },
  get: async (id) => {
    const response = await api.get(`/library/${id}`);
    return response.data;
  },
  create: async (body) => {
    const response = await api.post('/library', body);
    return response.data;
  },
  patch: async (id, body) => {
    const response = await api.patch(`/library/${id}`, body);
    return response.data;
  },
  remove: async (id) => {
    const response = await api.delete(`/library/${id}`);
    return response.data;
  },
  duplicate: async (id) => {
    const response = await api.post(`/library/${id}/duplicate`);
    return response.data;
  },
};

export const schoolTemplateService = {
  list: async (params) => {
    const response = await api.get('/school-templates', { params });
    return response.data;
  },
  get: async (id) => {
    const response = await api.get(`/school-templates/${id}`);
    return response.data;
  },
  create: async (body) => {
    const response = await api.post('/school-templates', body);
    return response.data;
  },
  update: async (id, body) => {
    const response = await api.put(`/school-templates/${id}`, body);
    return response.data;
  },
  remove: async (id) => {
    const response = await api.delete(`/school-templates/${id}`);
    return response.data;
  },
  seed: async (body) => {
    const response = await api.post('/school-templates/seed', body);
    return response.data;
  },
};

export default api;

