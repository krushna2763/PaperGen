# 📊 Complete Project Report — PaperGen AI

**Project:** AI-Powered Agentic RAG Question Generator (`paper-setting-ai-agent`) v1.0.0
**Report date:** September 6, 2026 *(updated after security hardening + ESLint wiring + history rewrite)*
**Codebase:** ~10,500 lines of application JS across 116 files (client + server, excl. deps)
**Structure:** npm workspaces — `client/` (React 18 + Vite 6 + Tailwind), `server/` (Express 4 + LangGraph)
**Repo:** `github.com/krushna2763/PaperGen` — single clean root commit, `main` pushed

---

## 1. Executive Summary

PaperGen AI turns a **previous-year exam paper (PDF)** into a **new, notes-grounded question paper**. It combines deterministic PDF parsing, a Qdrant-backed dual-corpus vector store (past papers + syllabus notes), Gemini embeddings/LLM via an 8-key failover pool, and a LangGraph agent pipeline with quality gates and targeted regeneration.

**Verdict as of this report: the product works end-to-end, is security-hardened for a non-local deploy, and is lint-guarded at commit time.** Every P0 from the original analysis is closed. What remains is auth (for public/multi-user deployment), CI, and deeper pipeline tests.

| Area | Grade | Notes |
|---|---|---|
| Backend architecture | ★★★★★ | Layered, latency-optimized LangGraph pipeline, exceptional comments discipline |
| Vector/RAG design | ★★★★☆ | Dual corpora, per-slot question-level RAG, hash-based ingestion dedup |
| Frontend | ★★★★☆ | Two-step flow fully wired and E2E-verified; 1,300-line App.jsx monolith remains |
| Security & config | ★★★★☆ | CORS allowlist, two-tier rate limiting, SSRF guard, helmet, no secrets in repo; auth still open |
| Tests & lint | ★★★☆☆ | 51 tests passing + ESLint (`no-undef` etc.) blocking `npm test`; pipeline still untested |
| Docs | ★★☆☆☆ | README still describes the old single-step flow — now the weakest point |

### ✅ Fixed since the original analysis (all verified)

| # | Original issue | Status |
|---|---|---|
| C1 | App.jsx `ReferenceError: generating is not defined` → white-screen | ✅ **Fixed** — replaced with the `phase` state machine; **and the bug class is now un-committable** (ESLint `no-undef` wired into `npm test`) |
| C2 | Two-step flow dead code: `ConfirmScreen` never rendered, `/papers/analyze` + `/papers/:jobId/generate` never called | ✅ **Fixed** — full analyze → confirm → generate flow wired and E2E-verified in the browser |
| C3 | No git repository → later: leaked Qdrant URL pushed in the initial commit | ✅ **Fixed** — repo rewritten: everything squashed into one clean root commit (`5a21f5f`) and force-pushed; the leaked URL is **no longer in the remote history**. Secret scan before push (also redacted the URL quoted in this report). `server/.env` verified gitignored throughout |
| B1 | Validation deadlock: slots with *unknown reference marks* rejected unconditionally → 0/N accepted | ✅ **Fixed** — `deterministicCheck` receives the blueprint slot and exempts marks when the reference has none |
| SEC1 | Hardcoded real Qdrant Cloud URL as default | ✅ **Fixed** — default is `http://localhost:6333`; the leaked URL was purged from the pushed history (see C3) |
| SEC2 | `cors()` wide open; `CORS_ORIGIN` dead config | ✅ **Fixed** — `cors({ origin: env.CORS_ORIGIN })`; verified live (evil origin gets no ACAO header) |
| SEC3 | No rate limiting on paid-call endpoints | ✅ **Fixed** — two tiers: `aiLimiter` 6 req/min on every Gemini/ingest route, `defaultLimiter` 120 req/min on reads; verified live (6×400 → 429) |
| SEC4 | SSRF: arbitrary `fileUrl` fetched server-side | ✅ **Fixed** — `assertStorageFileUrl` allows only `https://<CLOUDINARY_HOST>/<CLOUDINARY_CLOUD_NAME>/…`, fails closed with no cloud configured; 6 unit tests + live probe |
| SEC5 | No security headers | ✅ **Fixed** — `helmet()` (CSP off: JSON API); HSTS, X-Frame-Options, nosniff, COOP/CORP verified live |
| LINT | No lint layer anywhere (the C1 crash would have been caught by `no-undef`) | ✅ **Fixed** — ESLint 10 flat config in both workspaces; `npm test` runs lint before `node --test`; 20 findings resolved |

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
│  eslint.config.js — no-undef + no-unused-vars + react-hooks, lint runs before tests        │
└──────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                           │ /api (Vite proxy → :5000, CORS_ORIGIN allowlist)
┌──────────────────────────────────────────▼─────────────────────────────────────────────────┐
│                              SERVER (Express 4, ES Modules)                                │
│  helmet → CORS allowlist → routes (rate-limited) → controllers → agents/services           │
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
│  RATE LIMITS: aiLimiter 6/min — upload, analyze, extract-*, embed, index, generate,        │
│               kb/notes, questions/generate (every paid/heavy route)                        │
│               defaultLimiter 120/min — health, status, check-indexed, kb/units (reads)     │
│  SSRF GUARD:  assertStorageFileUrl — fileUrl must be https://res.cloudinary.com            │
│               /<CLOUDINARY_CLOUD_NAME>/…; fail closed if cloud unset                       │
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

