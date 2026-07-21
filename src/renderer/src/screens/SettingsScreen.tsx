import { FolderOpen, KeyRound, Plus, Trash2 } from 'lucide-react';
import type { Session } from '@contracts';
import type { useWorkspace } from '@/state/useWorkspace';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/ui/Dialog';
import { Button } from '@/ui/Button';
import { Badge } from '@/ui/Badge';
import { LlmKeyForm } from '@/components/LlmKeyForm';
import { useLlmKey } from '@/state/useLlmKey';
import { formatDate } from '@/lib/format';

type Workspace = ReturnType<typeof useWorkspace>;

/** 설정 — 구독 상태 · 등록 폴더 관리 · Anthropic 자격증명 (스펙 v1.3 §3). */
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
  const llmKey = useLlmKey();

  async function addFolder() {
    const path = await workspace.pickFolder();
    if (!path) return;
    await workspace.addRoot(path);
    await workspace.triggerBuild();
  }

  const sub = session.subscription;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[min(640px,calc(100vw-64px))]">
        <DialogHeader title="설정" />

        <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-auto px-7 py-6">
          {/* ── 계정 · 구독 ── */}
          <section>
            <h3 className="fold-eyebrow mb-3">계정</h3>
            <div className="flex items-center gap-3 rounded-md border border-ink-100 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-ink-900">
                  {session.email ?? '로그인됨'}
                </div>
                <div className="mt-0.5 text-xs text-ink-400">
                  {sub ? `${sub.plan} 플랜 · ${formatDate(sub.expiresAt)} 만료` : '구독 정보 없음'}
                </div>
              </div>
              {sub && (
                <Badge tone={sub.active ? 'success' : 'danger'}>
                  {sub.active ? '사용 중' : '만료됨'}
                </Badge>
              )}
            </div>
            {sub && !sub.active && (
              <p className="mt-2 text-xs text-red-600">
                구독이 만료되어 새 빌드를 요청할 수 없습니다. 이미 만들어진 위키는 계속 쓸 수 있어요.
              </p>
            )}
          </section>

          {/* ── 등록 폴더 ── */}
          <section>
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

          {/* ── 자격증명 ② — enrichment LLM 키 (스펙 v1.4 §5) ── */}
          <section>
            <h3 className="fold-eyebrow mb-3">문서 분석 LLM 키</h3>
            <LlmKeyForm keys={llmKey.keys} onSave={llmKey.save} onClear={llmKey.clear} />
          </section>

          {/* ── 자격증명 ③ — Anthropic (SDK 추론). ①·②와 절대 섞지 않는다 ── */}
          <section>
            <h3 className="fold-eyebrow mb-3">Anthropic 자격증명</h3>
            <div className="flex items-start gap-3 rounded-md border border-ink-100 bg-ink-50 px-4 py-3.5">
              <KeyRound size={16} className="mt-0.5 shrink-0 text-ink-400" />
              <div className="min-w-0 flex-1">
                <p className="text-xs leading-relaxed text-ink-600">
                  채팅 추론에 쓰이는 Anthropic 자격증명은 환경변수{' '}
                  <code className="rounded-xs bg-ink-150 px-1 py-0.5 font-mono text-2xs text-ink-700">
                    ANTHROPIC_API_KEY
                  </code>{' '}
                  로 주입됩니다.
                </p>
                <p className="mt-1.5 text-2xs leading-relaxed text-ink-400">
                  위의 문서 분석 키, 로그인 계정과는 각각 별개의 자격증명입니다. 앱에 저장하지
                  않습니다.
                </p>
              </div>
            </div>
          </section>
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
