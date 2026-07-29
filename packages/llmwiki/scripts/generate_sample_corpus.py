from __future__ import annotations

import hashlib
import json
import re
from collections import OrderedDict
from pathlib import Path
from typing import Any

import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[1]
APPROVED_ROOT = PROJECT_ROOT / "enrichment" / "approved"
INPUT_ROOT = PROJECT_ROOT / "samples" / "input"
MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")


def main() -> None:
    INPUT_ROOT.mkdir(parents=True, exist_ok=True)
    expected_names: set[str] = set()
    for record_path in sorted(APPROVED_ROOT.glob("*.json")):
        record = json.loads(record_path.read_text(encoding="utf-8"))
        document_id = str(record["doc_id"])
        _normalize_non_relation_links(record)
        title = _title(document_id)
        evidence_by_section = _evidence_by_section(record)
        section_mapping = {
            old_section_id: _section_id(document_id, title, _heading(document_id, index))
            for index, old_section_id in enumerate(evidence_by_section, start=1)
        }
        metadata = _metadata(document_id, title)
        markdown = _render_markdown(
            metadata,
            document_id=document_id,
            title=title,
            evidence_by_section=evidence_by_section,
            supporting_text=_supporting_text(record),
        )
        input_path = INPUT_ROOT / f"{document_id}.md"
        input_path.write_text(markdown, encoding="utf-8", newline="\n")
        expected_names.add(input_path.name)

        _replace_section_ids(record, section_mapping)
        record["source_sha256"] = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
        record_path.write_text(
            json.dumps(record, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )

    for stale in INPUT_ROOT.glob("*.md"):
        if stale.name not in expected_names:
            stale.unlink()


def _title(document_id: str) -> str:
    if document_id == "REG-000001":
        return "정보보호 기본 규정"
    prefix, number = document_id.split("-", maxsplit=1)
    names = {"REG": "업무 규정", "MAN": "운영 매뉴얼", "REP": "점검 보고서"}
    return f"{names[prefix]} {int(number)}"


def _metadata(document_id: str, title: str) -> dict[str, Any]:
    prefix, number = document_id.split("-", maxsplit=1)
    index = int(number)
    doc_type = {"REG": "regulation", "MAN": "manual", "REP": "report"}[prefix]
    status = "active"
    if document_id in {"REG-000020", "MAN-000020"}:
        status = "archived"
    elif document_id in {"REG-000019", "MAN-000019", "REP-000010"}:
        status = "draft"
    elif document_id == "REP-000009":
        status = "superseded"
    source_sha256 = (
        f"{index:064x}"
        if document_id == "REG-000001"
        else hashlib.sha256(f"sample-source:{document_id}".encode()).hexdigest()
    )
    authority = {"REG": "regulation", "MAN": "manual", "REP": "report"}[prefix]
    return {
        "schema_version": "1.0.0",
        "id": document_id,
        "title": title,
        "doc_type": doc_type,
        "language": "ko",
        "revision": "3" if document_id == "REG-000001" else "1",
        "status": status,
        "official_number": f"{prefix}-{index:06d}",
        "authority_level": authority,
        "issuing_org": "Folding 샘플 운영팀",
        "issued_on": "2026-01-01",
        "effective_from": "2026-01-01",
        "effective_to": None,
        "source": {
            "filename": f"{document_id}.txt",
            "uri": f"source://samples/{document_id}.txt",
            "sha256": source_sha256,
            "verification": "unavailable" if document_id == "REG-000001" else "verified",
        },
        "access": "internal",
        "tags": [doc_type, "sample"],
        "aliases": [f"{document_id} 별칭 A", f"{document_id} 별칭 B"],
    }


def _evidence_by_section(record: dict[str, Any]) -> OrderedDict[str, list[str]]:
    grouped: OrderedDict[str, list[str]] = OrderedDict()

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            section_id = value.get("section_id")
            quote = value.get("quote")
            if isinstance(section_id, str) and isinstance(quote, str):
                quotes = grouped.setdefault(section_id, [])
                if quote not in quotes:
                    quotes.append(quote)
            for nested in value.values():
                visit(nested)
        elif isinstance(value, list):
            for nested in value:
                visit(nested)

    for key in ("summary", "key_points", "entities", "faq", "relations"):
        visit(record.get(key))
    if not grouped:
        raise ValueError(f"{record['doc_id']} has no grounded evidence")
    return grouped


def _supporting_text(record: dict[str, Any]) -> list[str]:
    values: list[str] = []

    def visit(value: Any, key: str | None = None) -> None:
        if isinstance(value, dict):
            for nested_key, nested in value.items():
                if nested_key not in {
                    "section_id",
                    "source_sha256",
                    "model_fingerprint",
                    "prompt_version",
                    "schema_version",
                    "doc_id",
                    "to_doc_id",
                    "relation_type",
                    "type",
                }:
                    visit(nested, nested_key)
        elif isinstance(value, list):
            for nested in value:
                visit(nested, key)
        elif isinstance(value, str) and key != "quote":
            text = _plain_link_text(value.strip())
            if text and text not in values:
                values.append(text)

    for key in ("summary", "key_points", "keywords", "entities", "faq"):
        visit(record.get(key), key)
    return values


def _render_markdown(
    metadata: dict[str, Any],
    *,
    document_id: str,
    title: str,
    evidence_by_section: OrderedDict[str, list[str]],
    supporting_text: list[str],
) -> str:
    front_matter = yaml.safe_dump(
        metadata,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
        width=1_000,
    ).rstrip()
    sections: list[str] = []
    all_evidence = {quote for quotes in evidence_by_section.values() for quote in quotes}
    for index, quotes in enumerate(evidence_by_section.values(), start=1):
        body = list(quotes)
        if index == 1:
            body.extend(text for text in supporting_text if text not in all_evidence)
        if document_id == "REG-000001":
            if index == 1:
                body.append("정보보호위원회")
            elif index == 3:
                body.append("보안사고가 의심되면 즉시 신고한다.")
        heading = [f"## {_heading(document_id, index)}", "", "\n\n".join(body)]
        if document_id == "REG-000001":
            heading = [f'<a id="art-{index}"></a>', "", *heading]
        sections.append("\n".join(heading))
    return f"---\n{front_matter}\n---\n\n# {title}\n\n" + "\n\n".join(sections) + "\n"


def _heading(document_id: str, index: int) -> str:
    if document_id == "REG-000001":
        return ("제1조 목적", "제2조 적용 범위", "제3조 기본 원칙")[index - 1]
    return f"제{index}절 근거"


def _section_id(document_id: str, title: str, heading: str) -> str:
    material = document_id + " / ".join((title, heading))
    return "sec-" + hashlib.sha256(material.encode("utf-8")).hexdigest()[:10]


def _replace_section_ids(value: Any, mapping: dict[str, str]) -> None:
    if isinstance(value, dict):
        section_id = value.get("section_id")
        if isinstance(section_id, str) and section_id in mapping:
            value["section_id"] = mapping[section_id]
        for nested in value.values():
            _replace_section_ids(nested, mapping)
    elif isinstance(value, list):
        for nested in value:
            _replace_section_ids(nested, mapping)


def _normalize_non_relation_links(record: dict[str, Any]) -> None:
    def visit(value: Any) -> None:
        if isinstance(value, dict):
            quote = value.get("quote")
            if isinstance(quote, str):
                value["quote"] = _plain_link_text(quote)
            for nested in value.values():
                visit(nested)
        elif isinstance(value, list):
            for nested in value:
                visit(nested)

    for key in ("summary", "key_points", "entities", "faq"):
        visit(record.get(key))


def _plain_link_text(value: str) -> str:
    return MARKDOWN_LINK_RE.sub(r"\1", value)


if __name__ == "__main__":
    main()
