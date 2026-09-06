# 📊 Complete Project Report — PaperGen AI

**Project:** AI-Powered Agentic RAG Question Generator (`paper-setting-ai-agent`) v1.0.0
**Report date:** September 6, 2026
**Codebase:** ~10,470 lines of application JS across 116 files (client + server, excl. deps)
**Structure:** npm workspaces — `client/` (React 18 + Vite 6 + Tailwind), `server/` (Express 4 + LangGraph)

---

## 1. Executive Summary

PaperGen AI turns a **previous-year exam paper (PDF)** into a **new, notes-grounded question paper**. It combines deterministic PDF parsing, a Qdrant-backed dual-corpus vector store (past papers + syllabus notes), Gemini embeddings/LLM via an 8-key failover pool, and a LangGraph agent pipeline with quality gates and targeted regeneration.

**Verdict as of this report: the product works end-to-end.** The three critical issues found in the original analysis have been fixed and verified in a live browser E2E test. The remaining work is security hardening and test depth.

| Area | Grade | Notes |
|---|---|---|
| Backend architecture | ★★★★★ | Layered, latency-optimized LangGraph pipeline, exceptional comments discipline |
| Vector/RAG design | ★★★★☆ | Dual corpora, per-slot question-level RAG, hash-based ingestion dedup |
| Frontend | ★★★★☆ | Two-step flow now fully wired (was broken); 1,161-line App.jsx monolith remains |
| Tests | ★★★☆☆ | 45 tests all passing (33 server + 12 client); deterministic modules only |
| Security & config | ★★☆☆☆ | Open CORS, no auth/rate-limit, leaked Qdrant URL in source |
| Docs | ★★★☆☆ | README still describes the old single-step flow |

### ✅ Fixed since the original analysis (all verified)

| # | Original issue | Status |
|---|---|---|
| C1 | App.jsx `ReferenceError: generating is not defined` → white-screen | ✅ **Fixed** — replaced with the `phase` state machine + derived flags |
| C2 | Two-step flow dead code: `ConfirmScreen` never rendered, `/papers/analyze` + `/papers/:jobId/generate` never called | ✅ **Fixed** — full analyze → confirm → generate flow wired and E2E-verified in the browser |
| C3 | No git repository | ✅ **Fixed** — initial commit `f607bd4` exists |
| B1 (found during E2E) | Validation deadlock: slots with *unknown reference marks* (e.g. "Match the following") were rejected unconditionally → 0/N accepted | ✅ **Fixed** — `deterministicCheck` now receives the blueprint slot and exempts marks when the reference has none; semantic + blueprint validators still apply |

---

## 2. Architecture Overview

```
┌─────────────────────────── CLIENT (React 18 + Vite 6 + Tailwind) ──────────────────────────┐
│  App.jsx — phase state machine:                                                            │
│    'analyzing' → upload → SHA-256 → check-indexed → extract → embed → index → /analyze     │
│    'confirm'   → ConfirmScreen (blueprint review + per-slot unit assignment + notes)       │
│    'generating'→ POST /generate + poll /status every 4s ("N/M questions accepted")         │
│    'review'    → PDF-style preview, View PDF / Download / Back to Blueprint                │
│  ConfirmScreen.jsx — blueprint summary, unit chunk counts, marks-per-unit bars, dropdowns  │
│  blueprintUnits.js — slot/unit assignment math (unit-tested)                               │
│  services/: api.js (axios, 10-min timeout) · paperLayout.js · paperPdf.js (pdfmake) ·      │
│              paperTemplate.js (localStorage persistence) · fonts/LiberationSerif.js        │
└──────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                           │ /api (Vite proxy → :5000)
┌──────────────────────────────────────────▼─────────────────────────────────────────────────┐
│                              SERVER (Express 4, ES Modules)                                │
│  routes → controllers → agents/services                                                    │
│                                                                                            │
│  Ingestion:   upload (Multer→Cloudinary) → extract-text → extract-questions                │
│               → embed-questions (Gemini) → index-questions (Qdrant, hash-deduped)          │
│                                                                                            │
│  Two-step flow (PRIMARY):  POST /papers/analyze → { jobId, blueprint, availableUnits }     │
│                            POST /papers/:jobId/generate { blueprint, difficulty,           │
│                                                            class, subject, slotUnitMap }   │
│                            GET  /papers/:jobId/status → per-slot progress (30-min TTL)     │
│  Notes KB:                 POST /kb/notes · GET /kb/units?class&subject                    │
│  Legacy flow (API-only):   POST /questions/generate (free-form RAG, no confirm step)       │
│                                                                                            │
│  AGENT PIPELINE (LangGraph StateGraph):                                                    │
│    START → retrieve → generate → embedGenerated → evaluateBatch                            │
│             ▲                                        │ (rejected? → regenerateFailed ──┐)  │
│             │                                        └─ blueprintCheck (blueprint mode)│  │
│             └────────────────────────────────────────────────────────────────────────┘   │
└──────────────┬──────────────────────┬───────────────────────┬──────────────────────────────┘
               ▼                      ▼                       ▼
        Qdrant (2 corpora)     Gemini API (LLM +         Cloudinary (PDF storage)
        past_paper + syllabus  embeddings, 8-key         + local Tesseract OCR
        with metadata filters  failover pool)            fallback for scanned PDFs
```

