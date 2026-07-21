from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ResponseType(StrEnum):
    ANSWER = "answer"
    LOCATION_RESULT = "location_result"
    TARGET_SELECTION = "target_selection"
    CHANGE_PREVIEW = "change_preview"
    EXECUTION_RESULT = "execution_result"
    ERROR = "error"


class Evidence(StrictModel):
    chunk_id: str
    section: str
    quote: str


class Relation(StrictModel):
    relation: str
    target_document_id: str


class DocumentResult(StrictModel):
    document_id: str
    file_version_id: str
    title: str
    display_path: str
    source_uri: str
    score: float = Field(ge=0, le=1)
    graph_version: str
    evidence: list[Evidence]
    relations: list[Relation]
    can_read: bool
    can_write: bool
    editability: str


class ApiError(StrictModel):
    code: str
    message: str
    retryable: bool = False


class ChatMessageRequest(StrictModel):
    conversation_id: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=4_000)
    selected_document_id: str | None = None


class ChatMessageResponse(StrictModel):
    conversation_id: str
    message_id: str
    response_type: ResponseType
    assistant_text: str
    documents: list[DocumentResult]
    change_plan: None = None
    error: ApiError | None = None


class HealthResponse(StrictModel):
    status: str
    knowledge_version: str
    converter_available: bool
    graph_available: bool
    agent_available: bool
