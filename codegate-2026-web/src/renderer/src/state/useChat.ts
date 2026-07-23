import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, Conversation, ConversationUpdate } from '@contracts';
import { AUTH_ERROR_MESSAGE } from '@contracts';

let localSeq = 0;
const localId = (p: string) => `${p}-local-${++localSeq}`;

function sortConversations(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
  );
}

/**
 * L1 — 채팅. 메인에서 오는 AgentEvent 스트림을 메시지로 누적한다.
 *
 * 메인이 SQLite에 영속화하므로 여기 상태는 화면용 캐시다.
 * 대화를 바꾸면 메인에서 다시 읽어온다.
 */
export function useChat() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  /** 401/402 — 사용자 문장으로 배너에 띄운다 (스펙 v1.3 §5, silent fail 금지) */
  const [authError, setAuthError] = useState<string | null>(null);

  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const conversationsRef = useRef<Conversation[]>([]);
  conversationsRef.current = conversations;
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  // 대화 목록 최초 로드 — 없으면 하나 만든다.
  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await window.codegate.chat.list();
      if (!alive) return;
      const visible = list.find((conversation) => !conversation.archived);
      if (!visible) {
        const created = await window.codegate.chat.create();
        if (!alive) return;
        setConversations(sortConversations([created, ...list]));
        setActiveId(created.id);
      } else {
        setConversations(sortConversations(list));
        setActiveId(visible.id);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 활성 대화가 바뀌면 메시지를 다시 읽는다.
  useEffect(() => {
    if (!activeId) return;
    let alive = true;
    window.codegate.chat.messages(activeId).then((m) => alive && setMessages(m));
    return () => {
      alive = false;
    };
  }, [activeId]);

  // AgentEvent 구독 — 스트리밍 누적의 핵심.
  useEffect(() => {
    return window.codegate.chat.onAgentEvent(({ conversationId, messageId, event }) => {
      // 다른 대화의 이벤트는 무시한다 (메인이 이미 영속화했다).
      if (conversationId !== activeIdRef.current) return;

      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === messageId);
        if (i === -1) return prev;
        const msg = { ...prev[i] };
        const next = [...prev];

        switch (event.type) {
          case 'text_delta':
            msg.text += event.text;
            break;
          case 'tool_start':
            msg.tools = [...(msg.tools ?? []), { name: event.name, summary: event.summary }];
            break;
          case 'done':
            msg.citations = event.citations;
            msg.execution = event.execution;
            msg.executions = event.executions ?? msg.executions;
            msg.streaming = false;
            break;
          case 'execution_update': {
            const executions = msg.executions ?? [];
            const index = executions.findIndex(
              (item) => item.executionId === event.execution.executionId,
            );
            msg.executions =
              index === -1
                ? [...executions, event.execution]
                : executions.map((item, itemIndex) =>
                    itemIndex === index ? event.execution : item,
                  );
            msg.execution = event.execution;
            break;
          }
          case 'auth_error':
          case 'approval_request':
            return prev; // 아래 별도 처리
        }
        next[i] = msg;
        return next;
      });

      if (event.type === 'done') setStreaming(false);
      if (event.type === 'auth_error') {
        setAuthError(AUTH_ERROR_MESSAGE[event.kind]);
        setStreaming(false);
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, streaming: false } : m)),
        );
      }
    });
  }, []);

  const send = useCallback(
    async (text: string) => {
      const conversationId = activeIdRef.current;
      if (!conversationId || !text.trim() || streaming) return;
      setAuthError(null);
      setStreaming(true);

      const now = new Date().toISOString();
      const userMsg: ChatMessage = {
        id: localId('u'),
        conversationId,
        role: 'user',
        text,
        createdAt: now,
      };
      setMessages((prev) => [...prev, userMsg]);
      if (!messagesRef.current.some((message) => message.role === 'user')) {
        const title = titleFrom(text);
        setConversations((prev) =>
          sortConversations(
            prev.map((conversation) =>
              conversation.id === conversationId
                ? { ...conversation, title, updatedAt: now }
                : conversation,
            ),
          ),
        );
      }

      try {
        const { messageId } = await window.codegate.chat.send(conversationId, text);
        setMessages((prev) => [
          ...prev,
          {
            id: messageId,
            conversationId,
            role: 'assistant',
            text: '',
            createdAt: new Date().toISOString(),
            streaming: true,
          },
        ]);
      } catch (e) {
        setStreaming(false);
        setAuthError(e instanceof Error ? e.message : '답변을 가져오지 못했습니다.');
      }
    },
    [streaming],
  );

  const abort = useCallback(async () => {
    if (!activeIdRef.current) return;
    await window.codegate.chat.abort(activeIdRef.current);
    setStreaming(false);
    setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
  }, []);

  const createConversation = useCallback(async () => {
    const c = await window.codegate.chat.create();
    setConversations((prev) => sortConversations([c, ...prev]));
    setActiveId(c.id);
    setMessages([]);
  }, []);

  const updateConversation = useCallback(async (id: string, patch: ConversationUpdate) => {
    const updated = await window.codegate.chat.update(id, patch);
    const next = sortConversations(
      conversationsRef.current.map((conversation) =>
        conversation.id === id ? updated : conversation,
      ),
    );
    conversationsRef.current = next;
    setConversations(next);

    if (updated.archived && activeIdRef.current === id) {
      const fallback = next.find((conversation) => !conversation.archived && conversation.id !== id);
      if (fallback) {
        setActiveId(fallback.id);
      } else {
        await createConversation();
      }
    }
  }, [createConversation]);

  const deleteConversation = useCallback(async (id: string) => {
    if (activeIdRef.current === id && streaming) await window.codegate.chat.abort(id);
    await window.codegate.chat.delete(id);
    const next = conversationsRef.current.filter((conversation) => conversation.id !== id);
    conversationsRef.current = next;
    setConversations(next);

    if (activeIdRef.current === id) {
      const fallback = next.find((conversation) => !conversation.archived);
      if (fallback) {
        setActiveId(fallback.id);
      } else {
        await createConversation();
      }
    }
  }, [createConversation, streaming]);

  return {
    conversations,
    activeId,
    setActiveId,
    messages,
    streaming,
    authError,
    dismissAuthError: () => setAuthError(null),
    send,
    abort,
    createConversation,
    updateConversation,
    deleteConversation,
  };
}

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 30 ? `${oneLine.slice(0, 30)}…` : oneLine || '새 채팅';
}