### Key design decisions (well done)

1. **Deterministic-first philosophy** — blueprint extraction, template analysis, question extraction, dedup, and peer-similarity are pure JS; LLM calls are reserved for generation and validation.
2. **Dual corpora** — `past_paper` (duplication target for similarity checks) vs `syllabus` (grounding source). Evaluation filters source-similarity checks to `corpus: 'past_paper'` only.
3. **Blueprint mode** — the reference paper's structure (types, marks, item counts, sections) is LOCKED; only content regenerates. `questionCount` is overridden by `blueprint.totalQuestions`.
4. **Stateless generate endpoint** — blueprint/slotUnitMap travel in the request body (teacher edits win); the in-memory job store holds only progress state with a 30-min TTL sweep.
5. **Resilience** — 8-key Gemini failover pool (absorbed real 503 "high demand" errors during E2E), fallback LLM models (LLM-only so embedding dimensions stay stable), embedding cache, controlled concurrency (`AI_EVAL_CONCURRENCY=3`), content-hash ingestion reuse, OCR fallback for scanned PDFs.
6. **Client PDF fidelity** — screen preview uses the same `buildPaperModel`/`paginatePaper` as the pdfmake export; template auto-fill with teacher-override precedence.

---

## 3. Complete API Reference

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| GET | `/api/health` | Server + Qdrant + Gemini + Cloudinary status | — |
| POST | `/api/papers/upload` | PDF upload → Cloudinary (15 MB cap, PDF-only) | — |
| POST | `/api/papers/analyze` | Extract + lock blueprint → `{ jobId, blueprint, availableUnits }` | — |
| POST | `/api/papers/extract-text` | Text extraction (with `fileUrl` support) | — |
| POST | `/api/papers/extract-questions` | Deterministic question extraction | — |
| POST | `/api/papers/check-indexed` | SHA-256 content-hash ingestion check | — |
| POST | `/api/papers/embed-questions` | Gemini embeddings for extracted questions | — |
| POST | `/api/papers/index-questions` | Index into `past_paper` corpus (Qdrant) | — |
| POST | `/api/papers/:jobId/generate` | Blueprint-mode generation `{ blueprint, class, subject, difficulty, slotUnitMap }` | — |
| GET | `/api/papers/:jobId/status` | Per-slot live progress | — |
| POST | `/api/kb/notes` | Upload syllabus notes per (class, subject, unit) | — |
| GET | `/api/kb/units` | List units with chunk counts | — |
| POST | `/api/questions/generate` | Legacy free-form RAG generation | — |

Error semantics: `400` invalid input · `404` unknown job · `422` blueprint/slotUnitMap contract violation (lists offending slots) · `502` model returned nothing.

