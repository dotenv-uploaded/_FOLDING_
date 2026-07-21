/**
 * IPC 핸들러 등록 (스펙 v1.4 §2 — 계약의 `IPC` 채널과 1:1).
 * `src/preload/index.ts` 의 `invoke` 목록이 곧 이 파일의 목록이다.
 *
 * 모든 예외는 여기서 한국어 문장으로 바뀌어 렌더러에 전달된다 — raw stack 을 넘기지 않는다
 * (스펙 v1.4 §5 silent fail 금지).
 */
import { dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { IPC, type LlmKeyInput, type LlmProvider, type LoginRequest } from '@contracts';
import type { AppServices } from '@main/services';
import { logError, toUserMessage } from '@main/util/errors';

/** 핸들러를 감싸 오류를 한국어 문장으로 정규화한다. */
function handle<T>(
  channel: string,
  fallbackMessage: string,
  fn: (...args: never[]) => T | Promise<T>,
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return await fn(...(args as never[]));
    } catch (err) {
      logError(`ipc:${channel}`, err);
      throw new Error(toUserMessage(err, fallbackMessage));
    }
  });
}

export function registerIpcHandlers(
  services: AppServices,
  getWindow: () => BrowserWindow | null,
): void {
  /* ------------------------------------------------------------- L4 인증 */

  handle(IPC.authLogin, '로그인에 실패했습니다.', (request: LoginRequest) =>
    services.auth.login(request),
  );
  handle(IPC.authLogout, '로그아웃에 실패했습니다.', () => services.auth.logout());
  handle(IPC.authSession, '세션 정보를 불러오지 못했습니다.', () => services.auth.getSession());

  /* ------------------------------------------------------------- L4 폴더 */

  handle(IPC.rootsList, '등록된 폴더를 불러오지 못했습니다.', () => services.listRoots());

  handle(IPC.rootsPickDialog, '폴더 선택 창을 열지 못했습니다.', async () => {
    const window = getWindow();
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: '문서 폴더 선택',
          buttonLabel: '이 폴더 등록',
          properties: ['openDirectory', 'createDirectory'],
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle(IPC.rootsScanPreview, '폴더를 훑어보지 못했습니다.', (rootPath: string) =>
    services.scanPreview(rootPath),
  );
  handle(IPC.rootsAdd, '폴더를 등록하지 못했습니다.', (rootPath: string) =>
    services.addRoot(rootPath),
  );
  handle(IPC.rootsRemove, '폴더를 삭제하지 못했습니다.', (id: string) => services.removeRoot(id));

  /* ------------------------------------------------------------- L2 빌드 */

  // 빌드는 오래 걸리므로 즉시 반환하고, 진행 상황은 IPC_EVENTS.buildState 로 흘린다.
  handle(IPC.buildTrigger, '빌드를 시작하지 못했습니다.', () => {
    void services.build.trigger();
  });
  handle(IPC.buildState, '빌드 상태를 불러오지 못했습니다.', () => services.build.getState());

  // 취소는 곧 LLM 호출 비용을 멈추는 일이다 (스펙 v1.4 §5)
  handle(IPC.buildCancel, '빌드를 중단하지 못했습니다.', () => {
    services.build.cancel();
  });

  /* ------------------------------------ L4 enrichment LLM 키 (자격증명 ②) */

  // 원문 키는 어떤 채널로도 렌더러에 내려가지 않는다 — status 는 설정 여부와 끝 4자리뿐이다.
  handle(IPC.llmKeyStatus, 'LLM 키 상태를 불러오지 못했습니다.', () =>
    services.llmKeys.status(),
  );

  handle(IPC.llmKeySet, 'LLM 키를 저장하지 못했습니다.', (input: LlmKeyInput) =>
    services.llmKeys.set(input),
  );

  handle(IPC.llmKeyClear, 'LLM 키를 삭제하지 못했습니다.', (provider: LlmProvider) =>
    services.llmKeys.clear(provider),
  );

  /* ------------------------------------------------------------- L1 트리 */

  handle(IPC.treeGet, '문서 목록을 불러오지 못했습니다.', () => services.getTree());

  /* ------------------------------------------------------------- L1 채팅 */

  handle(IPC.chatList, '채팅 목록을 불러오지 못했습니다.', () => services.chat.list());
  handle(IPC.chatCreate, '새 채팅을 만들지 못했습니다.', () => services.chat.create());
  handle(IPC.chatMessages, '대화 내용을 불러오지 못했습니다.', (conversationId: string) =>
    services.chat.messages(conversationId),
  );
  handle(IPC.chatSend, '메시지를 보내지 못했습니다.', (conversationId: string, text: string) =>
    services.chat.send(conversationId, text),
  );
  handle(IPC.chatAbort, '응답을 중단하지 못했습니다.', (conversationId: string) => {
    services.chat.abort(conversationId);
  });

  /* --------------------------------------------------------- L1 승인 응답 */

  handle(IPC.approvalRespond, '승인 결과를 전달하지 못했습니다.', (id: string, approved: boolean) => {
    services.approval.respond(id, approved);
  });

  /* ------------------------------------------------------- L1 원본 열기 */

  handle(IPC.openOriginal, '원본 문서를 열지 못했습니다.', async (virtualPath: string) => {
    const absPath = services.resolveOriginal(virtualPath);
    if (!absPath) {
      throw new Error('등록된 폴더 안에서 원본을 찾지 못했습니다.');
    }
    const failure = await shell.openPath(absPath);
    if (failure) throw new Error(`원본 문서를 열지 못했습니다: ${failure}`);
  });
}

/** 창이 닫힐 때 핸들러를 정리한다 (재기동 시 중복 등록 방지). */
export function unregisterIpcHandlers(): void {
  for (const channel of Object.values(IPC)) ipcMain.removeHandler(channel);
}
