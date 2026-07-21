"""Hard cap on line length, so a quote never has to be cut at an arbitrary offset.

Downstream evidence extraction works in a few hundred characters. A single
700-character line either overflows that budget or gets sliced mid-word, so the
break is made here instead — at a point where a reader would already have paused.
"""

from __future__ import annotations

import re

from app.postprocess import MAX_LINE_CHARS, wrap_long_lines


def widest(text: str) -> int:
    return max((len(line) for line in text.splitlines()), default=0)


def test_every_line_lands_under_the_cap():
    text = "가나다라마바사아자차 " * 200
    assert widest(wrap_long_lines(text)) <= MAX_LINE_CHARS


def test_short_text_is_untouched():
    text = "짧은 줄입니다.\n\n두 번째 문단."
    assert wrap_long_lines(text) == text


def test_no_character_is_lost():
    text = ("이것은 첫 번째 문장입니다. " * 40).strip()
    joined = re.sub(r"\s+", "", wrap_long_lines(text))

    assert joined == re.sub(r"\s+", "", text)


def test_break_prefers_a_sentence_boundary():
    text = "문장 하나입니다. " * 60
    for line in wrap_long_lines(text).splitlines()[:-1]:
        assert line.endswith("."), f"broke mid-sentence: ...{line[-25:]!r}"


def test_break_falls_back_to_a_space_when_no_sentence_end():
    text = "단어 " * 300  # no punctuation anywhere
    for line in wrap_long_lines(text).splitlines():
        assert len(line) <= MAX_LINE_CHARS
    assert "단어단어" not in wrap_long_lines(text)


def test_unbroken_run_is_still_capped():
    """No spaces at all — the cap must hold even with nowhere good to break."""
    text = "가" * 1200
    out = wrap_long_lines(text)

    assert widest(out) <= MAX_LINE_CHARS
    assert out.replace("\n", "") == text


# --------------------------------------------------------------------------
# structure that a line break would destroy
# --------------------------------------------------------------------------


def test_long_table_rows_are_never_split():
    """Splitting a row stops it being a table — that would undo repair_tables."""
    row = "| " + "셀 내용 " * 200 + "|"
    assert len(row) > MAX_LINE_CHARS
    assert wrap_long_lines(row) == row


def test_table_survives_wrapping_intact():
    md = "| 항목 | " + "긴 설명 " * 150 + "|\n| --- | --- |\n| 재료비 | 1,000 |"
    out = wrap_long_lines(md)

    assert out == md
    assert all(line.startswith("|") for line in out.splitlines())


def test_fenced_code_is_left_alone():
    code = "x = " + "1234567890" * 60
    md = f"```python\n{code}\n```"

    assert wrap_long_lines(md) == md


def test_wrapping_is_idempotent():
    text = "문장입니다. " * 200
    once = wrap_long_lines(text)
    assert wrap_long_lines(once) == once


def test_real_corpus_has_no_overlong_prose_line():
    from pathlib import Path

    out_dir = Path("output")
    if not out_dir.exists():
        return
    for f in sorted(out_dir.rglob("*.md")):
        for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if len(line) > MAX_LINE_CHARS:
                assert line.strip().startswith("|"), (
                    f"{f.name}:{i} is {len(line)} chars and is not a table row"
                )
