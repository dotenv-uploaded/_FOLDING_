"""공유 엔티티로 간선을 유도하는 규칙.

명시적 링크가 없는 문서 묶음(변환된 실제 문서가 그렇다)에서 그래프가 점만 남지 않도록,
같은 엔티티를 공유하는 문서를 잇는다. 흔한 엔티티가 전부를 전부에 잇는 N² 폭발을 막는
두 가지 안전장치(흔한 엔티티 제외·문서당 상한)를 못 박아 둔다.
"""

from __future__ import annotations

from typing import Any

from wiki_builder.config import WikiConfig, load_config
from wiki_builder.corpus import infer_entity_links
from wiki_builder.models import Link


def _config(**entity_links: Any) -> WikiConfig:
    config = load_config()
    config.raw["entity_links"] = {"enabled": True, **entity_links}
    return config


def _entity(name: str, section: str, etype: str = "topic") -> dict[str, Any]:
    return {"name": name, "type": etype, "evidence": [{"section_id": section, "quote": name}]}


def _doc(*entities: dict[str, Any]) -> dict[str, Any]:
    return {"entities": list(entities)}


def test_공유_엔티티가_있으면_잇는다() -> None:
    approved = {
        "DOC-A": _doc(_entity("데이터과학부", "sec-0000000001")),
        "DOC-B": _doc(_entity("데이터과학부", "sec-0000000002")),
        "DOC-C": _doc(_entity("전혀다른것", "sec-0000000003")),
    }
    links = infer_entity_links(_config(), approved, [])
    pairs = {frozenset((link.from_doc_id, link.to_doc_id)) for link in links}
    assert frozenset(("DOC-A", "DOC-B")) in pairs
    assert frozenset(("DOC-A", "DOC-C")) not in pairs
    assert all(link.origin == "entity-overlap" for link in links)


def test_꺼져_있으면_아무것도_만들지_않는다() -> None:
    approved = {
        "DOC-A": _doc(_entity("공유", "sec-0000000001")),
        "DOC-B": _doc(_entity("공유", "sec-0000000002")),
    }
    config = load_config()
    config.raw["entity_links"] = {"enabled": False}
    assert infer_entity_links(config, approved, []) == []


def test_너무_흔한_엔티티는_제외한다() -> None:
    # "FLAG" 처럼 거의 모든 문서에 나오는 엔티티는 판별력이 없다 — 전부를 전부에 잇는다.
    approved = {
        f"DOC-{i}": _doc(_entity("FLAG", f"sec-00000000{i:02d}")) for i in range(6)
    }
    links = infer_entity_links(_config(max_entity_docs=3), approved, [])
    assert links == []


def test_문서당_상한이_전체_간선을_제한한다() -> None:
    # 문서당 상한은 각 문서가 **제안**하는 간선 수를 제한한다. 그래서 전체 간선은
    # (문서 수 × 상한) 이하로 묶여 N² 폭발이 안 난다. 허브의 차수 자체는 스포크들이 각자
    # 제안해 상한을 넘을 수 있는데, 그건 실제 구조(허브)라 막지 않는다.
    #
    # 6개 문서가 서로 다른 엔티티로 완전히 얽힌 경우(가능한 쌍 15개)로 상한이 무는지 본다.
    docs = [f"DOC-{i}" for i in range(6)]
    approved = {doc_id: _doc() for doc_id in docs}
    marker = 0
    for i in range(6):
        for j in range(i + 1, 6):
            name = f"엔티티{marker}"
            marker += 1
            approved[docs[i]]["entities"].append(_entity(name, f"sec-30000000{i}{j}"))
            approved[docs[j]]["entities"].append(_entity(name, f"sec-40000000{i}{j}"))
    links = infer_entity_links(_config(max_per_doc=2), approved, [])
    assert len(links) < 15  # 완전그래프보다 적다 — 상한이 실제로 잘랐다
    assert len(links) <= 6 * 2  # 안전 상한(문서 수 × 상한)


def test_이미_있는_링크는_중복하지_않는다() -> None:
    approved = {
        "DOC-A": _doc(_entity("공유", "sec-0000000001")),
        "DOC-B": _doc(_entity("공유", "sec-0000000002")),
    }
    existing = [
        Link(
            from_doc_id="DOC-A",
            from_section_id="sec-0000000001",
            to_doc_id="DOC-B",
            evidence_quote="공유",
        )
    ]
    assert infer_entity_links(_config(), approved, existing) == []


def test_근거_섹션이_없는_엔티티는_건너뛴다() -> None:
    approved = {
        "DOC-A": _doc({"name": "근거없음", "type": "topic", "evidence": []}),
        "DOC-B": _doc({"name": "근거없음", "type": "topic", "evidence": []}),
    }
    assert infer_entity_links(_config(), approved, []) == []
