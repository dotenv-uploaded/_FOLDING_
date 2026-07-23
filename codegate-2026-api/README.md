# codegate-2026-convert

CODEGATE 2026 AI 스타트업 해커톤 — 문서 변환 서비스.

## 서비스

| 경로 | 설명 |
|---|---|
| [`services/doc2md`](services/doc2md) | 문서(pdf/hwp/hwpx/pptx/docx/xlsx/csv/html) → 프론트매터 포함 마크다운 변환 API |

자세한 내용은 [services/doc2md/README.md](services/doc2md/README.md),
형식별 지원 범위는 [services/doc2md/docs/CAPABILITIES.md](services/doc2md/docs/CAPABILITIES.md).

## 소비자와 계약

`dotenv-uploaded/codegate-2026-agent`의 Backend가
`src/codegate_api/integrations/doc2md.py`에서 이 서비스를 호출합니다.

**`POST /convert`의 응답은 그 어댑터가 `extra="forbid"`로 검증합니다.** 최상위에 키를
하나라도 추가하면 — `null`로 직렬화되더라도 — 스키마 검증이 실패하고 변환 전체가
`DOC2MD_RESPONSE_INVALID`로 거부됩니다. 실제로 `chunks`를 추가했다가 연동이 끊긴 적이
있습니다.

- v1(`/convert`)은 **7키로 동결**됐습니다.
- 새 필드는 전부 **`/v2/convert`**에 추가합니다.
- `services/doc2md/tests/test_v1_contract.py`가 소비자의 pydantic 모델을 복제해 이를
  지킵니다. **여기가 깨지면 모델을 느슨하게 고치지 말고 필드를 v2로 옮기세요.**

## 빠른 시작

```bash
cd services/doc2md
pip install -e ".[gpu,test]" --extra-index-url https://www.paddlepaddle.org.cn/packages/stable/cu126/

uvicorn app.main:app --host 127.0.0.1 --port 8931
curl 'http://127.0.0.1:8931/health?deep=1'   # 실제 변환 스모크 + OCR 디바이스 + 보안 설정
curl  http://127.0.0.1:8931/capabilities      # 형식별 parse / ocr / write_back

uv run --isolated --python 3.12 --extra test pytest tests/ -q
```

폴더 단위 배치 변환(토큰 예산에 따라 `processed/` · `excepted/` 분류 + `manifest.jsonl`):

```bash
python -m app.batch_cli "<입력 폴더>" output
```

## Railway 배포

저장소 루트의 `Dockerfile`과 `railway.toml`은 CPU 기반 doc2md 전용 서비스를 만든다. Uvicorn은
Railway의 IPv4/IPv6 private network 권장값인 빈 host에 bind하고, `/health`가 성공해야 배포가
활성화된다.

Backend와 같은 Railway project/environment에 `doc2md`라는 서비스로 배포한다. Browser에 public
domain을 제공하지 않고 Backend만 `http://doc2md.railway.internal:8080`으로 호출한다. 서비스 간
원본은 volume path가 아니라 `bytes` transport로 전달하며 양쪽에 같은 Bearer secret을 둔다.

```text
# doc2md
PORT=8080
DOC2MD_API_TOKEN=<shared-secret>
DOC2MD_OCR_DEVICE=cpu
DOC2MD_OCR_MODE=auto

# Backend
CODEGATE_DOC2MD_BASE_URL=http://doc2md.railway.internal:8080
CODEGATE_DOC2MD_SOURCE_KIND=bytes
CODEGATE_DOC2MD_API_TOKEN=<shared-secret>
```

배포 완료 판정은 `/health`만으로 하지 않는다. Bearer 인증을 붙인 synthetic `POST /v2/convert`에서
본문, source SHA-256, converter version, section mapping을 확인하고 Backend `/api/v1/health`의
`converter_available=true`도 확인한다.