---

## 4. AI Call Economics

**Baseline pipeline (5 questions, non-blueprint): 4 Gemini calls minimum** (down from ~17 pre-optimization):

| Step | AI calls | Other |
|---|---|---|
| `retrieve` | 1 embedding (query) | 1 Qdrant search |
| `generate` | 1 LLM call (all 5 questions in one batch) | — |
| `embedGenerated` | 1 embedding request (5 inputs) | — |
| `evaluateBatch` | 1 batch LLM validation | 5 parallel Qdrant source-checks + local-cosine peer dedup (0 LLM) |

- **Blueprint mode adds:** 1 embedding request for the N slot-queries + N per-slot Qdrant searches → e.g. **5 embeddings + 5 searches for 5 slots**.
- **Refill:** +1 LLM call only if the batch returns fewer questions than slots.
- **Retries:** each round adds calls only for failed questions (1 LLM per failed question, batch embed + batch validation), up to `MAX_RETRIES=3`.
- **Caching:** the embedding cache turns repeated text into cache hits (`meta.ai.cacheHits`).
- **Observability:** every response carries `meta.ai` (`geminiRequests`, `embeddingRequests`, `embeddingInputs`, `validationRequests`, `failoverAttempts`) and `meta.timing` per stage.

**Measured real-world E2E (5 slots, 1 regeneration round):** generation completed in **159 s**, inflated by several Gemini 503 "high demand" errors absorbed by the 8-key failover pool.

---

## 5. Feature Inventory

| Feature | Status | Where |
|---|---|---|
| PDF upload (15 MB cap, PDF-only filter) | ✅ | `upload.middleware.js`, `paper.controller.js` |
| Text extraction + scanned-PDF OCR fallback (Tesseract, DPI-tuned) | ✅ | `pdf-parser.js`, `ocr.js` |
| Deterministic question extraction (sections, marks, options, sub-parts) | ✅ | `question-extractor.js` |
| Locked blueprint extraction + shape/normalization/validation | ✅ | `blueprint/*` (6 modules) |
| Visual template auto-detection (header, numbering, marks style) | ✅ | `template-analyzer.js` |
| Notes ingestion per (class, subject, unit) + unit listing | ✅ | `kb.controller.js`, `notes-chunker.js` |
| **Two-step flow UI (analyze → confirm → generate)** | ✅ **fixed & verified** | `App.jsx`, `ConfirmScreen.jsx` |
| Confirm screen: per-question/per-item unit assignment, live marks-per-unit bars | ✅ rendered | `ConfirmScreen.jsx` |
| Per-slot live progress polling during generation | ✅ **wired (4 s interval)** | `App.jsx`, `job-store.js` |
| Question-level RAG (per-slot contexts) | ✅ | `retrieval.agent.js`, orchestrator |
| Batch generation + refill + dedup | ✅ | `question-generator.agent.js` (637 lines) |
| Quality gate: deterministic → peer cosine → Qdrant source check → batch LLM validation | ✅ | `evaluateBatchNode` |
| Targeted regeneration loop (MAX_RETRIES) + blueprint conformance re-check | ✅ | `blueprintCheckNode`, `regenerateFailedNode` |
| Unknown-marks slot exemption in validation | ✅ **fixed** | `validation.agent.js`, `orchestrator.agent.js` |
| 422 contract error surfaced per-slot on the confirm screen | ✅ | `App.jsx` |
| PDF preview / download / print (pdfmake) | ✅ | `paperPdf.js`, `App.jsx` |
| Latency + AI-call instrumentation (`meta.timing`, `meta.ai`) | ✅ | `perf-context.js` |
| E2E browser scripts | ✅ (manual) | `e2e-two-step.mjs`, `e2e-browser.mjs` |

---

## 6. End-to-End Verification (live browser test)

**Scenario:** upload `uploads/samplepaper1.pdf` as the previous-year paper; CBSE Class 4 English Ch1 notes → **Unit 1**, Ch2 notes → **Unit 2**; assignment **Q1→U1, Q2→U1, Q3→U2, Q4→U2, Q5→U1**.

