import type { Session } from '@contracts';
import type { useWorkspace } from '@/state/useWorkspace';
import { useChat } from '@/state/useChat';
import { ChatList } from '@/components/ChatList';
import { ChatPane } from '@/components/ChatPane';
import { TreePane } from '@/components/TreePane';
import { TitleBar } from '@/ui/TitleBar';
import { Badge } from '@/ui/Badge';

type Workspace = ReturnType<typeof useWorkspace>;

/**
 * 메인 화면 (스펙 v1.3 §3).
 *
 *   ┌─ 타이틀바 (로고 · 신호등 자리) ─────────────────┐
 *   ├─────────┬──────────────────┬──────────────────┤
 *   │ 채팅목록 │      채팅        │  트리 + 진행률    │
 *   └─────────┴──────────────────┴──────────────────┘
 *
 * 본문 3분할은 전부 타이틀바 아래에서 시작한다.
 */
export function MainScreen({
  workspace,
  session,
  onOpenSettings,
}: {
  workspace: Workspace;
  session: Session;
  onOpenSettings: () => void;
}) {
  const chat = useChat();
  return (
    <div className="flex h-full flex-col overflow-hidden bg-ink-50">
      <TitleBar
        right={
          <Badge tone={session.provisioned ? 'brand' : 'danger'}>
            {session.provisioned ? '계정 연결됨' : '권한 확인 필요'}
          </Badge>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-[var(--pane-chatlist)_1fr_var(--pane-tree)]">
        <ChatList
          conversations={chat.conversations}
          activeId={chat.activeId}
          onSelect={chat.setActiveId}
          onCreate={chat.createConversation}
          session={session}
          onOpenSettings={onOpenSettings}
        />
        <ChatPane chat={chat} build={workspace.build} />
        <TreePane tree={workspace.tree} build={workspace.build} roots={workspace.roots} />
      </div>
    </div>
  );
}
