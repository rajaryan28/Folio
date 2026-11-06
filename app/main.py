import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import engine, get_session, init_db
from app.ingest import ingest_bytes
from app.models import Chunk, Document
from app.rag import RagPipeline, explain_error
from app.schemas import ChatRequest, DocumentOut, UploadItem, UploadResponse
from app.text import IngestError

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")
log = logging.getLogger("folio")
settings = get_settings()
STATIC = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    app.state.rag = RagPipeline()
    if not settings.openai_api_key.get_secret_value():
        log.warning("OPENAI_API_KEY is not set. Uploading and asking will fail until it is.")
    yield
    await engine.dispose()


app = FastAPI(title="Folio", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
async def health(session: AsyncSession = Depends(get_session)):
    documents = await session.scalar(select(func.count(Document.id)))
    chunks = await session.scalar(select(func.count(Chunk.id)))
    return {
        "ok": True,
        "documents": documents,
        "passages": chunks,
        "chat_model": settings.chat_model,
        "embedding_model": settings.embedding_model,
    }


@app.get("/api/documents", response_model=list[DocumentOut])
async def list_documents(session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(
        select(Document).order_by(Document.created_at.desc(), Document.id.desc())
    )
    return list(rows)


@app.post("/api/documents", response_model=UploadResponse)
async def upload_documents(request: Request, files: list[UploadFile] = File(...)):
    rag: RagPipeline = request.app.state.rag
    limit = settings.max_upload_mb * 1024 * 1024
    results: list[UploadItem] = []

    for upload in files:
        name = Path(upload.filename or "untitled").name
        try:
            data = await upload.read()
            if len(data) > limit:
                raise IngestError(f"This file is larger than {settings.max_upload_mb} MB.")
            outcome = await ingest_bytes(name, data, rag.embeddings)
            results.append(
                UploadItem(
                    filename=name,
                    status="added" if outcome.created else "duplicate",
                    document=DocumentOut.model_validate(outcome.document),
                )
            )
        except IngestError as exc:
            results.append(UploadItem(filename=name, status="failed", error=str(exc)))
        except Exception as exc:
            log.exception("Indexing %s failed", name)
            results.append(UploadItem(filename=name, status="failed", error=explain_error(exc)))
    return UploadResponse(results=results)


@app.delete("/api/documents/{document_id}", status_code=204)
async def delete_document(document_id: int, session: AsyncSession = Depends(get_session)):
    result = await session.execute(delete(Document).where(Document.id == document_id))
    await session.commit()
    if result.rowcount == 0:
        raise HTTPException(404, "That document no longer exists.")


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.post("/api/chat")
async def chat(body: ChatRequest, request: Request):
    rag: RagPipeline = request.app.state.rag
    history = [t.model_dump() for t in body.history]

    async def events():
        try:
            async for event, data in rag.stream(body.question, history, body.document_ids):
                yield _sse(event, data)
        except Exception as exc:
            log.exception("Chat failed")
            yield _sse("error", {"message": explain_error(exc)})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
