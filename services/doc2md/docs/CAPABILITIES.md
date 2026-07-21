# doc2md capability 표

`GET /capabilities`가 반환하는 것과 같은 내용이다. 실행 중인 서비스의 응답이 source of
truth이고, 이 문서는 계약 검토용 사본이다.

## 형식별 지원

| format | parse | ocr | page_mapping | **write_back** | library |
|---|:---:|:---:|:---:|:---:|---|
| pdf | ✅ | ✅ | ⚠️ 부분 | ❌ | markitdown (pdfminer) + PaddleOCR |
| pptx / ppt | ✅ | ✅ | ✅ 슬라이드 번호 | ❌ | markitdown + PowerPoint COM + PaddleOCR |
| hwp / hwpx | ✅ | ❌ | ❌ | ❌ | pyhwp2md |
| docx / xlsx / csv / html / md / txt | ✅ | ❌ | ❌ | ❌ | markitdown |

## write_back이 전부 ❌인 이유

이 스택에 HWP·PDF·DOCX **writer가 없다.** markitdown, pyhwp2md, PaddleOCR은 모두 단방향
읽기 도구다. 원본 바이너리에 편집을 되쓰는 경로는 구현돼 있지 않고 검증된 적도 없다.

TEAM_HANDOFF의 "검증되지 않은 HWP/PDF write 지원 주장"은 보내지 않을 항목으로 명시돼 있고,
"검증된 writer가 없으면 Backend는 read-only로 유지합니다"가 그 결론이다. 따라서 이 서비스에
대해 문서 저장소는 **read-only로 유지**하면 된다. ✅로 바뀌는 일은 실제 writer가 생기고
round-trip 검증을 통과한 뒤에만 일어난다.

## page_mapping이 PDF에서 "부분"인 이유

`sections[].source_page`는 **스캔 PDF**(텍스트 레이어가 없어 페이지를 이미지로 렌더링해
OCR한 경우)에만 채워진다. 텍스트 레이어가 있는 PDF는 `null`이다.

측정 결과가 근거다. PyMuPDF로 페이지 단위 텍스트를 뽑으면 페이지 번호를 전부 얻을 수 있고
PDF 코퍼스 전체가 66.3초 → 1.4초로 빨라진다. 한글 문자 수도 완전히 동일하다(예: 204,633자
→ 204,633자). 그러나 **표가 사라진다** — 28K자 문서 하나에서 pdfminer가 만든 표 210행,
파이프 3,021개가 PyMuPDF에서는 0이 된다.

표 보존이 이 파이프라인이 가장 공들인 부분이므로 속도와 페이지 번호를 위해 표를 버리지
않기로 했다. 대신 **모든 형식에서 `char_start`/`char_end` span을 제공**한다. 통합 계약이
요구하는 것은 "section **또는** source page/span mapping"이므로 span으로 충족된다.

HWP/HWPX는 본문에 페이지 개념 자체가 없다 — 이건 선택이 아니라 형식의 성질이다.

## OCR 요건

| 조건 | 없을 때 |
|---|---|
| PaddleOCR + paddlepaddle | 이미지 텍스트 없이 변환, `ocr_engine_unavailable` diagnostic |
| CUDA GPU | CPU로 자동 대체 (약 10배 느림) |
| Windows + PowerPoint (pptx) | 내장 이미지 OCR로 대체, `slide_render_unavailable` diagnostic |

세 경우 모두 변환은 성공하고 품질만 떨어진다. 전부 `retryable: true`로 표시되므로 호출자가
환경이 정상인 호스트에서 재시도할지 판단할 수 있다.
