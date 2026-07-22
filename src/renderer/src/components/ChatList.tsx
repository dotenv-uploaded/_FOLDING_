import { useState } from 'react';
import { MessageSquarePlus, Settings, Trash2 } from 'lucide-react';
import type { Conversation, Session } from '@contracts';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { Logo } from '@/ui/Wordmark';

/** 좌측 패널 — 채팅 목록. */
export function ChatList({
  conversations,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  session,
  onOpenSettings,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  session: Session;
  onOpenSettings: () => void;
}) {
  /**
   * 삭제를 기다리는 대화. 한 번에 지우지 않고 **같은 자리에서 한 번 더 묻는다** —
   * 기록은 되돌릴 수 없는데 휴지통은 목록을 훑다 스칠 만한 자리에 있다.
   */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  return (
    <aside className="flex min-h-0 flex-col border-r border-ink-100 bg-white">
      {/* 로고는 타이틀바가 아니라 여기 — 창 신호등 바로 아래 자리다. */}
      <div className="px-4 pb-1 pt-4">
        <Logo height={22} />
      </div>

      <div className="p-3">
        <button
          onClick={onCreate}
          className={cn(
            'flex h-[38px] w-full items-center gap-2 rounded-md px-3',
            'text-sm font-semibold text-blue-600',
            'bg-blue-50 hover:bg-blue-100 active:bg-blue-200',
            'transition-colors duration-[--dur-fast] ease-[--ease-standard] fold-focus',
          )}
        >
          <MessageSquarePlus size={17} />
          새 채팅
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-auto px-3">
        <ul className="flex flex-col gap-0.5 pb-3">
          {conversations.map((c) => {
            const active = c.id === activeId;

            if (c.id === pendingDelete) {
              return (
                <li key={c.id}>
                  <div className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-red-800">
                      기록을 지울까요?
                    </span>
                    <button
                      onClick={() => {
                        setPendingDelete(null);
                        onDelete(c.id);
                      }}
                      className="shrink-0 rounded px-1.5 py-0.5 text-2xs font-semibold text-red-700 hover:bg-red-100 fold-focus"
                    >
                      삭제
                    </button>
                    <button
                      onClick={() => setPendingDelete(null)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium text-ink-500 hover:bg-ink-100 fold-focus"
                    >
                      취소
                    </button>
                  </div>
                </li>
              );
            }

            return (
              <li key={c.id} className="group relative">
                <button
                  onClick={() => onSelect(c.id)}
                  className={cn(
                    'flex w-full flex-col items-start gap-0.5 rounded-md py-2 pl-3 pr-9 text-left',
                    'transition-colors duration-[--dur-fast] ease-[--ease-standard] fold-focus',
                    active
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-ink-600 hover:bg-ink-50',
                  )}
                >
                  <span
                    className={cn(
                      'w-full truncate text-[13px]',
                      active ? 'font-semibold' : 'font-medium',
                    )}
                  >
                    {c.title}
                  </span>
                  <span className="font-mono text-2xs text-ink-400">
                    {formatRelative(c.updatedAt)}
                  </span>
                </button>

                {/*
                 * 목록 버튼 안에 넣을 수 없다 — 버튼 안의 버튼은 클릭이 겹친다.
                 * 형제로 두고 위에 얹는다. 키보드로도 닿아야 하므로 focus 에서도 드러낸다.
                 */}
                <button
                  onClick={() => setPendingDelete(c.id)}
                  aria-label={`${c.title} 채팅 삭제`}
                  title="채팅 삭제"
                  className={cn(
                    'absolute right-1.5 top-1.5 rounded p-1.5 text-ink-400',
                    'opacity-0 transition-opacity duration-[--dur-fast] ease-[--ease-standard]',
                    'group-hover:opacity-100 focus-visible:opacity-100',
                    'hover:bg-red-50 hover:text-red-600 fold-focus',
                  )}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="shrink-0 border-t border-ink-100 p-3">
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-ink-50 fold-focus"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-ink-100 text-ink-500">
            <Settings size={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold text-ink-800">
              {session.email ?? '설정'}
            </span>
            <span className="block truncate text-2xs text-ink-400">
              {session.tenantId ?? (session.provisioned ? 'Folding 연결됨' : '권한 확인 필요')}
            </span>
          </span>
        </button>
      </div>
    </aside>
  );
}
