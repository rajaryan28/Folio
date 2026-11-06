# Folio

A small RAG chatbot for your own documents. Every answer carries numbered citations; click one and the exact passage opens beside the conversation with the supporting sentence highlighted.

**Stack:** Python 3.12, FastAPI, PostgreSQL + pgvector, LangChain (OpenAI chat and embeddings). The UI is plain HTML, CSS and JavaScript, so there is no build step.

## Run it

```bash
cp .env.example .env          # then put your OPENAI_API_KEY in it
docker compose up --build     # Postgres with pgvector, plus the app
```

Open http://localhost:8000, then drag a PDF, Markdown or text file onto the page. `library/remote-work-handbook.md` is a sample to try first ("How much is the home office budget?").

### Without Docker for the app

```bash
docker compose up -d db
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### Index files from the command line

```bash
python -m app.cli ingest ./library            # a folder (add -r for subfolders)
python -m app.cli ingest ~/papers/report.pdf  # one file
python -m app.cli list
python -m app.cli delete 3

# with Docker:
docker compose run --rm app python -m app.cli ingest /library
```

Identical files are detected by content hash and stored once, so re-running ingest is safe.

## How it works

```
upload / CLI ──> extract text ──> split (1000 chars, 150 overlap) ──> embed ──> chunks table
                  (pypdf, per page)   RecursiveCharacterTextSplitter  OpenAIEmbeddings   vector + tsvector

question ──> rewrite with chat history ──> hybrid retrieval ──> numbered context ──> streamed answer
             (only on follow-ups)          vector (HNSW cosine)                      ChatOpenAI, SSE
                                           + full-text (GIN), fused with RRF
```

- **Hybrid retrieval** (`app/rag.py`): pgvector cosine search and Postgres full-text search run separately and are merged with reciprocal rank fusion. Vectors catch paraphrases; keywords catch names, codes and numbers.
- **Citations:** the model is told to cite passages as `[n]`. The browser turns these into buttons, lists only the sources actually cited under the answer, and highlights the sentence in the passage that best overlaps the claim.
- **Scope:** each document in the library has a checkbox. Unticked documents are excluded from search.
- **Nothing relevant?** If retrieval finds nothing, the model isn't called at all. If passages exist but don't answer the question, the prompt makes it say so instead of guessing.
- **Passages are treated as untrusted text**, and the prompt tells the model to ignore instructions found inside documents.

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` | | Required |
| `CHAT_MODEL` | `gpt-4o-mini` | Any OpenAI chat model. If it rejects `temperature`, set `CHAT_TEMPERATURE=-1` |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | |
| `EMBEDDING_DIM` | `1536` | Keep at or below 2000 (HNSW limit). Changing it after indexing needs a fresh database |
| `OPENAI_BASE_URL` | | Any OpenAI-compatible endpoint |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `1000` / `150` | Characters |
| `RETRIEVAL_K` | `6` | Passages sent to the model |
| `MIN_SIMILARITY` | `0.15` | Floor for vector hits. Raise it for stricter matching |
| `FTS_CONFIG` | `english` | Postgres text search language, e.g. `german`, `simple` |
| `MAX_UPLOAD_MB` | `25` | |

## API

| | |
|---|---|
| `GET /api/documents` | List documents |
| `POST /api/documents` | Multipart upload, field `files` |
| `DELETE /api/documents/{id}` | Remove a document and its passages |
| `POST /api/chat` | `{question, history, document_ids}`, streams server-sent events: `sources`, `token`, `done`, `error` |
| `GET /api/health` | Counts and model names |

Interactive docs at `/docs`.

## Layout

```
app/
  main.py      routes and SSE streaming
  rag.py       HybridRetriever, prompts, streaming pipeline
  ingest.py    file -> chunks -> embeddings -> Postgres
  text.py      extraction, chunking, query building (no I/O)
  models.py    documents and chunks tables, HNSW + GIN indexes
  cli.py       ingest / list / delete
  static/      index.html, styles.css, app.js
tests/         pytest (pure text helpers)
```

## Known limits

- Scanned PDFs have no text layer and are rejected with a clear message; run OCR first.
- Tables inside PDFs are flattened to text.
- Conversation history lives in the browser (localStorage), not the database.
- There is no authentication. Put it behind a reverse proxy before exposing it.
- The UI loads Newsreader and Schibsted Grotesk from Google Fonts and falls back to system serif and sans fonts when offline.
