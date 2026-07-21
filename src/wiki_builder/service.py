from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from wiki_builder.builder import BuildResult, build_wiki
from wiki_builder.config import WikiConfig, WikiScope
from wiki_builder.enrichment import EnrichmentRun, enrich_documents
from wiki_builder.errors import ValidationError
from wiki_builder.io_utils import CURRENT_NOT_CHECKED
from wiki_builder.schemas import validate_record
from wiki_builder.state import load_current_build
from wiki_builder.validation import validate_wiki


@dataclass(frozen=True)
class WikiBuildRequest:
    tenant_id: str
    wiki_id: str
    input_dir: Path
    storage_root: Path
    actor_id: str
    synthetic_corpus: bool = False
    expected_current_build_id: str | None | object = CURRENT_NOT_CHECKED

    def to_scope(self) -> WikiScope:
        return WikiScope(
            tenant_id=self.tenant_id,
            wiki_id=self.wiki_id,
            input_dir=self.input_dir,
            storage_root=self.storage_root,
            synthetic_corpus=self.synthetic_corpus,
            actor_id=self.actor_id,
        )


@dataclass(frozen=True)
class RebuildResult:
    enrichment: EnrichmentRun | None
    build: BuildResult


class WikiBuildService:
    """Server-facing boundary for one tenant-scoped wiki."""

    def __init__(self, config: WikiConfig):
        self.config = config

    def build(
        self,
        request: WikiBuildRequest,
        *,
        activate_incomplete: bool = False,
    ) -> BuildResult:
        return build_wiki(
            self.config,
            request.to_scope(),
            activate_incomplete=activate_incomplete,
            expected_current_build_id=request.expected_current_build_id,
        )

    def rebuild_documents(
        self,
        request: WikiBuildRequest,
        doc_ids: set[str],
        *,
        run_enrichment: bool = True,
        refresh_enrichment: bool = False,
    ) -> RebuildResult:
        if not doc_ids:
            raise ValidationError("재빌드할 doc_ids가 비어 있습니다")
        scope = request.to_scope()
        enrichment: EnrichmentRun | None = None
        if run_enrichment:
            enrichment = enrich_documents(
                self.config,
                selected_ids=doc_ids,
                refresh=refresh_enrichment,
                scope=scope,
            )
        build = build_wiki(
            self.config,
            scope,
            expected_current_build_id=request.expected_current_build_id,
        )
        return RebuildResult(enrichment=enrichment, build=build)

    def current_status(self, request: WikiBuildRequest) -> dict[str, Any]:
        scope = request.to_scope()
        current_build = load_current_build(self.config, scope)
        if current_build is None:
            return {
                "tenant_id": scope.tenant_id,
                "wiki_id": scope.wiki_id,
                "status": "not-built",
                "current": None,
            }
        current, build_dir = current_build
        meta_path = build_dir / "build-meta.json"
        if not meta_path.is_file():
            raise ValidationError(f"current가 가리키는 build-meta.json이 없습니다: {build_dir}")
        build_meta = json.loads(meta_path.read_text(encoding="utf-8"))
        validate_record(self.config, "build-meta", build_meta, current["build_id"])
        if build_meta["build_id"] != current["build_id"]:
            raise ValidationError("current.json과 build-meta.json의 build_id가 다릅니다")
        return {
            "tenant_id": scope.tenant_id,
            "wiki_id": scope.wiki_id,
            "status": "ready" if current.get("complete") else "incomplete",
            "current": current,
            "build_meta": build_meta,
        }

    def validate_current(
        self,
        request: WikiBuildRequest,
        *,
        require_enrichment: bool = True,
        check_reproducible: bool = True,
    ) -> dict[str, Any]:
        scope = request.to_scope()
        current_build = load_current_build(self.config, scope)
        if current_build is None:
            raise ValidationError("현재 활성화된 빌드가 없습니다")
        _, build_dir = current_build
        return validate_wiki(
            self.config,
            require_enrichment=require_enrichment,
            check_reproducible=check_reproducible,
            scope=scope,
            output_dir=build_dir,
        )
