import { useState } from 'react';
import { ChevronDown, FolderOpen, FolderPlus } from 'lucide-react';
import type { ScanPreview, Session } from '@contracts';
import type { useWorkspace } from '@/state/useWorkspace';
import { useLlmKey } from '@/state/useLlmKey';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Badge } from '@/ui/Badge';
import { TitleBar } from '@/ui/TitleBar';
import { Spinner } from '@/ui/Spinner';
import { ProgressBar } from '@/ui/ProgressBar';
import { LlmKeyForm } from '@/components/LlmKeyForm';

type Workspace = ReturnType<typeof useWorkspace>;

/**
 * 온보딩 (스펙 v1.4 §3).
 *   로그인 → **LLM API 키 설정** → 폴더 등록 → 스캔 미리보기 → 로컬 빌드
 *
 * v1.4 에서 빌드는 전부 이 컴퓨터에서 돈다. enrichment 가 LLM 을 직접 호출하므로
 * 키가 없으면 빌드를 시작할 수 없다 — 그래서 키 설정이 폴더 등록보다 앞에 온다.
 */
export function OnboardingScreen({
  workspace,
  session,
}: {
  workspace: Workspace;
  session: Session;
}) {
  const llmKey = useLlmKey();
  const anthropicConfigured = llmKey.keys.some(
    (key) => key.provider === 'anthropic' && key.configured,
  );

  if (llmKey.loading) return <Shell session={session} />;

  return (
    <Shell session={session}>
      {llmKey.configured && anthropicConfigured ? (
        <FolderStep workspace={workspace} />
      ) : (
        <KeyStep llmKey={llmKey} />
      )}
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

/* ── STEP 1 — LLM API 키 ───────────────────────────────────────────────── */

function KeyStep({ llmKey }: { llmKey: ReturnType<typeof useLlmKey> }) {
  return (
    <>
      <span className="fold-eyebrow">STEP 1 · 분석 키 설정</span>
      <h1 className="mt-3 text-h2 font-bold tracking-tight text-ink-950">
        문서를 읽을 Anthropic 키가 필요해요.
      </h1>
      <p className="mt-2.5 text-base leading-relaxed text-ink-500">
        로컬 sidecar의 Claude Agent SDK가 문서를 검색하고 변경안을 만들 때 Anthropic API를
        사용합니다. 변환·조립과 원본 처리는 이 컴퓨터에서 이뤄지고,
        <br />
        문서가 저희 서버로 전송되는 일은 없습니다.
      </p>

      <Card className="mt-8 p-6">
        <LlmKeyForm keys={llmKey.keys} onSave={llmKey.save} onClear={llmKey.clear} />
      </Card>
    </>
  );
}

/* ── STEP 2 — 폴더 등록 ────────────────────────────────────────────────── */

function FolderStep({ workspace }: { workspace: Workspace }) {
  const [preview, setPreview] = useState<ScanPreview | null>(null);
  const [scanning, setScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);

  async function pick() {
    setError(null);
    const path = await workspace.pickFolder();
    if (!path) return;
    setScanning(true);
    try {
      setPreview(await workspace.scanPreview(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : '폴더를 읽지 못했습니다.');
    } finally {
      setScanning(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setSubmitting(true);
    setError(null);
    try {
      await workspace.addRoot(preview.root);
      // 폴더만 등록되면 App이 즉시 메인 화면으로 넘긴다.
      // 정규화·위키 조립·검색 엔진 준비는 메인 화면에서 백그라운드로 이어진다.
    } catch (e) {
      setSubmitting(false);
      setError(e instanceof Error ? e.message : '빌드를 시작하지 못했습니다.');
    }
  }

  return (
    <>
      <span className="fold-eyebrow">STEP 2 · 폴더 등록</span>
      <h1 className="mt-3 text-h2 font-bold tracking-tight text-ink-950">
        어떤 폴더를 정리할까요?
      </h1>
      <p className="mt-2.5 text-base leading-relaxed text-ink-500">
        선택한 폴더의 문서를 읽어 위키로 만듭니다. 위키는 이 컴퓨터에만 저장돼요.
        <br />
        나중에 언제든 폴더를 추가하거나 해제할 수 있어요.
      </p>

      {!preview ? (
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
                  hwp · hwpx · docx · pdf · md · txt 를 읽습니다
                </div>
              </div>
            </>
          )}
        </Card>
      ) : (
        <Card className="mt-8 overflow-hidden">
          <div className="flex items-center gap-3 border-b border-ink-100 px-6 py-5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-500">
              <FolderOpen size={19} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-semibold text-ink-900">{preview.root}</div>
              <div className="mt-0.5 font-mono text-xs text-ink-400">
                {preview.included.length}개 포함 · {preview.excluded.length}개 제외
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={pick} disabled={submitting}>
              변경
            </Button>
          </div>

          <div className="max-h-[200px] overflow-auto px-6 py-4">
            <ul className="flex flex-col gap-1.5">
              {preview.included.slice(0, 40).map((p) => (
                <li key={p} className="truncate font-mono text-xs text-ink-600">
                  {p}
                </li>
              ))}
            </ul>
            {preview.included.length > 40 && (
              <div className="mt-2 text-xs text-ink-400">외 {preview.included.length - 40}개</div>
            )}
          </div>

          {preview.excluded.length > 0 && (
            <div className="border-t border-ink-100 bg-ink-50">
              <button
                onClick={() => setShowExcluded((v) => !v)}
                className="flex w-full items-center gap-2 px-6 py-3 text-xs font-semibold text-ink-600 hover:bg-ink-100"
              >
                <ChevronDown
                  size={15}
                  className={showExcluded ? 'rotate-180 transition-transform' : 'transition-transform'}
                />
                제외된 {preview.excluded.length}개 보기
              </button>
              {showExcluded && (
                <ul className="max-h-[160px] overflow-auto px-6 pb-4">
                  {preview.excluded.slice(0, 60).map((e) => (
                    <li key={e.path} className="flex gap-2 py-0.5 font-mono text-xs">
                      <span className="min-w-0 flex-1 truncate text-ink-400">{e.path}</span>
                      <span className="shrink-0 text-ink-300">{e.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Card>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-red-100 bg-red-50 px-3.5 py-3 text-xs text-red-600"
        >
          {error}
        </div>
      )}

      {preview && (
        <div className="mt-6 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Button size="lg" onClick={confirm} loading={submitting}>
              {submitting
                ? workspace.build?.phase?.name === 'convert'
                  ? `문서 변환 중 ${workspace.build.phase.done}/${workspace.build.phase.total}`
                  : (workspace.build?.message ?? '문서를 준비하는 중…')
                : `${preview.included.length}개 문서로 시작하기`}
            </Button>
            <span className="text-xs text-ink-400">
              변환 ▸ 분석 ▸ 조립 순서로 이 컴퓨터에서 처리합니다.
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
