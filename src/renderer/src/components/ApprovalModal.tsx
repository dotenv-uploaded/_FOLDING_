import { useEffect, useRef, useState } from 'react';
import { FileWarning } from 'lucide-react';
import type { ApprovalEnvelope, ToolRisk } from '@contracts';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/ui/Dialog';
import { Button } from '@/ui/Button';
import { DiffView } from './DiffView';

const TOOL_LABEL: Record<string, string> = {
  patch_document: '문서 수정',
  create_document: '문서 생성',
  create_from_template: '양식 복제',
  Bash: '명령 실행',
  Write: '파일 쓰기',
  Edit: '파일 수정',
  NotebookEdit: '노트북 수정',
  WebFetch: '웹 페이지 가져오기',
  WebSearch: '웹 검색',
};

/**
 * 위험도별 문구와 색.
 *
 * `danger` 는 되돌릴 수 없거나 데이터가 밖으로 나가는 작업이다 — 눈에 띄게 다르게 보여야
 * 사용자가 습관적으로 승인을 누르지 않는다.
 */
const RISK_STYLE: Record<ToolRisk, { label: string; note: string; className: string }> = {
  safe: {
    label: '안전',
    note: '읽기 작업입니다.',
    className: 'bg-ink-100 text-ink-700',
  },
  caution: {
    label: '주의',
    note: '승인하면 이 컴퓨터의 파일이 바뀝니다.',
    className: 'bg-amber-100 text-amber-800',
  },
  danger: {
    label: '위험',
    note: '되돌릴 수 없거나 외부로 데이터가 나갈 수 있는 작업입니다. 내용을 꼭 확인하세요.',
    className: 'bg-red-100 text-red-800',
  },
};

/**
 * 남은 승인 시간(초). 답이 없으면 **거부**가 기본값이므로, 0 이 되면 스스로 거부한다.
 *
 * 서버도 같은 시간에 거부로 처리한다. 화면이 아무 말 없이 열려 있으면 사용자는 이미
 * 거부된 요청을 계속 승인하려 들게 되므로, 남은 시간을 보여주고 판정을 맞춘다.
 *
 * `timeoutSeconds` 가 없는 요청(기존 문서 편집 흐름)은 카운트다운하지 않는다 — null 반환.
 */
function useApprovalCountdown(
  pending: ApprovalEnvelope | null,
  onReject: () => void,
): number | null {
  const timeoutSeconds = pending?.request.timeoutSeconds;
  const [remaining, setRemaining] = useState<number | null>(null);
  // onReject 가 매 렌더 새 함수여도 타이머가 다시 시작되지 않게 최신 값만 붙잡아 둔다.
  const rejectRef = useRef(onReject);
  rejectRef.current = onReject;

  useEffect(() => {
    if (pending === null || timeoutSeconds === undefined) {
      setRemaining(null);
      return;
    }
    const deadline = Date.now() + timeoutSeconds * 1000;
    setRemaining(Math.ceil(timeoutSeconds));

    const timer = setInterval(() => {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      setRemaining(left > 0 ? left : 0);
      if (left <= 0) {
        clearInterval(timer);
        rejectRef.current();
      }
    }, 1000);
    return () => clearInterval(timer);
    // 승인 건이 바뀌면(id) 타이머를 새로 시작한다.
  }, [pending?.id, timeoutSeconds, pending]);

  return remaining;
}

