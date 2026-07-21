from fastapi.testclient import TestClient

from codegate_api.main import app


def test_health_reports_loaded_knowledge_version() -> None:
    with TestClient(app) as client:
        response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "knowledge_version": "2026-07-21.1-demo",
        "converter_available": False,
        "graph_available": True,
        "agent_available": False,
    }


def test_chat_locates_document_with_evidence() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/chat/messages",
            headers={"Idempotency-Key": "00000000-0000-0000-0000-000000000001"},
            json={
                "conversation_id": "conv_demo",
                "message": "개인정보 보관 기간 문서 어디 있어?",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["response_type"] == "location_result"
    assert payload["documents"][0]["document_id"] == "REG-000001"
    assert payload["documents"][0]["evidence"][0]["section"] == "제4조 보관 기간"
    assert payload["documents"][0]["graph_version"] == "2026-07-21.1-demo"
    assert response.headers["X-Request-ID"]


def test_chat_returns_structured_not_found() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/chat/messages",
            json={"conversation_id": "conv_demo", "message": "양자역학 실험실 예약"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["response_type"] == "error"
    assert payload["error"]["code"] == "DOCUMENT_NOT_FOUND"


def test_document_detail_returns_404_for_unknown_id() -> None:
    with TestClient(app) as client:
        response = client.get("/api/v1/documents/REG-999999")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "DOCUMENT_NOT_FOUND"


def test_document_detail_hides_restricted_document_from_anonymous_user() -> None:
    with TestClient(app) as client:
        response = client.get("/api/v1/documents/REP-000001")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "DOCUMENT_NOT_FOUND"
