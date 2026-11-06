"""Command line tools.

    python -m app.cli ingest ./library          index every PDF/MD/TXT in a folder
    python -m app.cli ingest report.pdf         index a single file
    python -m app.cli list                      show what's indexed
    python -m app.cli delete 3                  remove a document
"""
import argparse
import asyncio
import sys
from pathlib import Path

from sqlalchemy import delete, select

from app.db import SessionLocal, engine, init_db
from app.ingest import ingest_bytes
from app.models import Document
from app.rag import build_embeddings, explain_error
from app.text import SUPPORTED, IngestError


def _collect(path: Path, recursive: bool) -> list[Path]:
    if path.is_file():
        return [path]
    pattern = "**/*" if recursive else "*"
    return sorted(p for p in path.glob(pattern) if p.is_file() and p.suffix.lower() in SUPPORTED)


async def cmd_ingest(args: argparse.Namespace) -> int:
    target = Path(args.path).expanduser()
    if not target.exists():
        print(f"No such file or folder: {target}", file=sys.stderr)
        return 1
    files = _collect(target, args.recursive)
    if not files:
        print("Nothing to index. Supported types: PDF, Markdown, plain text.")
        return 0

    await init_db()
    embeddings = build_embeddings()
    failures = 0
    for path in files:
        try:
            result = await ingest_bytes(path.name, path.read_bytes(), embeddings)
            if result.created:
                print(f"added      {path.name}  ({result.document.chunk_count} passages)")
            else:
                print(f"unchanged  {path.name}")
        except IngestError as exc:
            failures += 1
            print(f"failed     {path.name}  {exc}")
        except Exception as exc:
            failures += 1
            print(f"failed     {path.name}  {explain_error(exc)}")
    return 1 if failures else 0


async def cmd_list(_: argparse.Namespace) -> int:
    await init_db()
    async with SessionLocal() as session:
        docs = (await session.scalars(select(Document).order_by(Document.id))).all()
    if not docs:
        print("The library is empty.")
    for d in docs:
        pages = f"{d.pages} pages, " if d.pages else ""
        print(f"{d.id:>4}  {d.filename}  ({pages}{d.chunk_count} passages)")
    return 0


async def cmd_delete(args: argparse.Namespace) -> int:
    await init_db()
    async with SessionLocal() as session:
        result = await session.execute(delete(Document).where(Document.id == args.id))
        await session.commit()
    print("Removed." if result.rowcount else f"No document with id {args.id}.")
    return 0 if result.rowcount else 1


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    ingest = sub.add_parser("ingest", help="index a file or a folder")
    ingest.add_argument("path")
    ingest.add_argument("-r", "--recursive", action="store_true", help="include subfolders")
    ingest.set_defaults(func=cmd_ingest)

    sub.add_parser("list", help="list indexed documents").set_defaults(func=cmd_list)

    delete_cmd = sub.add_parser("delete", help="remove a document by id")
    delete_cmd.add_argument("id", type=int)
    delete_cmd.set_defaults(func=cmd_delete)

    args = parser.parse_args()

    async def run() -> int:
        try:
            return await args.func(args)
        finally:
            await engine.dispose()

    sys.exit(asyncio.run(run()))


if __name__ == "__main__":
    main()