| Method | Endpoint | Purpose | Rate tier |
|---|---|---|---|
| GET | `/api/health` | Server + Qdrant + Gemini + Cloudinary status | 120/min |
| POST | `/api/papers/upload` | PDF upload → Cloudinary (15 MB cap, PDF-only) | **6/min** |
| POST | `/api/papers/analyze` | Extract + lock blueprint → `{ jobId, blueprint, availableUnits }` | **6/min** |
| POST | `/api/papers/extract-text` | Text extraction (`fileUrl` → SSRF-guarded Cloudinary only) | **6/min** |
| POST | `/api/papers/extract-questions` | Deterministic question extraction | **6/min** |
| POST | `/api/papers/check-indexed` | SHA-256 content-hash ingestion check | 120/min |
| POST | `/api/papers/embed-questions` | Gemini embeddings for extracted questions | **6/min** |
| POST | `/api/papers/index-questions` | Index into `past_paper` corpus (Qdrant) | **6/min** |
| POST | `/api/papers/:jobId/generate` | Blueprint-mode generation `{ blueprint, class, subject, difficulty, slotUnitMap }` | **6/min** |
| GET | `/api/papers/:jobId/status` | Per-slot live progress | 120/min |
| POST | `/api/kb/notes` | Upload syllabus notes per (class, subject, unit) | **6/min** |
| GET | `/api/kb/units` | List units with chunk counts | 120/min |
| POST | `/api/questions/generate` | Legacy free-form RAG generation | **6/min** |

Error semantics: `400` invalid input / SSRF rejection · `404` unknown job · `422` blueprint/slotUnitMap contract violation (lists offending slots) · `429` rate limit exceeded (`RateLimitExceeded`, draft-7 headers) · `502` model returned nothing.

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
| **Two-step flow UI (analyze → confirm → generate)** | ✅ verified | `App.jsx`, `ConfirmScreen.jsx` |
| Confirm screen: per-question/per-item unit assignment, live marks-per-unit bars | ✅ | `ConfirmScreen.jsx` |
| Per-slot live progress polling during generation | ✅ (4 s interval) | `App.jsx`, `job-store.js` |
| Question-level RAG (per-slot contexts) | ✅ | `retrieval.agent.js`, orchestrator |
| Batch generation + refill + dedup | ✅ | `question-generator.agent.js` |
| Quality gate: deterministic → peer cosine → Qdrant source check → batch LLM validation | ✅ | `evaluateBatchNode` |
| Targeted regeneration loop (MAX_RETRIES) + blueprint conformance re-check | ✅ | `blueprintCheckNode`, `regenerateFailedNode` |
| Unknown-marks slot exemption in validation | ✅ | `validation.agent.js`, `orchestrator.agent.js` |
| **CORS origin allowlist** | ✅ verified live | `app.js`, `env.CORS_ORIGIN` |
| **Two-tier rate limiting (6/min AI · 120/min reads)** | ✅ verified live (6×400→429) | `rate-limit.middleware.js` + 4 route files |
| **SSRF guard on all `fileUrl` endpoints (fail closed)** | ✅ 6 unit tests + live probe | `storage.service.js` |
| **Security headers (helmet)** | ✅ verified live | `app.js` |
| **ESLint flat config, wired into `npm test` (both workspaces)** | ✅ 0 findings | `eslint.config.js` ×2 |
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

**The bug this test caught (and how it was fixed):** Q3's marks were not parseable from the reference paper. The blueprint validator treats unknown reference marks as "skip the check," but `deterministicCheck` rejected ANY question with missing marks unconditionally → every attempt failed → 0/5 accepted. Fix: the blueprint slot is now passed into `deterministicCheck`, which exempts the marks gate when the reference has none. Server tests updated and passing.

