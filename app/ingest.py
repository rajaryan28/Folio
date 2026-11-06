import asyncio
import hashlib
import logging
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import insert, select

from app.config import get_settings
from app.db import SessionLocal
from app.models import Chunk, Document
from app.text import SUPPORTED, IngestError, chunk_pages, extract_pages

log = logging.getLogger("folio.ingest")
settings = get_settings()

EMBED_BATCH = 128
INSERT_BATCH = 200


@dataclass
class IngestResult:
    document: Document
    created: bool


async def ingest_bytes(filename: str, data: bytes, embeddings) -> IngestResult:
    """Read, chunk, embed and store one file. Identical content is stored once."""
    filename = Path(filename).name or "untitled"
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED:
        raise IngestError("Only PDF, Markdown and plain-text files are supported.")
    if not data:
        raise IngestError("This file is empty.")

    digest = hashlib.sha256(data).hexdigest()
    async with SessionLocal() as session:
        existing = (
            await session.execute(select(Document).where(Document.content_hash == digest))
        ).scalar_one_or_none()
        if existing:
            return IngestResult(existing, created=False)

    pages = await asyncio.to_thread(extract_pages, filename, data)
    drafts = chunk_pages(pages, settings.chunk_size, settings.chunk_overlap)
    if not drafts:
        raise IngestError("No readable text found. Scanned PDFs need OCR before they can be added.")

    vectors: list[list[float]] = []
    for start in range(0, len(drafts), EMBED_BATCH):
        batch = [d.text for d in drafts[start : start + EMBED_BATCH]]
        vectors.extend(await embeddings.aembed_documents(batch))

    async with SessionLocal() as session:
        document = Document(
            filename=filename,
            content_hash=digest,
            size_bytes=len(data),
            pages=len(pages) if suffix == ".pdf" else None,
            chunk_count=len(drafts),
        )
        session.add(document)
        await session.flush()

        rows = [
            {
                "document_id": document.id,
                "chunk_index": draft.index,
                "page": draft.page,
                "content": draft.text,
                "embedding": vector,
            }
            for draft, vector in zip(drafts, vectors, strict=True)
        ]
        for start in range(0, len(rows), INSERT_BATCH):
            await session.execute(insert(Chunk), rows[start : start + INSERT_BATCH])
        await session.commit()
        await session.refresh(document)

    log.info("Indexed %s: %d passages", filename, len(drafts))
    return IngestResult(document, created=True)
