# AI-Powered Agentic RAG Question Generator (Prototype)

An experimental mini-prototype demonstrating the core Agentic RAG workflow:
- Extracting concepts from previous-year question papers
- Vectorizing and storing in Qdrant
- Semantic context retrieval
- Generating **new** questions without duplicating or slightly rephrasing source questions
- Semantic similarity checks and quality validation with targeted per-question regeneration loops.

---

## 🛠️ Tech Stack

- **Frontend**: React, Vite, Tailwind CSS, Lucide Icons, Axios
- **Backend**: Node.js, Express.js (ES Modules)
- **Agent Orchestration**: LangGraph.js (`@langchain/langgraph`) — retrieve → generate → evaluate nodes with a conditional regeneration loop
- **Vector DB**: Qdrant
- **File Storage**: Modular Storage Service (Cloudinary configured via `.env`)
- **AI / LLM**: Modular LLM & Embeddings services (multi-key failover pool, fast-fail retries)

---

## 📁 Directory Structure

```
paper-setting-ai-agent/
│
├── client/                     # React + Vite Frontend
│   ├── src/
│   │   ├── components/         # UI components
│   │   ├── services/           # API integration (api.js)
│   │   ├── App.jsx             # Main dashboard
│   │   ├── index.css           # Tailwind styles
│   │   └── main.jsx
│   ├── vite.config.js
│   ├── tailwind.config.js
│   └── package.json
│
├── server/                     # Node.js + Express Backend
│   ├── src/
│   │   ├── agents/             # Modular Agents (Orchestrator, Retrieval, Generator, Similarity, Validation)
│   │   ├── document/           # PDF parsing, cleaning, question extraction
│   │   ├── rag/                # Chunker, Embeddings, Qdrant client, Retriever
│   │   ├── services/           # Storage (Cloudinary), LLM services
│   │   ├── controllers/        # Express route controllers
│   │   ├── routes/             # API routes
│   │   ├── config/             # Environment configuration (env.js)
│   │   ├── app.js              # Express app setup
│   │   └── server.js           # Server entry point
│   ├── .env                    # Server environment variables
│   └── package.json
│
├── uploads/                    # Local temporary upload directory
├── .env.example                # Sample environment template
├── .gitignore
├── package.json                # Root package with workspace scripts
└── README.md
```

---

## 🚀 Getting Started

### 1. Install Dependencies
Run from the root directory:
```bash
npm run install:all
```
*Or install in each directory individually:*
```bash
cd server && npm install
cd ../client && npm install
```

### 2. Environment Configuration
Copy `.env.example` to `server/.env` and fill in your API credentials:
```bash
cp .env.example server/.env
```

### 3. Run Development Servers
From the root directory, run both frontend and backend concurrently:
```bash
npm run dev
```

Or run them individually in separate terminals:
- **Backend (Port 5000)**:
  ```bash
  cd server
  npm run dev
  ```
- **Frontend (Port 5173)**:
  ```bash
  cd client
  npm run dev
  ```

---

## 📡 API Endpoints

- `GET /api/health` — Backend health check & configuration status
- `POST /api/papers/upload` — Upload previous-year paper (PDF → Cloudinary)
- `POST /api/papers/extract-text` — Extract & clean PDF text
- `POST /api/papers/extract-questions` — Deterministic question extraction (1 question = 1 chunk)
- `POST /api/papers/embed-questions` — Gemini embeddings per question
- `POST /api/papers/index-questions` — Index embedded questions into Qdrant
- `POST /api/questions/generate` — **Agentic RAG Question Generation pipeline** (retrieval → generation → similarity → validation → targeted regeneration)

```bash
# Example generation request
curl -X POST http://localhost:5000/api/questions/generate \
  -H "Content-Type: application/json" \
  -d '{"class":"10","subject":"Science","topic":"Life Processes","difficulty":"Medium","questionCount":5}'
```

### Agent Layer (Modules 7-11)

- `server/src/agents/retrieval.agent.js` — builds semantic query, retrieves context pool from Qdrant
- `server/src/agents/question-generator.agent.js` — generates new questions (strict no-copy/no-paraphrase) with difficulty control
- `server/src/agents/similarity.agent.js` — source + peer duplicate detection via semantic embeddings (`SIMILARITY_THRESHOLD`)
- `server/src/agents/validation.agent.js` — LLM quality validation (class/subject/difficulty/relevance/completeness)
- `server/src/agents/orchestrator.agent.js` — LangGraph StateGraph: `retrieve → generate → evaluate ⇄ regenerate` (regenerates only failed questions up to `MAX_RETRIES`)
- `server/src/rag/retriever.js` — Qdrant semantic search with metadata filtering
