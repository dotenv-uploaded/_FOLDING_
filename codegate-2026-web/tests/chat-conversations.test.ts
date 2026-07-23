import { describe, expect, it } from 'vitest';
import type { ChatMessage, Conversation } from '@contracts';
import { MIGRATIONS } from '@main/db/schema';
import { Store, type Db } from '@main/db/store';
import { isClosedOutputError } from '@main/util/errors';

describe('conversation organization', () => {
  it('핀, 이름, 보관 상태를 저장하고 핀 대화를 먼저 정렬한다', () => {
    const store = new Store(conversationDb());
    const first = conversation('first', '첫 대화', '2026-07-22T01:00:00.000Z');
    const latest = conversation('latest', '최근 대화', '2026-07-22T02:00:00.000Z');

    try {
      store.createConversation(first);
      store.createConversation(latest);
      expect(store.listConversations().map((item) => item.id)).toEqual(['latest', 'first']);

      expect(
        store.updateConversation(first.id, {
          title: '고정한 대화',
          pinned: true,
          archived: true,
        }),
      ).toMatchObject({ title: '고정한 대화', pinned: true, archived: true });
      expect(store.listConversations().map((item) => item.id)).toEqual(['first', 'latest']);
    } finally {
      store.close();
    }
  });

  it('대화를 삭제하면 소속 메시지도 함께 삭제한다', () => {
    const store = new Store(conversationDb());
    const item = conversation('delete-me', '삭제할 대화', '2026-07-22T02:00:00.000Z');
    const message: ChatMessage = {
      id: 'message-1',
      conversationId: item.id,
      role: 'user',
      text: '질문',
      createdAt: item.updatedAt,
    };

    try {
      store.createConversation(item);
      store.insertMessage(message);
      store.deleteConversation(item.id);

      expect(store.getConversation(item.id)).toBeNull();
      expect(store.listMessages(item.id)).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe('output stream errors', () => {
  it('닫힌 터미널에서 발생하는 EIO와 EPIPE를 식별한다', () => {
    expect(isClosedOutputError(Object.assign(new Error('closed'), { code: 'EIO' }))).toBe(true);
    expect(isClosedOutputError(Object.assign(new Error('closed'), { code: 'EPIPE' }))).toBe(true);
    expect(isClosedOutputError(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe(false);
  });
});

it('대화 정리 컬럼을 기존 DB에 추가하는 migration을 유지한다', () => {
  expect(MIGRATIONS.some((migration) => migration.includes('conversations ADD COLUMN pinned'))).toBe(
    true,
  );
  expect(
    MIGRATIONS.some((migration) => migration.includes('conversations ADD COLUMN archived')),
  ).toBe(true);
});

function conversation(id: string, title: string, updatedAt: string): Conversation {
  return { id, title, updatedAt, pinned: false, archived: false };
}

function conversationDb(): Db {
  const conversations = new Map<
    string,
    { id: string; title: string; updatedAt: string; pinned: number; archived: number }
  >();
  const messages: Array<Record<string, unknown>> = [];

  return {
    prepare(sql: string) {
      return {
        run(...args: unknown[]) {
          if (sql.includes('INSERT INTO conversations')) {
            const [id, title, , updatedAt, pinned, archived] = args;
            conversations.set(String(id), {
              id: String(id),
              title: String(title),
              updatedAt: String(updatedAt),
              pinned: Number(pinned),
              archived: Number(archived),
            });
          } else if (sql.startsWith('UPDATE conversations SET')) {
            const patch = args[0] as Record<string, unknown>;
            const current = conversations.get(String(patch.id));
            if (current) {
              if ('title' in patch) current.title = String(patch.title);
              if ('pinned' in patch) current.pinned = Number(patch.pinned);
              if ('archived' in patch) current.archived = Number(patch.archived);
            }
          } else if (sql.includes('INSERT INTO messages')) {
            const message = args[0] as Record<string, unknown>;
            messages.push({
              id: message.id,
              conversation_id: message.conversationId,
              role: message.role,
              text: message.text,
              citations: message.citations,
              tools: message.tools,
              execution: message.execution,
              changed_path: message.changedPath,
              streaming: message.streaming,
              created_at: message.createdAt,
            });
          } else if (sql.includes('DELETE FROM messages')) {
            const id = String(args[0]);
            for (let index = messages.length - 1; index >= 0; index -= 1) {
              if (messages[index]?.conversation_id === id) messages.splice(index, 1);
            }
          } else if (sql.includes('DELETE FROM conversations')) {
            conversations.delete(String(args[0]));
          }
          return { changes: 1 };
        },
        all(...args: unknown[]) {
          if (sql.includes('FROM conversations')) {
            return [...conversations.values()].sort(
              (a, b) => b.pinned - a.pinned || b.updatedAt.localeCompare(a.updatedAt),
            );
          }
          if (sql.includes('FROM messages')) {
            return messages.filter((message) => message.conversation_id === args[0]);
          }
          return [];
        },
        get(...args: unknown[]) {
          if (sql.includes('FROM conversations')) return conversations.get(String(args[0]));
          return undefined;
        },
      };
    },
    transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) {
      return (...args: TArgs) => fn(...args);
    },
    close() {},
  } as unknown as Db;
}
