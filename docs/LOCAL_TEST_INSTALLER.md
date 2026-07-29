# 로컬 테스트와 OS별 설치 파일

## 목표

개발 단계에서는 API 키 없이 16 GB 메모리 노트북에서 전체 흐름을 재현한다. 상용 배포는 이후
provider 설정으로 API를 연결하며, 로컬 테스트 경로는 회귀 테스트와 장애 대응용으로 계속 남긴다.

## 권장 로컬 모델

- 기본: `gemma4:e2b` (Ollama 배포 크기 약 7.2 GB)
- 여유가 있는 장비: `gemma4:e4b` (약 9.6 GB)
- context: 8,192 tokens
- 최대 출력: 2,048 tokens

16 GB 장비에서는 e2b를 기본으로 사용하고 다른 대형 모델을 동시에 load하지 않는다. Ollama가
이미 실행 중이면 그것을 재사용하고, 없으면 설치본에 포함된 Ollama runtime을 loopback에서
시작한다. LM Studio를 쓸 때는 Local Server를 켜고 Gemma 4 모델을 먼저 load한다.

## 개발 환경

```shell
git clone https://github.com/dotenv-uploaded/folding.git
cd folding

cd services/agent
uv sync --group dev

cd ../../services/convert/services/doc2md
uv sync --extra test

cd ../../../../apps/desktop
pnpm install --frozen-lockfile
pnpm dev:integrated
```

모든 Python 명령은 각 모듈의 `.venv`에서 실행된다. 전역 `python`, `pip`, `virtualenv`는 사용하지
않는다. OCR은 설치 파일의 기본 요건이 아니다. 스캔 PDF OCR을 개발 환경에서 추가하려면
`uv sync --extra ocr`를 사용한다.

설치 파일을 만들 때 `runtime:python`이 두 모듈의 lock을 다시 동기화하므로 개발자의 전역
Python 상태가 산출물에 섞이지 않는다. Linux에서는 `ldd`, macOS에서는 `otool -L`로 PyInstaller와
Ollama 실행 파일의 미해결 동적 링크를 검사한다.

## 로컬 모델 선택

```dotenv
CODEGATE_AUTH_MODE=local
CODEGATE_AGENT_MODE=local
CODEGATE_LLM_PROVIDER=local
CODEGATE_LOCAL_LLM_BACKEND=auto
CODEGATE_LOCAL_LLM_MODEL=gemma4:e2b
CODEGATE_LOCAL_LLM_CONTEXT_TOKENS=8192
CODEGATE_LOCAL_LLM_MAX_OUTPUT_TOKENS=2048
```

- `auto`: Ollama `11434`, LM Studio `1234`, 내장 Ollama 순서로 찾는다.
- `ollama`: Ollama만 사용한다.
- `lmstudio`: LM Studio만 사용하며 모델 자동 다운로드는 하지 않는다.
- `CODEGATE_LOCAL_LLM_BASE_URL`: 기존 서버를 직접 지정한다. loopback URL만 허용한다.

## 검증 순서

```shell
cd apps/desktop
pnpm typecheck
pnpm test
pnpm integrations:smoke
pnpm electron:smoke
pnpm runtime:python
pnpm runtime:prerequisites
pnpm runtime:smoke
```

`runtime:smoke`는 개발용 Python 대신 PyInstaller 산출물을 사용해 다음을 검증한다.

1. doc2md health와 실제 Markdown 변환
2. agent health와 LLMWIKI in-process import
3. 근거 검색
4. exact diff 승인과 원본 변경
5. 새 불변 build publish
6. Undo와 후속 build publish

Discord token이 없어도 이 검증은 모두 실행된다. Discord gateway는 별도의 선택적 integration이다.
격리된 Electron 회귀 테스트는 `CODEGATE_USER_DATA_DIR`를 임시 폴더로 지정해 실제 사용자
설정과 SQLite를 건드리지 않고 실행할 수 있다. `electron:smoke`는 실제 preload IPC를 통해
저장소 상위 폴더를 스캔·등록하고 화면 캡처까지 수행한다.

## 설치 파일 생성

```shell
cd apps/desktop
pnpm package
```

명령은 현재 OS용 Ollama runtime을 SHA-256 검증 후 포함하고, Python sidecar 두 개를 빌드한 다음
플랫폼 전제조건을 검증해 Electron 설치 파일을 만든다. Windows에서는 Microsoft Authenticode와
SHA-256을 모두 검증한 VC++ Runtime을 함께 넣는다.

