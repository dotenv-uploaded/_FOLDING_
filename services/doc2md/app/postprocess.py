"""Deterministic, safe cleanups applied to converted markdown before it is
wrapped with frontmatter.

Only transforms that cannot corrupt correct content live here:
  1. strip_image_refs     — drop dangling ![alt](file) image references
  2. collapse_glyph_runs  — undo PDF layered-glyph garble (실실실…→실)
  3. strip_empty_tables   — drop layout tables that came through fully blank
  4. promote_title        — give the doc an H1 when it lacks one, and report the title

Heading *levels* are not this module's concern: clean() hands its result to
structure.normalize_headings, which enforces the invariants the downstream wiki
builder needs (one H1, a non-empty H2, no level jumps).

Intentionally NOT done (too risky to guess, would make output worse):
  - splitting a table cell whose rows were flattened during extraction
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app import structure

# PDF layered-glyph garble repeats *every* character ~10-15x in a row
# (실실실…실시시시…시  →  실시). We undo it in three tiers, each tuned so it
# cannot touch legitimate content or markdown structure:
#   - letters (Hangul/Latin): 4+  — real words never repeat one letter 4x
#   - other punctuation (e.g. the "[" in "[BIM]"): 6+, and never -,|,= which
#     markdown rules/table separators are built from
#   - spaces: 6+  — collapse only the extreme runs the garble produces
_GLYPH_LETTER = re.compile(r"([가-힣ㄱ-ㅎㅏ-ㅣA-Za-z])\1{3,}")
_GLYPH_PUNCT = re.compile(r"([^\w\s\-|=])\1{5,}")
_SPACE_RUN = re.compile(r" {6,}")


def collapse_glyph_runs(text: str) -> str:
    text = _GLYPH_LETTER.sub(r"\1", text)
    text = _GLYPH_PUNCT.sub(r"\1", text)
    text = _SPACE_RUN.sub(" ", text)
    return text


# markitdown emits `![alt](original_filename.jpg)` for every picture shape, but
# we never save that image anywhere (no disk write, no base64, no cache) — the
# reference is dangling from the moment it's written. Only OCR'd text should
# represent what was in an image, so the raw reference is pure noise; drop it.
_IMAGE_REF = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_EXCESS_BLANK_LINES = re.compile(r"\n{3,}")


def strip_image_refs(text: str) -> str:
    text = _IMAGE_REF.sub("", text)
    return _EXCESS_BLANK_LINES.sub("\n\n", text)


def _is_table_row(s: str) -> bool:
    s = s.strip()
    return len(s) >= 2 and s.startswith("|") and s.endswith("|")


def _is_separator_row(s: str) -> bool:
    cells = [c.strip() for c in s.strip().strip("|").split("|")]
    return bool(cells) and all(re.fullmatch(r":?-+:?", c or "") for c in cells)


def _cells(row: str) -> list[str]:
    return [c.strip() for c in row.strip().strip("|").split("|")]


def strip_empty_tables(text: str) -> str:
    lines = text.splitlines()
    out: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        if _is_table_row(lines[i]):
            j = i
            block: list[str] = []
            while j < n and _is_table_row(lines[j]):
                block.append(lines[j])
                j += 1
            data = [
                c
                for row in block
                if not _is_separator_row(row)
                for c in _cells(row)
            ]
            if data and all(c == "" for c in data):
                # fully-empty table: drop it (and a trailing blank line if any)
                if j < n and lines[j].strip() == "":
                    j += 1
            else:
                out.extend(block)
            i = j
        else:
            out.append(lines[i])
            i += 1
    return "\n".join(out)


_BRACKET_TITLE = re.compile(r"^\s*[<〈《\[]\s*(.+?)\s*[>〉》\]]\s*$")


@dataclass
class TitleResult:
    text: str
    title: str | None


def promote_title(text: str) -> TitleResult:
    """Determine the document title from its first substantive line and make
    sure that line is an H1.

    The FIRST real line wins — not the first ``# `` found anywhere — because
    extraction often mis-promotes a mid-document note to H1 while the true
    title sits as plain text at the very top (a banner like ``< … >`` or a
    cover line). Skips blank lines, HTML comments, images, and leading tables.
    """
    lines = text.splitlines()

    for i, ln in enumerate(lines):
        s = ln.strip()
        if not s or s.startswith("![") or s.startswith("<!--") or _is_table_row(s):
            continue

        if s.startswith("#"):
            # First real line is already a heading: trust its text as the title.
            title = s.lstrip("#").strip()
            return TitleResult(text, title or None)

        # First real line is plain text — this is the title banner/cover.
        m = _BRACKET_TITLE.match(s)
        title = (m.group(1) if m else s).strip()
        if 2 <= len(title) <= 80:
            lines[i] = f"# {title}"
            return TitleResult("\n".join(lines), title)
        return TitleResult(text, None)

    return TitleResult(text, None)


@dataclass
class CleanResult:
    body: str
    title: str | None
    headings: structure.HeadingReport


def clean(body: str) -> CleanResult:
    body = strip_image_refs(body)
    body = collapse_glyph_runs(body)
    body = strip_empty_tables(body)
    titled = promote_title(body)
    # Title discovery only guarantees the *first* line is a heading. Enforcing
    # the invariants the wiki builder needs (one H1, a non-empty H2, no level
    # jumps) is structure.py's job.
    normalized = structure.normalize_headings(titled.text, titled.title)
    return CleanResult(
        body=normalized.body,
        title=titled.title,
        headings=normalized.report,
    )
