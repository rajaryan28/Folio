"""Pure text helpers: extraction, chunking and query building. No database here."""
import io
import re
from dataclasses import dataclass
from pathlib import Path

SUPPORTED = {".pdf", ".txt", ".md", ".markdown"}


class IngestError(Exception):
    """A problem with a file that the person can understand and act on."""


@dataclass
class ChunkDraft:
    index: int
    page: int | None
    text: str


def clean(text: str) -> str:
    # Postgres rejects NUL bytes in text columns.
    return text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")


def _reflow_pdf(text: str) -> str:
    text = re.sub(r"-\n(?=[a-z])", "", text)          # re-join hyphenated line breaks
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)       # single newlines are wrapping, not structure
    text = re.sub(r"[ \t]{2,}", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def extract_pages(filename: str, data: bytes) -> list[tuple[int | None, str]]:
    suffix = Path(filename).suffix.lower()
    if suffix == ".pdf":
        from pypdf import PdfReader

        try:
            reader = PdfReader(io.BytesIO(data))
            if reader.is_encrypted and not reader.decrypt(""):
                raise IngestError("This PDF is password protected.")
            pages = []
            for number, page in enumerate(reader.pages, start=1):
                pages.append((number, _reflow_pdf(clean(page.extract_text() or ""))))
            return pages
        except IngestError:
            raise
        except Exception as exc:  # pypdf raises many things for damaged files
            raise IngestError("Couldn't read this PDF. It may be damaged.") from exc
    if suffix in {".txt", ".md", ".markdown"}:
        return [(None, clean(data.decode("utf-8", errors="replace")).strip())]
    raise IngestError("Only PDF, Markdown and plain-text files are supported.")


def chunk_pages(
    pages: list[tuple[int | None, str]], size: int, overlap: int
) -> list[ChunkDraft]:
    from langchain_text_splitters import RecursiveCharacterTextSplitter

    splitter = RecursiveCharacterTextSplitter(chunk_size=size, chunk_overlap=overlap)
    drafts: list[ChunkDraft] = []
    for page, text in pages:
        if not text.strip():
            continue
        for piece in splitter.split_text(text):
            piece = piece.strip()
            if len(piece) >= 20:
                drafts.append(ChunkDraft(index=len(drafts), page=page, text=piece))
    return drafts


def build_tsquery(question: str) -> str | None:
    """OR together the meaningful words of a question for Postgres full-text search.

    Words are restricted to [a-z0-9], so the result is safe to pass to to_tsquery().
    Stop words are dropped by Postgres itself.
    """
    words = re.findall(r"[a-z0-9]{3,}", question.lower())
    unique = list(dict.fromkeys(words))[:24]
    return " | ".join(unique) or None
