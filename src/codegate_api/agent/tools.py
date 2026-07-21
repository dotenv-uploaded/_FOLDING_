import json
from typing import Any

from claude_agent_sdk import McpSdkServerConfig, create_sdk_mcp_server, tool

from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository
from codegate_api.knowledge.schemas import DOCUMENT_ID_PATTERN


def create_codegate_tool_server(
    repository: KnowledgeRepository,
    access_context: AccessContext,
) -> McpSdkServerConfig:
    max_evidence_chunks = repository.agent_guide.max_evidence_chunks

    @tool(
        "knowledge_search",
        "Search the validated llm-wiki package and return documents with evidence.",
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "minLength": 1, "maxLength": 4000},
                "top_k": {"type": "integer", "minimum": 1, "maximum": 10},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    )
    async def knowledge_search(args: dict[str, Any]) -> dict[str, Any]:
        query = str(args["query"])
        top_k = min(max(int(args.get("top_k", 5)), 1), max_evidence_chunks)
        documents = [
            document.model_dump(mode="json")
            for document in repository.search(
                query,
                access_context=access_context,
                top_k=top_k,
            )
        ]
        return _json_tool_result({"documents": documents, "graph_version": repository.version})

    @tool(
        "document_get",
        "Get one validated document and its evidence by stable document_id.",
        {
            "type": "object",
            "properties": {
                "document_id": {
                    "type": "string",
                    "pattern": DOCUMENT_ID_PATTERN,
                    "maxLength": 96,
                }
            },
            "required": ["document_id"],
            "additionalProperties": False,
        },
    )
    async def document_get(args: dict[str, Any]) -> dict[str, Any]:
        document_id = str(args["document_id"])
        document = repository.get(document_id, access_context=access_context)
        if document is None:
            return _json_tool_result(
                {"error": {"code": "DOCUMENT_NOT_FOUND", "document_id": document_id}},
                is_error=True,
            )
        return _json_tool_result({"document": document.model_dump(mode="json")})

    @tool(
        "knowledge_document_read",
        "Read one ACL-visible validated canonical Markdown document from the local llm-wiki.",
        {
            "type": "object",
            "properties": {
                "document_id": {
                    "type": "string",
                    "pattern": DOCUMENT_ID_PATTERN,
                    "maxLength": 96,
                }
            },
            "required": ["document_id"],
            "additionalProperties": False,
        },
    )
    async def knowledge_document_read(args: dict[str, Any]) -> dict[str, Any]:
        document_id = str(args["document_id"])
        result = repository.read_canonical_text(
            document_id,
            access_context=access_context,
        )
        if result is None:
            return _json_tool_result(
                {"error": {"code": "DOCUMENT_NOT_FOUND", "document_id": document_id}},
                is_error=True,
            )
        document, content = result
        return _json_tool_result(
            {
                "document_id": document.id,
                "revision": document.revision,
                "graph_version": repository.version,
                "content": content,
            }
        )

    @tool(
        "source_file_read",
        "Read the current allowlisted UTF-8 Markdown or text source for one visible document.",
        {
            "type": "object",
            "properties": {
                "document_id": {
                    "type": "string",
                    "pattern": DOCUMENT_ID_PATTERN,
                    "maxLength": 96,
                }
            },
            "required": ["document_id"],
            "additionalProperties": False,
        },
    )
    async def source_file_read(args: dict[str, Any]) -> dict[str, Any]:
        document_id = str(args["document_id"])
        result = repository.read_source_text(
            document_id,
            access_context=access_context,
        )
        if result is None:
            return _json_tool_result(
                {"error": {"code": "SOURCE_NOT_READABLE", "document_id": document_id}},
                is_error=True,
            )
        document, content = result
        return _json_tool_result(
            {
                "document_id": document.id,
                "revision": document.revision,
                "source_uri": document.source.uri,
                "source_sha256": document.source.sha256,
                "content": content,
            }
        )

    return create_sdk_mcp_server(
        name="codegate",
        version="0.2.0",
        tools=[knowledge_search, document_get, knowledge_document_read, source_file_read],
    )


def _json_tool_result(payload: dict[str, Any], *, is_error: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {
        "content": [
            {
                "type": "text",
                "text": json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            }
        ]
    }
    if is_error:
        result["is_error"] = True
    return result
