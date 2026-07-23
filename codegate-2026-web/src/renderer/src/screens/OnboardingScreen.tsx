import { useState } from 'react';
import { FolderOpen, FolderPlus, Plus, X } from 'lucide-react';
import type { ScanPreview, Session } from '@contracts';
import type { useWorkspace } from '@/state/useWorkspace';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Badge } from '@/ui/Badge';
import { TitleBar } from '@/ui/TitleBar';
import { Spinner } from '@/ui/Spinner';
import { ProgressBar } from '@/ui/ProgressBar';

type Workspace = ReturnType<typeof useWorkspace>;

/**
 * 온보딩 (스펙 v2.4).
 *   로그인 → 폴더 등록 → 스캔 미리보기 → 로컬 빌드
 *
 * 예전에는 폴더 등록 앞에 "Anthropic 키 설정" 단계가 있었다. 지금은 **토큰을 우리가 내고
 * 사용자는 구독으로 쓴다** — 사용자가 키를 발급받을 이유가 없으므로 그 단계를 없앴다.
 * 키는 메인 프로세스의 ManagedLlmKeyStore 가 공급한다.
 */
export function OnboardingScreen({
  workspace,
  session,
}: {
  workspace: Workspace;
  session: Session;
}) {
  return (
    <Shell session={session}>
      <FolderStep workspace={workspace} />
    </Shell>
  );
}

function Shell({ session, children }: { session: Session; children?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-ink-50">
      <TitleBar
        right={
          <Badge tone={session.provisioned ? 'brand' : 'danger'}>
            {session.provisioned ? '계정 연결됨' : '권한 확인 필요'}
          </Badge>
        }
      />
      <div className="mx-auto flex min-h-0 w-full max-w-[680px] flex-1 flex-col justify-center overflow-auto px-8 pb-16">
        {children}
      </div>
    </div>
  );
}

/* ── 폴더 등록 (여러 개) ───────────────────────────────────────────────── */

