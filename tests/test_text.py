import pytest

from app.text import IngestError, build_tsquery, clean, extract_pages


def test_tsquery_or_joins_unique_words():
    assert build_tsquery("What is the notice period, notice?") == "what | the | notice | period"


def test_tsquery_strips_operators_and_short_tokens():
    q = build_tsquery("a & b | c'); DROP TABLE x; --")
    assert q == "drop | table"
    assert all(ch.isalnum() or ch in " |" for ch in q)


def test_tsquery_empty():
    assert build_tsquery("?! is") is None


def test_clean_removes_nul_bytes():
    assert clean("a\x00b\r\nc") == "ab\nc"


def test_plain_text_is_one_page():
    pages = extract_pages("notes.md", b"# Title\n\nHello")
    assert pages == [(None, "# Title\n\nHello")]


def test_unsupported_type():
    with pytest.raises(IngestError):
        extract_pages("sheet.xlsx", b"")


def test_chunking_respects_size_and_keeps_pages():
    pytest.importorskip("langchain_text_splitters")
    from app.text import chunk_pages

    long_page = " ".join(f"Sentence number {i} is here." for i in range(200))
    drafts = chunk_pages([(1, long_page), (2, "Short but long enough to keep.")], 300, 40)
    assert len(drafts) > 3
    assert all(len(d.text) <= 300 for d in drafts)
    assert drafts[-1].page == 2
    assert [d.index for d in drafts] == list(range(len(drafts)))
