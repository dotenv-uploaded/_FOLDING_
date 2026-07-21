import json
from typing import Any

from claude_agent_sdk import McpSdkServerConfig, create_sdk_mcp_server, tool

from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository


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
                    "pattern": "^[A-Z]{3}-[0-9]{6}$",
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

    return create_sdk_mcp_server(
        name="codegate",
        version="0.1.0",
        tools=[knowledge_search, document_get],
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
