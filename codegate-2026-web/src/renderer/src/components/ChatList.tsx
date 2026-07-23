import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  MessageSquarePlus,
  Pencil,
  Pin,
  PinOff,
  Settings,
  Trash2,
} from 'lucide-react';
import type { Conversation, ConversationUpdate, Session } from '@contracts';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { Logo } from '@/ui/Wordmark';

interface ContextMenuState {
  conversation: Conversation;
  x: number;
  y: number;
}

/** 좌측 패널 — 채팅 목록. 우클릭으로 대화를 정리한다. */
export function ChatList({
  conversations,
  activeId,
  onSelect,
  onCreate,
  onUpdate,
  onDelete,
  streaming,
  session,
  onOpenSettings,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onUpdate: (id: string, patch: ConversationUpdate) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  streaming: boolean;
  session: Session;
  onOpenSettings: () => void;
}) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const visible = useMemo(
    () => conversations.filter((conversation) => !conversation.archived),
    [conversations],
  );
  const archived = useMemo(
    () => conversations.filter((conversation) => conversation.archived),
    [conversations],
  );

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [menu]);

  function openMenu(event: MouseEvent, conversation: Conversation) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({
      conversation,
      x: Math.min(event.clientX, window.innerWidth - 204),
      y: Math.min(event.clientY, window.innerHeight - 224),
    });
  }

  function rename(conversation: Conversation) {
    const title = window.prompt('대화 이름을 입력하세요.', conversation.title)?.trim();
    if (title && title !== conversation.title) void onUpdate(conversation.id, { title });
  }

  function remove(conversation: Conversation) {
    if (!window.confirm(`“${conversation.title}” 대화를 삭제할까요?\n삭제한 대화는 복구할 수 없습니다.`)) {
      return;
    }
    void onDelete(conversation.id);
  }

  function runMenuAction(action: () => void) {
    setMenu(null);
    action();
  }

  const renderConversation = (conversation: Conversation) => {
    const active = conversation.id === activeId;
    return (
      <li key={conversation.id}>
        <button
          onClick={() => onSelect(conversation.id)}
          onContextMenu={(event) => openMenu(event, conversation)}
          className={cn(
            'group flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left',
            'transition-colors duration-[--dur-fast] ease-[--ease-standard] fold-focus',
            active ? 'bg-blue-50 text-blue-700' : 'text-ink-600 hover:bg-ink-50',
          )}
          title="우클릭하여 대화 정리"
        >
          <span className="flex w-full items-center gap-1.5">
            {conversation.pinned && <Pin size={11} className="shrink-0 fill-current" />}
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[13px]',
                active ? 'font-semibold' : 'font-medium',
              )}
            >
              {conversation.title}
            </span>
          </span>
          <span className="font-mono text-2xs text-ink-400">
            {formatRelative(conversation.updatedAt)}
          </span>
        </button>
      </li>
    );
  };

  return (
    <aside className="flex min-h-0 flex-col border-r border-ink-100 bg-white">
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
        <ul className="flex flex-col gap-0.5 pb-2">{visible.map(renderConversation)}</ul>

        {archived.length > 0 && (
          <div className="border-t border-ink-100 pb-3 pt-2">
            <button
              onClick={() => setShowArchived((value) => !value)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-2xs font-semibold text-ink-400 hover:bg-ink-50 hover:text-ink-600 fold-focus"
            >
              {showArchived ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              보관된 대화 {archived.length}
            </button>
            {showArchived && (
              <ul className="mt-0.5 flex flex-col gap-0.5">{archived.map(renderConversation)}</ul>
            )}
          </div>
        )}
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

      {menu && (
        <div
          role="menu"
          aria-label={`${menu.conversation.title} 대화 메뉴`}
          className="fixed z-50 w-48 rounded-md border border-ink-100 bg-white p-1.5 shadow-lg"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <MenuItem
            icon={menu.conversation.pinned ? PinOff : Pin}
            label={menu.conversation.pinned ? '핀 해제' : '상단에 핀 고정'}
            onClick={() =>
              runMenuAction(() =>
                void onUpdate(menu.conversation.id, { pinned: !menu.conversation.pinned }),
              )
            }
          />
          <MenuItem
            icon={Pencil}
            label="이름 바꾸기"
            onClick={() => runMenuAction(() => rename(menu.conversation))}
          />
          <MenuItem
            icon={menu.conversation.archived ? ArchiveRestore : Archive}
            label={menu.conversation.archived ? '보관 해제' : '보관'}
            disabled={streaming && menu.conversation.id === activeId}
            onClick={() =>
              runMenuAction(() =>
                void onUpdate(menu.conversation.id, { archived: !menu.conversation.archived }),
              )
            }
          />
          <div className="my-1 border-t border-ink-100" />
          <MenuItem
            icon={Trash2}
            label="삭제"
            danger
            disabled={streaming && menu.conversation.id === activeId}
            onClick={() => runMenuAction(() => remove(menu.conversation))}
          />
        </div>
      )}
    </aside>
  );
}

function MenuItem({
  icon: Icon,
  label,
  danger = false,
  disabled = false,
  onClick,
}: {
  icon: typeof Pin;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-xs font-medium fold-focus',
        danger ? 'text-red-600 hover:bg-red-50' : 'text-ink-700 hover:bg-ink-50',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
      )}
      title={disabled ? '답변 생성을 마친 뒤 사용할 수 있습니다.' : undefined}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}
