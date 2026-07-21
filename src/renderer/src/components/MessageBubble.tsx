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