| Step | Result |
|---|---|
| Upload + Analyze | ✅ 5-slot blueprint extracted, LOCKED badge |
| Blueprint marks | Q1: 3 · Q2: 4 · Q3: **n/a** ("Match the following") · Q4: 5 · Q5: 10 |
| Unit 1 (CBSE Ch1) | ✅ indexed, 5 chunks |
| Unit 2 (CBSE Ch2) | ✅ indexed, 5 chunks |
| Assignment | ✅ exactly as specified, via per-row dropdowns |
| Generate | ✅ succeeded in 159 s with live per-slot progress |
| Review | ✅ paper rendered with View PDF / Download / Back to Blueprint |
| Outcome | **4/5 slots accepted**; Q3 honestly rejected (see below) |

**The bug this test caught (and how it was fixed):** Q3's marks were not parseable from the reference paper. The blueprint validator treats unknown reference marks as "skip the check," but `deterministicCheck` rejected ANY question with missing marks unconditionally → every attempt failed → 0/5 accepted. Fix: the blueprint slot is now passed into `deterministicCheck`, which exempts the marks gate when the reference has none. Server tests updated and passing (33/33).

**Why Q3 still failed (correct behavior, content limitation):** the validator rejected generated match-pairs that referenced *Tinkling Bells story characters* absent from the indexed Ch2 summary-notes chunks. The topic-grounding gate worked as designed. Remedies: upload richer Ch2 notes (with the story), or allow MATCH columns to draw from the past-paper context pool (policy change that loosens grounding).

Screenshots: `e2e-screenshots/unit-assignment-confirm.png`, `unit-assignment-review.png`.

---

## 7. 🔴 Remaining Critical / High Issues

### R1. Security posture (unchanged — highest remaining priority)

| # | Severity | Finding | Location | Recommendation |
|---|---|---|---|---|
| S1 | High | **Leaked internal Qdrant cloud URL hardcoded as default** (redacted here; was committed in the initial commit) | `server/src/config/env.js` | Default to `http://localhost:6333` (as `.env.example` does); rotate the cluster credentials |
| S2 | High | **CORS wide open** — `app.use(cors())`; the parsed `CORS_ORIGIN` config is dead code | `server/src/app.js:12` | `app.use(cors({ origin: env.CORS_ORIGIN }))` |
| S3 | Medium | **No authentication or rate limiting**; generate/ingest endpoints trigger paid Gemini calls from anyone | `app.js` | `express-rate-limit` minimum; auth if multi-user |
| S4 | Medium | `extract-text` / `extract-questions` / `embed-questions` / `index-questions` accept arbitrary `fileUrl` (SSRF surface) | `paper.controller.js` | Restrict to the storage domain / known publicIds |
| S5 | Low | No `helmet()` security headers; 10 MB JSON limit generous | `app.js` | Add `helmet()` in production |
| S6 | Low | In-memory job store / embedding cache / progress — not multi-instance safe | `job-store.js` | Documented prototype trade-off; move to Redis for scale |

Positives: secrets correctly gitignored (`.env` gitignored, `.env.example` templated), Multer enforces extension **and** MIME **and** size, client computes SHA-256 locally.

### R2. Test depth

Zero automated coverage for the agent pipeline (orchestrator, generator, validation) and routes — the most complex logic in the repo. The LLM/Qdrant boundaries are already behind services, so stubbed node-integration tests would be high-value. No ESLint anywhere (the original C1 crash would have been caught by `no-undef`).

---

## 8. Code Quality

### Strengths
- **Exceptional comments-to-code discipline** — nearly every non-obvious decision (why 10 MB JSON limit, why fallback models are LLM-only, why dedup uses full text in blueprint mode) is documented at the point of decision.
- Clean separation: routes → controllers → agents/services; agents never touch storage infra directly.
- Deterministic modules are pure and therefore fully testable.
- Sensible, consistent HTTP error semantics including the 422 contract-failure channel.

