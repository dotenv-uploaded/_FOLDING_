import { useEffect, useState } from 'react';
import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import type { LocalLlmAcceleration, LocalLlmSettings, Session } from '@contracts';
import type { useWorkspace } from '@/state/useWorkspace';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/ui/Dialog';
import { Button } from '@/ui/Button';
import { Badge } from '@/ui/Badge';
import { UsagePanel } from '@/components/UsagePanel';
import { cn } from '@/lib/cn';

type Workspace = ReturnType<typeof useWorkspace>;

type Tab = 'general' | 'usage' | 'account';

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: '일반' },
  { id: 'usage', label: '사용량' },
  { id: 'account', label: '계정' },
];

/**
 * 설정 — 일반(등록 폴더) · 사용량 · 계정 세 갈래로 나눈다.
 *
 * 한 화면에 모두 쌓으면 정작 자주 보는 것(사용량·폴더)이 계정 정보에 묻힌다. 성격이 다른
 * 세 가지를 탭으로 갈라, 필요한 것만 보게 한다.
 *
 * 문서 분석 키 입력란은 없다. 토큰은 구독으로 우리가 내므로 사용자가 키를 넣을 일이 없다.
 */
export function SettingsScreen({
  open,
  onClose,
  session,
  workspace,
  onLogout,
}: {
  open: boolean;
  onClose: () => void;
  session: Session;
  workspace: Workspace;
  onLogout: () => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>('general');
  const [localLlm, setLocalLlm] = useState<LocalLlmSettings | null>(null);
  const [localLlmError, setLocalLlmError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLocalLlmError(null);
    void window.codegate.localLlm
      .settings()
      .then((settings) => {
        if (active) setLocalLlm(settings);
      })
      .catch((error: unknown) => {
        if (active) {
          setLocalLlmError(
            error instanceof Error ? error.message : '로컬 모델 설정을 불러오지 못했습니다.',
          );
        }
      });
    return () => {
      active = false;
    };
  }, [open]);

  async function addFolder() {
    const path = await workspace.pickFolder();
    if (!path) return;
    await workspace.addRoot(path);
  }

  async function setAcceleration(acceleration: LocalLlmAcceleration) {
    setLocalLlmError(null);
    try {
      setLocalLlm(await window.codegate.localLlm.setAcceleration(acceleration));
    } catch (error) {
      setLocalLlmError(
        error instanceof Error ? error.message : '로컬 모델 설정을 저장하지 못했습니다.',
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[min(640px,calc(100vw-64px))]">
        <DialogHeader title="설정" />

        {/* 탭 바 */}
        <div role="tablist" aria-label="설정 분류" className="flex gap-1 border-b border-ink-100 px-7">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                'relative -mb-px px-3 py-2.5 text-sm font-medium transition-colors fold-focus',
                tab === id
                  ? 'text-ink-900 after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:bg-blue-500'
                  : 'text-ink-400 hover:text-ink-700',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-auto px-7 py-6">
          {tab === 'general' && (
            <section>
              <div className="mb-7">
                <h3 className="fold-eyebrow mb-3">로컬 AI</h3>
                <div className="rounded-md border border-ink-100 px-4 py-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold text-ink-900">Gemma 4 e2b</div>
                      <div className="mt-0.5 text-xs text-ink-400">
                        Folding에서 지원하는 로컬 모델
                      </div>
                    </div>
                    <div className="flex rounded-md bg-ink-50 p-1">
                      {(['cpu', 'gpu'] as const).map((acceleration) => (
                        <button
                          key={acceleration}
                          type="button"
                          aria-pressed={localLlm?.acceleration === acceleration}
                          disabled={!localLlm}
                          onClick={() => setAcceleration(acceleration)}
                          className={cn(
                            'rounded-sm px-3 py-1.5 text-xs font-semibold uppercase transition-colors fold-focus',
                            localLlm?.acceleration === acceleration
                              ? 'bg-white text-blue-600 shadow-sm'
                              : 'text-ink-400 hover:text-ink-700',
                          )}
                        >
                          {acceleration}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="mt-3 text-xs leading-5 text-ink-500">
                    CPU가 기본값입니다. GPU를 선택하면 Ollama가 사용 가능한 GPU를 자동 감지합니다.
                    메모리가 부족한 GPU에서는 시작에 실패할 수 있습니다.
                  </p>
                  {localLlm?.restartRequired && (
                    <p className="mt-2 text-xs font-medium text-blue-600">
                      변경사항은 앱을 다시 시작하면 적용됩니다.
                    </p>
                  )}
                  {localLlmError && (
                    <p className="mt-2 text-xs font-medium text-red-600">{localLlmError}</p>
                  )}
                </div>
              </div>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="fold-eyebrow">등록 폴더</h3>
                <Button variant="ghost" size="sm" iconLeft={<Plus size={14} />} onClick={addFolder}>
                  폴더 추가
                </Button>
              </div>
              <ul className="flex flex-col gap-2">
                {workspace.roots.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center gap-3 rounded-md border border-ink-100 px-4 py-3"
                  >
                    <FolderOpen size={16} className="shrink-0 text-ink-400" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-ink-800">{r.path}</div>
                      <div className="mt-0.5 font-mono text-2xs text-ink-400">
                        {r.includedCount}개 포함 · {r.excludedCount}개 제외
                      </div>
                    </div>
                    <button
                      onClick={() => workspace.removeRoot(r.id)}
                      aria-label="폴더 해제"
                      className="shrink-0 rounded-sm p-1.5 text-ink-300 transition-colors hover:bg-red-50 hover:text-red-500 fold-focus"
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
                {workspace.roots.length === 0 && (
                  <li className="rounded-md border border-dashed border-ink-150 px-4 py-6 text-center text-xs text-ink-400">
                    등록된 폴더가 없습니다.
                  </li>
                )}
              </ul>
            </section>
          )}

          {tab === 'usage' && (
            <section>
              <h3 className="fold-eyebrow mb-3">구독 사용량</h3>
              <UsagePanel />
            </section>
          )}

          {tab === 'account' && (
            <section>
              <h3 className="fold-eyebrow mb-3">계정</h3>
              <div className="flex items-center gap-3 rounded-md border border-ink-100 px-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-ink-900">
                    {session.email ?? '로그인됨'}
                  </div>
                  <div className="mt-0.5 text-xs text-ink-400">
                    tenant {session.tenantId ?? '미확인'} · 쓰기 범위 {session.writeScope ?? 'none'}
                  </div>
                </div>
                <Badge tone={session.provisioned ? 'success' : 'danger'}>
                  {session.provisioned ? '권한 연결됨' : '권한 없음'}
                </Badge>
              </div>
              {!session.provisioned && (
                <p className="mt-2 text-xs text-red-600">
                  계정 provisioning이 끝나기 전에는 문서 쓰기 승인을 실행하지 않습니다.
                </p>
              )}
            </section>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={async () => {
              await onLogout();
              onClose();
            }}
          >
            로그아웃
          </Button>
          <Button variant="secondary" onClick={onClose}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