| 빌드 OS | 산출물 | 비고 |
| --- | --- | --- |
| Windows x64 | NSIS `.exe` | Windows 10 22H2+, VC++ 자동 주입·갱신 |
| macOS arm64/x64 | `.dmg` | macOS 14+, Metal은 OS 포함, 배포 전 서명·notarization 필요 |
| Linux arm64/x64 | `.AppImage` | glibc 2.35+, 배포판·architecture별 native CI 검증 |

운영체제별 native binary가 다르므로 하나의 물리 파일을 세 OS가 공유하지 않는다. 대신 각 OS에서
사용자가 실행할 파일은 하나이며 Python, Node, Ollama를 따로 설치할 필요가 없다.
Windows에서 설치 위치를 직접 바꿀 때는 깊은 저장소 하위가 아니라 기본 위치 또는
`C:\Apps\Folding`처럼 짧은 경로를 사용한다. native dependency 경로가 Windows의 기존 경로
한도를 넘으면 설치는 가능해도 업데이트·제거가 실패할 수 있다.

### 설치·실행 전 의존성 보증

1. 빌드 시 `uv.lock`, `pnpm-lock.yaml`, Ollama 버전·SHA-256, VC++ 버전·SHA-256을 고정한다.
2. Windows NSIS는 Windows build 19045 이상을 확인하고, VC++가 14.50.35719보다 낮을 때만
   Microsoft 설치 패키지를 실행한다. UAC 요청을 거부하면 불완전 설치를 계속하지 않는다.
3. macOS는 DMG metadata와 앱 실행 전 점검에서 macOS 14 이상을 확인한다.
4. Linux는 glibc 2.35 이상을 확인한다. AppImage가 실행된 뒤에도 sidecar와 Ollama 파일을 다시
   검사한다.
5. 모든 OS에서 메모리, 모델 저장 디스크, runtime manifest, sidecar, doc2md, Ollama, LLMWIKI,
   `kordoc`, `rhwp` WASM, `better-sqlite3` native binary를 확인한다.
6. Windows에서는 DirectX와 GPU 드라이버도 진단한다. DirectX/Metal과 GPU 커널 드라이버는
   운영체제가 관리하므로 설치기가 임의 DLL을 덮어쓰지 않는다. 기준 미달이면 GPU 가속 경고를
   남기고 Ollama의 CPU 폴백을 사용할 수 있다.

결과는 `%APPDATA%` 계열의 Folding `userData/runtime-diagnostics.json`에 남는다. 복사 도중
파일이 빠졌거나 VC++ 설치가 거부된 경우에는 빈 화면으로 진행하지 않고 복구 방법과 함께
시작을 중단한다.

## CI

`.github/workflows/desktop-installers.yml`은 Windows x64, macOS arm64/x64, Linux arm64/x64
native runner에서 독립적으로 테스트하고 설치 파일을 artifact로 올린다. tag `desktop-v*` 또는
수동 실행으로 시작한다. native dependency와 PyInstaller 특성상 다른 OS/architecture 산출물을
한 runner에서 cross-build하지 않는다.

## 최초 실행

1. 앱이 기존 Ollama/LM Studio와 Gemma 4를 탐색한다.
2. 없으면 내장 Ollama를 시작한다.
3. `gemma4:e2b`가 없으면 최초 한 번 모델을 다운로드한다.
4. 사용자가 폴더를 고르면 doc2md가 정규화한다.
5. LLMWIKI build가 활성화되면 채팅·그래프·승인 기능을 사용한다.

모델 다운로드에는 인터넷이 필요하다. 다운로드가 끝난 뒤 로컬 사용에는 인터넷과 API 키가
필요하지 않다.

## 공식 참고

- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs)
- [LM Studio local server](https://lmstudio.ai/docs/developer/core/server)
- [Electron Builder targets](https://www.electron.build/docs/targets/)
- [Microsoft Visual C++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170)
- [Ollama Windows requirements](https://docs.ollama.com/windows)
- [Ollama macOS requirements](https://docs.ollama.com/macos)
- [Ollama hardware support](https://docs.ollama.com/gpu)
- [Gemma 4 documentation](https://ai.google.dev/gemma/docs/core)
- [Gemma Terms](https://ai.google.dev/gemma/terms)
