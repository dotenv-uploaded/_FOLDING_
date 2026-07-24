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
          {riskStyle && (
            <div className="flex items-center gap-2">
              <span
                className={`rounded-full px-2.5 py-0.5 text-2xs font-semibold ${riskStyle.className}`}
              >
                {riskStyle.label}
              </span>
              <span className="font-mono text-2xs text-ink-500">{request.tool}</span>
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
