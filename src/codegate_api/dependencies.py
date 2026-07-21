from functools import lru_cache

from codegate_api.config import get_settings
from codegate_api.files.resolver import SourceUriResolver
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository


@lru_cache
def get_knowledge_repository() -> KnowledgeRepository:
    settings = get_settings()
    return KnowledgeRepository(
        settings.resolved_knowledge_root(),
        SourceUriResolver(settings.resolved_source_root()),
    )


def get_access_context() -> AccessContext:
    """Return anonymous access until a verified Supabase JWT adapter is connected."""

    return AccessContext.anonymous()
