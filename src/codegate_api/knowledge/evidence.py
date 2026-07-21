from __future__ import annotations

import re
from dataclasses import dataclass


class CanonicalEvidenceError(ValueError):
    """Raised when stable section anchors cannot be indexed unambiguously."""


@dataclass(frozen=True, slots=True)
class CanonicalSection:
    section_id: str
    heading_path: tuple[str, ...]
    body: str


_HTML_ANCHOR = re.compile(
    r"^\s*<a\s+id=[\"'](?P<id>[0-9A-Za-z][0-9A-Za-z._:-]{0,127})[\"']\s*></a>\s*$"
)
_HEADING = re.compile(r"^(?P<marks>#{1,6})[ \t]+(?P<title>.+?)[ \t]*$")
_INLINE_ANCHOR = re.compile(r"[ \t]+\{#(?P<id>[0-9A-Za-z][0-9A-Za-z._:-]{0,127})\}[ \t]*$")


def build_section_index(markdown: str) -> dict[str, CanonicalSection]:
    lines = markdown.splitlines()
    heading_stack: list[tuple[int, str]] = []
    headings: list[tuple[int, int, str | None, tuple[str, ...]]] = []
    pending_anchor: str | None = None
    seen_anchors: set[str] = set()

    for line_number, line in enumerate(lines):
        anchor_match = _HTML_ANCHOR.fullmatch(line)
        if anchor_match:
            anchor = anchor_match.group("id")
            if pending_anchor is not None:
                raise CanonicalEvidenceError("multiple anchors precede one heading")
            if anchor in seen_anchors:
                raise CanonicalEvidenceError(f"duplicate section anchor: {anchor}")
            pending_anchor = anchor
            seen_anchors.add(anchor)
            continue

        heading_match = _HEADING.fullmatch(line)
        if heading_match:
            level = len(heading_match.group("marks"))
            title = heading_match.group("title").strip()
            inline_match = _INLINE_ANCHOR.search(title)
            inline_anchor = inline_match.group("id") if inline_match else None
            if inline_match:
                title = title[: inline_match.start()].rstrip()
            if not title:
                raise CanonicalEvidenceError("section heading title is empty")
            if pending_anchor and inline_anchor and pending_anchor != inline_anchor:
                raise CanonicalEvidenceError("HTML and Markdown section anchors disagree")
            section_id = inline_anchor or pending_anchor
            if inline_anchor:
                if inline_anchor in seen_anchors and inline_anchor != pending_anchor:
                    raise CanonicalEvidenceError(f"duplicate section anchor: {inline_anchor}")
                seen_anchors.add(inline_anchor)
            pending_anchor = None
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            heading_stack.append((level, title))
            heading_path = tuple(item[1] for item in heading_stack)
            headings.append((line_number, level, section_id, heading_path))
            continue

        if pending_anchor is not None and line.strip():
            raise CanonicalEvidenceError("section anchor is not followed by a heading")

    if pending_anchor is not None:
        raise CanonicalEvidenceError("section anchor is not followed by a heading")

    sections: dict[str, CanonicalSection] = {}
    for index, (line_number, level, section_id, heading_path) in enumerate(headings):
        if section_id is None:
            continue
        end = len(lines)
        for next_line, next_level, _, _ in headings[index + 1 :]:
            if next_level <= level:
                end = next_line
                break
        sections[section_id] = CanonicalSection(
            section_id=section_id,
            heading_path=heading_path,
            body="\n".join(lines[line_number + 1 : end]),
        )
    return sections