/** `parent` 가 `child` 를 포함하는가 (같은 경로 포함). 경계에서 접두어 오탐을 막는다. */
function covers(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

/**
 * 스테이징 목록에 폴더를 넣되 **최상위만 남긴다** — 등록 단계의 규칙(resolveRootSelection)을
 * 화면에서도 그대로 보여 준다. 이미 포함되면 null 을 돌려 "이미 포함됨"을 알린다.
 */
function mergeStaged(existing: ScanPreview[], incoming: ScanPreview): ScanPreview[] | null {
  if (existing.some((s) => covers(s.root, incoming.root))) return null; // 하위·중복
  const kept = existing.filter((s) => !covers(incoming.root, s.root)); // 상위면 하위 흡수
  return [...kept, incoming];
}

function FolderStep({ workspace }: { workspace: Workspace }) {
  const [staged, setStaged] = useState<ScanPreview[]>([]);
  const [scanning, setScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const webDemo = document.documentElement.dataset.runtime === 'web-demo';

  /** 폴더를 **여러 개** 고르고, 각각 스캔해 스테이징에 쌓는다. */
  async function pick() {
    setError(null);
    setNote(null);
    const paths = await workspace.pickFolders();
    if (paths.length === 0) return;
    setScanning(true);
    try {
      let current = staged;
      const covered: string[] = [];
      for (const path of paths) {
        const preview = await workspace.scanPreview(path);
        const merged = mergeStaged(current, preview);
        if (merged === null) covered.push(path);
        else current = merged;
      }
      setStaged(current);
      if (covered.length > 0) {
        setNote(`이미 포함된 폴더 ${covered.length}개는 건너뛰었습니다 (상위 폴더가 이미 있어요).`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '폴더를 읽지 못했습니다.');
    } finally {
      setScanning(false);
    }
  }

  function removeStaged(root: string) {
    setStaged((list) => list.filter((s) => s.root !== root));
  }

  async function confirm() {
    if (staged.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      // 순서대로 등록한다. 첫 폴더가 등록되는 순간 App 이 메인 화면으로 넘어가고,
      // 나머지 등록과 백그라운드 준비는 유지되는 workspace 훅에서 이어진다.
      for (const preview of staged) {
        await workspace.addRoot(preview.root);
      }
    } catch (e) {
      setSubmitting(false);
      setError(e instanceof Error ? e.message : '빌드를 시작하지 못했습니다.');
    }
  }

  const totalIncluded = staged.reduce((sum, s) => sum + s.included.length, 0);

  return (
    <>
      <span className="fold-eyebrow">폴더 등록</span>
      <h1 className="mt-3 text-h2 font-bold tracking-tight text-ink-950">
        어떤 폴더를 정리할까요?
      </h1>
      <p className="mt-2.5 text-base leading-relaxed text-ink-500">
        {webDemo ? (
          <>
            선택한 폴더의 지원 파일명을 브라우저에서 정리합니다.
            <br />
            폴더를 지원하지 않는 브라우저에서는 안전한 샘플 문서를 사용합니다.
          </>
        ) : (
          <>
            선택한 폴더의 문서를 읽어 위키로 만듭니다. 폴더는 여러 개 등록할 수 있어요.
            <br />
            겹치거나 상위 폴더를 고르면 최상위만 남깁니다. 위키는 이 컴퓨터에만 저장돼요.
          </>
        )}
      </p>

      {staged.length === 0 ? (
        <Card
          interactive
          onClick={scanning ? undefined : pick}
          className="mt-8 flex flex-col items-center gap-3.5 border-dashed px-8 py-14 text-center"
        >
          {scanning ? (
            <>
              <Spinner size={26} className="text-blue-500" />
              <span className="text-sm text-ink-500">폴더를 훑어보는 중…</span>
            </>
          ) : (
            <>
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-500">
                <FolderPlus size={26} />
              </span>
              <div>
                <div className="text-[15px] font-semibold text-ink-900">폴더 선택하기</div>
                <div className="mt-1 text-xs text-ink-400">
                  hwp · hwpx · docx · pdf · md · txt 를 읽습니다 · 여러 개 선택 가능
                </div>
              </div>
            </>
          )}
        </Card>
      ) : (
        <Card className="mt-8 overflow-hidden">
          <ul className="flex flex-col">
            {staged.map((s) => (
              <li
                key={s.root}
                className="flex items-center gap-3 border-b border-ink-100 px-6 py-4 last:border-b-0"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-500">
                  <FolderOpen size={19} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-semibold text-ink-900">{s.root}</div>
                  <div className="mt-0.5 font-mono text-xs text-ink-400">
                    {s.included.length}개 포함 · {s.excluded.length}개 제외
                  </div>
                </div>
                {!submitting && (
                  <button
                    onClick={() => removeStaged(s.root)}
                    aria-label="폴더 제거"
                    className="shrink-0 rounded-sm p-1.5 text-ink-300 transition-colors hover:bg-red-50 hover:text-red-500 fold-focus"
                  >
                    <X size={16} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {!submitting && (
            <button
              onClick={scanning ? undefined : pick}
              disabled={scanning}
              className="flex w-full items-center justify-center gap-1.5 border-t border-ink-100 bg-ink-50 px-6 py-3 text-xs font-semibold text-blue-600 hover:bg-ink-100 disabled:opacity-60"
            >
              {scanning ? (
                <>
                  <Spinner size={14} className="text-blue-500" /> 폴더를 훑어보는 중…
                </>
              ) : (
                <>
                  <Plus size={14} /> 폴더 더 추가
                </>
              )}
            </button>
          )}
        </Card>
      )}

      {note && !error && (
        <p className="mt-3 rounded-md bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed text-amber-600">
          {note}
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-red-100 bg-red-50 px-3.5 py-3 text-xs text-red-600"
        >
          {error}
        </div>
      )}

      {staged.length > 0 && (
        <div className="mt-6 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Button size="lg" onClick={confirm} loading={submitting}>
              {submitting
                ? workspace.build?.phase?.name === 'convert'
                  ? `문서 변환 중 ${workspace.build.phase.done}/${workspace.build.phase.total}`
                  : (workspace.build?.message ?? '문서를 준비하는 중…')
                : `폴더 ${staged.length}개 · 문서 ${totalIncluded}개로 시작하기`}
            </Button>
            <span className="text-xs text-ink-400">
              {webDemo
                ? '웹 데모에서는 파일 내용이나 API 키를 서버로 전송하지 않습니다.'
                : '변환 ▸ 분석 ▸ 조립 순서로 이 컴퓨터에서 처리합니다.'}
            </span>
          </div>
          {submitting && (
            <div className="flex flex-col gap-1.5" aria-live="polite">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <ProgressBar value={workspace.build?.progress ?? 0} tone="brand" active />
                </div>
                <span className="w-10 shrink-0 text-right font-mono text-xs text-blue-600">
                  {Math.round(workspace.build?.progress ?? 0)}%
                </span>
              </div>
              <span className="truncate text-xs text-ink-400">
                {workspace.build?.message ?? '문서를 준비하는 중…'}
              </span>
            </div>
          )}
        </div>
      )}
    </>
  );
}