### Weaknesses

| Issue | Where | Suggestion |
|---|---|---|
| App.jsx is a ~1,200-line monolith (icons, components, export, state machine, API orchestration) | `client/src/App.jsx` | Split into `components/`, `hooks/`, `useGenerationFlow` |
| Legacy free-form flow adds a second code path | `question.controller.js` | Delete or mark API-only |
| Multer filter requires `.pdf` extension AND PDF MIME — some browsers send `application/octet-stream` | `upload.middleware.js` | Accept extension OR either PDF MIME |
| `console.log` for all server observability | throughout | Leveled logger (pino) with request IDs |
| Ad-hoc scripts at root + `scripts/` | root | Consolidate and document |
| README documents the old single-step flow | `README.md` | Refresh with two-step flow + `/kb`, `/analyze` endpoints |
| Mixed response-wrapping conventions (some `{success,message,data}`, analyze/generate unwrapped) | routes | Document per-route contracts in one place |

---

## 9. Test Assessment

| Suite | Result | Coverage focus |
|---|---|---|
| `server` (`node --test`) | ✅ **33/33** (~1 s) | blueprint contract, available-units, slot-unit-map validation, retrieval unit filtering, per-item assignment, notes & point IDs, unknown-marks validation behavior |
| `client` (`node --test`) | ✅ 12/12 (~0.1 s) | `blueprintUnits` math (default assign, running totals, mixed/unassigned) |
| `vite build` | ✅ passes | — |
| E2E browser (`e2e-two-step.mjs`) | ✅ passes (manual) | full two-step flow with real PDFs, real Gemini, real Qdrant |

**Gaps:** agent-pipeline tests (stubbed Gemini/Qdrant) · route/controller contract tests · no lint layer · E2E scripts not wired into npm scripts/CI.

---

## 10. Prioritized Recommendations

| Priority | Action | Effort | Impact |
|---|---|---|---|
| 🔴 P0 | Fix Qdrant URL default (S1) + enforce CORS_ORIGIN (S2); rotate leaked credentials | 30 min | Security hygiene |
| 🔴 P0 | Rate limiting on generate/ingest endpoints (S3) | 2–3 h | Protects paid API spend |
| 🟠 P1 | Add ESLint (`no-undef`, react-hooks) to both workspaces, wire into `npm test` | 1–2 h | Prevents the C1 class of bugs permanently |
| 🟠 P1 | Agent-pipeline tests with stubbed Gemini/Qdrant; route contract tests | 1 day | Protects the most complex logic |
| 🟠 P1 | SSRF guard on `fileUrl` endpoints (S4) | 1–2 h | Server safety |
| 🟡 P2 | Split App.jsx into components/hooks; retire legacy client path | 0.5–1 day | Maintainability |
| 🟡 P2 | Update README (two-step flow, `/kb` + `/analyze`, in-memory store caveat, call economics) | 1 h | Accuracy |
| 🟡 P2 | Multer MIME filter relax; wire `e2e-two-step.mjs` into npm scripts | 1 h | Robustness / regression safety |
| 🟢 P3 | Leveled logger, `helmet`, consolidate root scripts | 2–3 h | Operational polish |
| 🟢 P3 | Optional: allow MATCH columns to draw from past-paper context pool (would have saved Q3) | 1 h + policy review | Generation yield |

---

## 11. Bottom Line

This is now a **coherent, working end-to-end product**: upload a previous-year paper → get a locked blueprint → review it, upload syllabus notes as units, assign every question to a unit → generate with live per-slot progress → download a paper whose structure mirrors the original and whose content is grounded in your notes.

The LangGraph pipeline's cost/latency engineering (4 AI calls per 5 questions), the deterministic blueprint system, and the dual-corpus RAG design are production-thoughtful, and the quality gates demonstrably work (they caught out-of-grounding content in Q3 rather than shipping it silently).

**The next focus should be security hardening (P0) and pipeline test coverage (P1)** — both small relative to the value they protect.
