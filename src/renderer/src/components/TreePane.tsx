import { useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronRight,
  Circle,
  Folder,
  FolderOpen,
  Loader2,
} from 'lucide-react';
import type { BuildPhase, BuildState, FileNode, FileStatus, Root } from '@contracts';
import { BUILD_PHASE_LABEL } from '@contracts';
import { cn } from '@/lib/cn';
import { ProgressBar } from '@/ui/ProgressBar';

/** 우측 패널 — 디렉터리 트리(파일별 상태) + 전체 진행률 (스펙 v1.3 §1 L1). */
export function TreePane({
  tree,
  build,
  roots,
}: {
  tree: FileNode[];
  build: BuildState | null;
  roots: Root[];
}) {
  const counts = useMemo(() => countByStatus(tree), [tree]);

  return (
    <aside className="flex min-h-0 flex-col border-l border-ink-100 bg-white">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-ink-100 px-5">
        <span className="fold-eyebrow">문서</span>
        <span className="font-mono text-2xs text-ink-400">
          {counts.done}/{counts.total}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {tree.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs leading-relaxed text-ink-400">
            아직 정리된 문서가 없습니다.
            <br />
            빌드가 끝나면 여기에 나타나요.
          </p>
        ) : (
          <ul className="flex flex-col">
            {tree.map((n) => (
              <TreeNode key={n.path} node={n} depth={0} />
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-ink-100 px-5 py-4">
        <BuildSummary build={build} roots={roots} counts={counts} />
      </div>
    </aside>
  );
}

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);

  if (node.isDir) {
    return (
      <li>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded-sm py-1.5 pr-2 text-left hover:bg-ink-50 fold-focus"
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          <ChevronRight
            size={13}
            className={cn(
              'shrink-0 text-ink-300 transition-transform duration-[--dur-fast]',
              open && 'rotate-90',
            )}
          />
          {open ? (
            <FolderOpen size={14} className="shrink-0 text-ink-400" />
          ) : (
            <Folder size={14} className="shrink-0 text-ink-400" />
          )}
          <span className="truncate text-xs font-medium text-ink-700">{node.name}</span>
        </button>
        {open && node.children && node.children.length > 0 && (
          <ul className="flex flex-col">
            {node.children.map((c) => (
              <TreeNode key={c.path} node={c} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li>
      <button
        onClick={() => window.codegate.shell.openOriginal(node.path)}
        title={`원본 열기 — ${node.path}`}
        className="flex w-full items-center gap-2 rounded-sm py-1.5 pr-2 text-left hover:bg-ink-50 fold-focus"
        style={{ paddingLeft: 8 + depth * 12 + 19 }}
      >
        <StatusIcon status={node.status} />
        <span
          className={cn(
            'truncate text-xs',
            node.status === 'done' ? 'text-ink-600' : 'text-ink-400',
          )}
        >
          {node.name}
        </span>
      </button>
    </li>
  );
}

const STATUS_LABEL: Record<FileStatus, string> = {
  pending: '대기',
  converting: '변환 중',
  done: '완료',
  error: '실패',
};

function StatusIcon({ status }: { status: FileStatus }) {
  const common = 'shrink-0';
  switch (status) {
    case 'done':
      return <Check size={13} className={cn(common, 'text-green-500')} aria-label={STATUS_LABEL.done} />;
    case 'converting':
      return (
        <Loader2
          size={13}
          className={cn(common, 'text-blue-500')}
          style={{ animation: 'fold-spin 1s linear infinite' }}
          aria-label={STATUS_LABEL.converting}
        />
      );
    case 'error':
      return (
        <AlertCircle size={13} className={cn(common, 'text-red-500')} aria-label={STATUS_LABEL.error} />
      );
    default:
      return (
        <Circle size={13} className={cn(common, 'text-ink-300')} aria-label={STATUS_LABEL.pending} />
      );
  }
}

/** 파이프라인 3단계 표시 — 지금 어느 단계인지 한눈에 (스펙 v1.4 §3). */
function PhaseTrack({ current }: { current: BuildPhase }) {
  const order: BuildPhase[] = ['convert', 'enrich', 'assemble'];
  const idx = order.indexOf(current);
  return (
    <div className="flex items-center gap-1">
      {order.map((p, i) => (
        <span
          key={p}
          className={cn(
            'text-2xs font-semibold transition-colors duration-[--dur-base]',
            i < idx && 'text-ink-300',
            i === idx && 'text-blue-600',
            i > idx && 'text-ink-300',
          )}
        >
          {BUILD_PHASE_LABEL[p]}
          {i < order.length - 1 && <span className="mx-1 text-ink-200">▸</span>}
        </span>
      ))}
    </div>
  );
}

function BuildSummary({
  build,
  roots,
  counts,
}: {
  build: BuildState | null;
  roots: Root[];
  counts: { total: number; done: number };
}) {
  const failed = build?.status === 'failed';
  const running = build && build.status !== 'idle' && build.status !== 'done' && !failed;
  const deferred = build?.deferred ?? [];

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-semibold text-ink-700">
          {failed ? '빌드 실패' : running ? '정리 중' : '최신 상태'}
        </span>
        {running && (
          <span className="shrink-0 font-mono text-xs text-blue-600">
            {Math.round(build.progress)}%
          </span>
        )}
      </div>

      {running && build.phase && <PhaseTrack current={build.phase.name} />}

      {(running || failed) && (
        <ProgressBar
          value={failed ? 100 : (build?.progress ?? 0)}
          tone={failed ? 'danger' : 'brand'}
        />
      )}

      <p className={cn('text-2xs leading-relaxed', failed ? 'text-red-600' : 'text-ink-400')}>
        {failed
          ? // 실패해도 이전 빌드는 그대로 유지된다 (스펙 v1.4 §5)
            (build?.error ?? '빌드에 실패했습니다. 이전 위키를 그대로 사용합니다.')
          : running
            ? build.phase
              ? `${BUILD_PHASE_LABEL[build.phase.name]} ${build.phase.done}/${build.phase.total}`
              : build.message || '문서를 정리하는 중…'
            : `${roots.length}개 폴더 · 문서 ${counts.total}개`}
      </p>

      {/* enrichment 부분 실패는 빌드를 죽이지 않고 해당 문서만 보류한다 (스펙 v1.4 §5) */}
      {deferred.length > 0 && (
        <p className="rounded-sm bg-amber-50 px-2 py-1.5 text-2xs leading-relaxed text-amber-600">
          {deferred.length}개 문서는 분석에 실패해 보류했습니다. 다음 빌드에서 다시 시도합니다.
        </p>
      )}
    </div>
  );
}

function countByStatus(nodes: FileNode[]): { total: number; done: number } {
  let total = 0;
  let done = 0;
  const walk = (list: FileNode[]) => {
    for (const n of list) {
      if (n.isDir) {
        if (n.children) walk(n.children);
      } else {
        total += 1;
        if (n.status === 'done') done += 1;
      }
    }
  };
  walk(nodes);
  return { total, done };
}