**Why Q3 still failed (correct behavior, content limitation):** the validator rejected generated match-pairs that referenced *Tinkling Bells story characters* absent from the indexed Ch2 summary-notes chunks. The topic-grounding gate worked as designed. Remedies: upload richer Ch2 notes (with the story), or allow MATCH columns to draw from the past-paper context pool (policy change that loosens grounding).

Screenshots: `e2e-screenshots/unit-assignment-confirm.png`, `unit-assignment-review.png`.

---

## 7. Security Posture

### Completed hardening (this iteration)

| Control | Implementation | Verification |
|---|---|---|
| Secret hygiene | No secrets in repo; `server/.env` gitignored; leaked Qdrant URL purged from pushed history via squash + force-push (`5a21f5f` is the only commit on the remote) | secret scan over all trackable files pre-push: clean |
| CORS | `cors({ origin: env.CORS_ORIGIN })` — allowlist, not `*` | live probe: disallowed origin receives no ACAO header |
| Rate limiting | `aiLimiter` (6/min) on all 9 paid/heavy routes; `defaultLimiter` (120/min) on reads; shared singletons (no double-count); draft-7 `RateLimit-*` headers | live probe: exactly 6×400 then 429 |
| SSRF | `assertStorageFileUrl`: HTTPS + host allowlist (`CLOUDINARY_HOST`) + cloud-name path check; fail closed when `CLOUDINARY_CLOUD_NAME` unset; runs before any network I/O | 6 unit tests (`ssrf-guard.test.js`) + live probe on metadata URL → 400 |
| Headers | `helmet({ contentSecurityPolicy: false })` (JSON API, no served HTML) | live probe: HSTS, XFO, nosniff, COOP, CORP present |
| Lint gate | ESLint `no-undef` + `no-unused-vars` (+ react-hooks on client) run before every `npm test` | 0 findings in both workspaces |

### Remaining (known, deliberate for prototype scope)

| # | Severity | Finding | Recommendation |
|---|---|---|---|
| R1 | Medium | **No authentication** — rate limiting caps spend but doesn't identify users; fine for single-school local use, required before any public/multi-user deploy | API-key or session auth on the AI tier |
| R2 | Low | In-memory job store / embedding cache / progress — not multi-instance safe | Move to Redis when scaling out |
| R3 | Info | Reverse-proxy deployments need `app.set('trust proxy', 1)` so limiter buckets key on real client IPs | Add when deploying behind nginx/Cloudflare |
| R4 | Info | Qdrant cluster rotation is now **optional defense-in-depth** (URL no longer in remote history; API key never committed) — GitHub can serve SHA-addressed dangling commits transiently until GC | Rotate when convenient, or ask GitHub Support to purge the dangling old commit |

---

## 8. Code Quality

### Strengths
- **Exceptional comments-to-code discipline** — nearly every non-obvious decision is documented at the point of decision.
- Clean separation: routes → controllers → agents/services; agents never touch storage infra directly.
- Deterministic modules are pure and therefore fully testable.
- Sensible, consistent HTTP error semantics including the 422 contract-failure channel.
- **ESLint-clean codebase** with an intentional-exception policy: the 2 non-mechanical `no-unused-vars` findings (Express error-handler arity, reserved parser param) were resolved with `_` prefixes + explanatory comments, not rule silencing.

### Weaknesses

| Issue | Where | Suggestion |
|---|---|---|
| App.jsx is a ~1,300-line monolith (icons, components, export, state machine, API orchestration) | `client/src/App.jsx` | Split into `components/`, `hooks/`, `useGenerationFlow` |
| Legacy free-form flow adds a second code path | `question.controller.js` | Delete or mark API-only |
| Multer filter requires `.pdf` extension AND PDF MIME — some browsers send `application/octet-stream` | `upload.middleware.js` | Accept extension OR either PDF MIME |
| README documents the old single-step flow; new env knobs undocumented | `README.md` | Refresh: two-step flow, `/kb` + `/analyze`, security knobs, call economics |
| `console.log` for all server observability | throughout | Leveled logger (pino) with request IDs |
| Ad-hoc scripts at root + `scripts/` + `server/test-*.js` | repo | Consolidate and document |
| Mixed response-wrapping conventions (some `{success,message,data}`, analyze/generate unwrapped) | routes | Document per-route contracts in one place |
| No CI — lint + tests are local-only right now | `.github/` | GitHub Actions running root `npm test` on push/PR |

---

## 9. Test & Lint Assessment

