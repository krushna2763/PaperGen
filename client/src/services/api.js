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
   * Per-slot generation progress.
   * @param {string} jobId
   * @returns {Promise<{ done, slots: Array<{ slot, label, state, attempts }> }>}
   */
  status: async (jobId) => {
    const response = await api.get(`/papers/${jobId}/status`);
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
   * Syllabus units that have notes indexed for a class + subject.
   * @param {Object} params - { class, subject }
   * @returns {Promise<{ success, data: Array<{ id, label, chunkCount }> }>}
   */
  listUnits: async (params) => {
    const response = await api.get('/kb/units', { params });
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
};

export const questionService = {
  /**
   * Run the Agentic RAG question generation pipeline (Modules 7-11)
   * @param {Object} params - { class, subject, topic, difficulty, questionCount, questionType }
   */
  generate: async (params) => {
    const response = await api.post('/questions/generate', params);
    return response.data;
  },
};

export default api;