/** 남은 시간을 사람이 읽는 형태로. 1분이 넘으면 분 단위가 읽기 쉽다. */
function formatRemaining(seconds: number): string {
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}분` : `${minutes}분 ${rest}초`;
}

/**
 * A3 승인 게이트 (스펙 v1.3 §3 승인 모달).
 *
 * 메인 프로세스는 응답이 올 때까지 도구 실행을 멈추고 기다린다.
 * 따라서 이 모달은 **모든 종료 경로에서 반드시 응답해야 한다** —
 * 바깥 클릭으로 닫히지 않게 막고, Esc는 명시적 "거부"로 처리한다.
 */
export function ApprovalModal({
  pending,
  onApprove,
  onReject,
}: {
  pending: ApprovalEnvelope | null;
  onApprove: () => void;
  onReject: () => void;
}) {
  const remaining = useApprovalCountdown(pending, onReject);

  if (!pending) return null;
  const { request } = pending;
  const risk = request.risk;
  const riskStyle = risk ? RISK_STYLE[risk] : null;
  // 문서 편집 흐름만 원본 파일을 가리킨다. 임의 도구의 target 은 명령·URL 이라 열 수 없다.
  const canOpenOriginal = request.diff !== undefined;

  return (
    <Dialog open>
      <DialogContent
        // 실수로 닫아 에이전트를 멈춰 세우지 않도록 바깥 클릭은 무시한다.
        onInteractOutside={(e) => e.preventDefault()}
        // Esc = 거부. 응답 없이 사라지는 경로를 만들지 않는다.
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          onReject();
        }}
      >
        <DialogHeader
          eyebrow="승인 필요"
          title={TOOL_LABEL[request.tool] ?? request.tool}
          description={
            <span className="flex items-center gap-1.5">
              <FileWarning
                size={14}
                className={`shrink-0 ${risk === 'danger' ? 'text-red-500' : 'text-amber-500'}`}
              />
              {riskStyle
                ? riskStyle.note
                : '승인하면 원본 문서가 바뀝니다. 수정 전 백업이 만들어집니다.'}
            </span>
          }
        />

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-7 py-5">
          {(riskStyle || remaining !== null) && (
            <div className="flex items-center gap-2">
              {riskStyle && (
                <span
                  className={`rounded-full px-2.5 py-0.5 text-2xs font-semibold ${riskStyle.className}`}
                >
                  {riskStyle.label}
                </span>
              )}
              <span className="font-mono text-2xs text-ink-500">{request.tool}</span>
              {remaining !== null && (
                <span
                  className={`ml-auto text-2xs tabular-nums ${
                    remaining <= 10 ? 'font-semibold text-red-600' : 'text-ink-500'
                  }`}
                >
                  {/* 답이 없으면 거부가 기본값이다. 무엇이 기본인지 분명히 적는다. */}
                  {remaining > 0
                    ? `${formatRemaining(remaining)} 후 자동 거부`
                    : '시간이 지나 거부되었습니다'}
                </span>
              )}
            </div>
          )}

          {/*
            사용자가 원래 시킨 일을 도구 옆에 붙여 둔다. 인젝션은 자동으로 가려낼 수 없지만,
            요청과 도구가 어긋나면(요약을 시켰는데 rm 이 뜨면) 사람은 알아본다.
          */}
          {request.userRequest && (
            <div>
              <div className="fold-eyebrow mb-1.5">내가 요청한 일</div>
              <p data-selectable className="text-sm leading-relaxed text-ink-600">
                {request.userRequest}
              </p>
            </div>
          )}

          <div>
            <div className="fold-eyebrow mb-1.5">{canOpenOriginal ? '대상' : '실행할 내용'}</div>
            <div
              data-selectable
              className="break-all rounded-md bg-ink-50 px-3 py-2 font-mono text-xs text-ink-700"
            >
              {request.target}
            </div>
          </div>

          {request.rationale && (
            <div>
              <div className="fold-eyebrow mb-1.5">근거</div>
              <p data-selectable className="text-sm leading-relaxed text-ink-600">
                {request.rationale}
              </p>
            </div>
          )}

          {request.planHash && (
            <div>
              <div className="fold-eyebrow mb-1.5">plan_hash</div>
              <div
                data-selectable
                className="break-all rounded-md bg-ink-50 px-3 py-2 font-mono text-2xs text-ink-700"
              >
                {request.planHash}
              </div>
            </div>
          )}

          {request.diff !== undefined && <DiffView diff={request.diff} />}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onReject}>
            거부
          </Button>
          {canOpenOriginal && (
            <Button
              variant="secondary"
              onClick={() => window.codegate.shell.openOriginal(request.target)}
            >
              원본 보기
            </Button>
          )}
          <Button onClick={onApprove}>승인</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