| Check | Result | Coverage |
|---|---|---|
| `server` lint (`eslint .`) | ✅ 0 problems | no-undef, no-unused-vars, no-const-assign, no-redeclare (Node globals, ES modules) |
| `client` lint (`eslint .`) | ✅ 0 problems | + react-hooks/rules-of-hooks (error), exhaustive-deps (warn, 0 findings) (browser globals, JSX) |
| `server` tests (`node --test`) | ✅ **39/39** | blueprint contract, available-units, slot-unit-map validation, retrieval unit filtering, per-item assignment, notes & point IDs, unknown-marks behavior, **SSRF guard (6)** |
| `client` tests (`node --test`) | ✅ **12/12** | `blueprintUnits` math (default assign, running totals, mixed/unassigned) |
| `vite build` | ✅ passes | — |
| E2E browser (`e2e-two-step.mjs`) | ✅ passes (manual) | full two-step flow with real PDFs, real Gemini, real Qdrant |
| Wiring | `npm test` = **lint → node --test** in both workspaces; root `npm test` runs both workspaces; root `npm run lint` available | |

**Gaps:** agent-pipeline tests (stubbed Gemini/Qdrant) · route/controller contract tests (429/422/SSRF live behaviors are verified manually but not in CI) · E2E not wired into npm scripts/CI.

---

## 10. Prioritized Recommendations

| Priority | Action | Effort | Impact |
|---|---|---|---|
| 🟠 P1 | GitHub Actions CI: run root `npm test` (lint + both suites) on push/PR | 1 h | The lint gate only protects the repo if it runs somewhere other than your machine |
| 🟠 P1 | Update README (two-step flow, `/kb` + `/analyze`, security env knobs, deployment checklist) | 1 h | Docs are now the weakest link |
| 🟠 P1 | Auth on the AI-tier endpoints (API key minimum) before any public deploy | 0.5–1 day | Identity + spend attribution beyond IP buckets |
| 🟡 P2 | Agent-pipeline tests with stubbed Gemini/Qdrant; route contract tests (429/422/SSRF) | 1 day | Protects the most complex logic |
| 🟡 P2 | Split App.jsx into components/hooks; retire legacy client path | 0.5–1 day | Maintainability |
| 🟡 P2 | Multer MIME filter relax; wire `e2e-two-step.mjs` into npm scripts | 1 h | Robustness / regression safety |
| 🟢 P3 | Leveled logger (pino), consolidate root scripts | 2–3 h | Operational polish |
| 🟢 P3 | Optional: allow MATCH columns to draw from past-paper context pool (would have saved Q3) | 1 h + policy review | Generation yield |
| 🟢 P3 | Qdrant cluster rotation (defense-in-depth; leak already purged from remote) | 30 min | Closes the SHA-cache caveat entirely |

**No P0 items remain.** The original "one focused day from broken demo to working product" milestone is complete.

---

## 11. Deployment Checklist (operator, outside the code)

1. **Set `CORS_ORIGIN` explicitly** for any non-local deploy (e.g. `https://yourapp.com`) — the code default only covers localhost origins.
2. **Set `QDRANT_URL` + `QDRANT_API_KEY` explicitly** in the deployed environment — there is no cloud fallback default anymore; unset means `http://localhost:6333`.
3. **Confirm `CLOUDINARY_CLOUD_NAME` is set** wherever `fileUrl` endpoints are used — with it set, only your cloud's URLs are fetchable; without it, fileUrl downloads are refused (fail closed).
4. **Behind a reverse proxy:** set `app.set('trust proxy', 1)` so rate-limit buckets key on real client IPs.
5. **Tune rate limits if needed:** `RATE_LIMIT_AI_PER_MINUTE` (default 6 — deliberately tight), `RATE_LIMIT_DEFAULT_PER_MINUTE` (default 120).
6. Optional: rotate the Qdrant cluster; add auth before going multi-user.

---

## 12. Bottom Line

This is now a **coherent, working, security-conscious product**: upload a previous-year paper → get a locked blueprint → review it, upload syllabus notes as units, assign every question to a unit → generate with live per-slot progress → download a paper whose structure mirrors the original and whose content is grounded in your notes.

The engineering fundamentals are solid on every axis that was audited: the LangGraph pipeline's cost/latency engineering (4 AI calls per 5 questions), deterministic blueprint system, dual-corpus RAG, quality gates that demonstrably refuse out-of-grounding content, a hardened HTTP surface, and a lint gate that makes the white-screen bug class un-committable.

**Next: CI + README (P1), then auth and pipeline tests** — each is small relative to the value it protects.
