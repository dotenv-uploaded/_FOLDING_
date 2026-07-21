import { useEffect, useState } from 'react';
import type { ChatMessage } from '@contracts';
import { NOT_FOUND_IN_WIKI } from '@contracts';
import { Mark } from '@/ui/Wordmark';
import { ToolBadge } from './ToolBadge';
import { CitationChip } from './CitationChip';

/**
 * 한 메시지.
 *   사용자 — 우측 정렬 ink 버블 (브랜드 블루는 인용·액션에만 남겨 둔다)
 *   에이전트 — 전폭 본문 + 도구 배지 + 인용 칩
 */
export function MessageBubble({ message }: { message: ChatMessage }) {
  const [execution, setExecution] = useState(message.execution);
  const [action, setAction] = useState<'retry' | 'undo' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => setExecution(message.execution), [message.execution]);

  async function runExecutionAction(kind: 'retry' | 'undo') {
    if (!execution || action) return;
    setAction(kind);
    setActionError(null);
    try {
      const next = await window.codegate.execution[kind](message.id, execution.executionId);
      setExecution(next);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '실행 상태를 변경하지 못했습니다.');
    } finally {
      setAction(null);
    }
  }

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div
          data-selectable
          className="max-w-[80%] whitespace-pre-wrap break-words rounded-xl bg-ink-100 px-4 py-2.5 text-[15px] leading-normal text-ink-900"
        >
          {message.text}
        </div>
      </div>
    );
  }

  const unresolved = message.text.includes(NOT_FOUND_IN_WIKI);

  return (
    <div className="flex gap-3.5">
      <Mark size={26} className="mt-0.5" />

      <div className="min-w-0 flex-1">
        {message.tools && message.tools.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {message.tools.map((t, i) => (
              <ToolBadge key={`${t.name}-${i}`} name={t.name} summary={t.summary} />
            ))}
          </div>
        )}

        {message.text ? (
          <div
            data-selectable
            className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink-800"
          >
            {message.text}
            {message.streaming && (
              <span
                className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.18em] bg-blue-500 align-baseline"
                style={{ animation: 'fold-caret 1s steps(1) infinite' }}
              />
            )}
          </div>
        ) : (
          message.streaming && <ThinkingDots />
        )}

        {unresolved && (
          <p className="mt-3 rounded-md border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-600">
            위키에 근거가 없어 답을 확정하지 못했습니다. 폴더에 관련 문서가 있는지 확인해 주세요.
          </p>
        )}

        {message.citations && message.citations.length > 0 && (
          <div className="mt-3.5 flex flex-wrap gap-1.5">
            {message.citations.map((c, i) => (
              <CitationChip key={`${c.docId}-${c.section}-${i}`} citation={c} />
            ))}
          </div>
        )}

        {execution && (
          <div className="mt-3.5 rounded-md border border-ink-100 bg-ink-50 px-3.5 py-3 text-xs text-ink-600">
            <div className="flex items-center gap-2">
              <span className="font-mono text-2xs text-ink-400">{execution.stage}</span>
              <span className="flex-1">
                {execution.error?.message ??
                  (execution.status === 'completed'
                    ? '문서와 위키에 변경이 반영되었습니다.'
                    : execution.status === 'undone'
                      ? '문서 변경을 되돌렸습니다.'
                      : '문서 변경 처리가 종료되었습니다.')}
              </span>
              {execution.canRetry && (
                <button
                  disabled={action !== null}
                  onClick={() => void runExecutionAction('retry')}
                  className="font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-50"
                >
                  {action === 'retry' ? '재시도 중…' : '동기화 재시도'}
                </button>
              )}
              {execution.canUndo && (
                <button
                  disabled={action !== null}
                  onClick={() => void runExecutionAction('undo')}
                  className="font-semibold text-red-600 hover:text-red-700 disabled:opacity-50"
                >
                  {action === 'undo' ? '되돌리는 중…' : 'Undo'}
                </button>
              )}
            </div>
            {actionError && <p className="mt-2 text-red-600">{actionError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-1.5" aria-label="생각하는 중">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-ink-300"
          style={{ animation: `fold-caret 1.2s ease-in-out ${i * 0.16}s infinite` }}
        />
      ))}
    </div>
  );
}
