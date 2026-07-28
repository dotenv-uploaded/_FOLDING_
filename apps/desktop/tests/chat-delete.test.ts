import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '@main/db/schema';
import { Store, type Db } from '@main/db/store';

/**
 * 채팅 기록 삭제.
 *
 * `messages` 에는 `conversations` 로 향하는 외래키가 없다. 그래서 "지웠다"고 말해 놓고
 * 원문만 DB 에 남는 사고가 가능하다 — 목록에는 안 보이니 눈으로는 확인되지도 않는다.
 * 지우는 일은 되돌릴 수 없어서, SQL 이 실제로 무엇을 지우는지가 곧 계약이다.
 *
 * 그래서 가짜 DB 를 쓰지 않는다. 앱이 쓰는 better-sqlite3 은 Electron ABI 로 빌드돼 있어
 * 테스트 러너(시스템 node)에서 열 수 없으므로, **같은 SQL 을 그대로 실행하는** Node 내장
 * `node:sqlite` 로 확인한다. 검증하려는 것은 바인딩이 아니라 SQL 이다.
 */
describe('deleteConversation', () => {
  it('대화와 그 안의 메시지를 함께 지운다', () => {
    const store = new Store(memoryDb());
    try {
      seed(store, 'conv-a', ['첫 질문', '답변']);
      seed(store, 'conv-b', ['남아야 할 질문']);

      store.deleteConversation('conv-a');

      expect(store.getConversation('conv-a')).toBeNull();
      // 목록에서 사라지는 것만으로는 부족하다 — 메시지 자체가 없어야 한다.
      expect(store.listMessages('conv-a')).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('다른 대화는 건드리지 않는다', () => {
    const store = new Store(memoryDb());
    try {
      seed(store, 'conv-a', ['지울 것']);
      seed(store, 'conv-b', ['남길 것', '이것도']);

      store.deleteConversation('conv-a');

      expect(store.listConversations().map((c) => c.id)).toEqual(['conv-b']);
      expect(store.listMessages('conv-b').map((m) => m.text)).toEqual(['남길 것', '이것도']);
    } finally {
      store.close();
    }
  });

  it('없는 대화를 지워도 조용히 넘어간다', () => {
    const store = new Store(memoryDb());
    try {
      seed(store, 'conv-a', ['남을 것']);
      // 삭제 버튼을 두 번 누르는 일은 실제로 일어난다. 두 번째가 터지면 안 된다.
      expect(() => store.deleteConversation('없는-대화')).not.toThrow();
      expect(store.listConversations()).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

function seed(store: Store, conversationId: string, texts: string[]): void {
  store.createConversation({
    id: conversationId,
    title: conversationId,
    updatedAt: '2026-07-22T00:00:00.000Z',
  });
  texts.forEach((text, index) => {
    store.insertMessage({
      id: `${conversationId}-m${index}`,
      conversationId,
      role: index % 2 === 0 ? 'user' : 'assistant',
      text,
      createdAt: `2026-07-22T00:00:0${index}.000Z`,
    });
  });
}

/**
 * `node:sqlite` 를 better-sqlite3 이 노출하는 모양으로 맞춘 얇은 어댑터.
 *
 * `Store` 가 쓰는 것만 채운다 — prepare / transaction / close. 트랜잭션은 실제
 * BEGIN·ROLLBACK 이라, 중간에 실패하면 진짜로 되돌아간다.
 */
/*
 * `node:sqlite` 는 Vite 의 내장 모듈 목록에 아직 없어서 `import` 하면 번들러가
 * 파일로 찾으려다 실패한다. 실행 시점에 Node 에게 직접 묻는다.
 */
type DatabaseSyncCtor = new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): { run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown };
  close(): void;
};
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: DatabaseSyncCtor;
};

function memoryDb(): Db {
  const db = new DatabaseSync(':memory:');
  for (const migration of MIGRATIONS) db.exec(migration);

  const adapter = {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      // `Store` 는 위치 파라미터(`?`)를 여러 개 넘기기도 한다 — 전부 그대로 흘려보낸다.
      return {
        run: (...params: unknown[]) => statement.run(...params),
        all: (...params: unknown[]) => statement.all(...params),
        get: (...params: unknown[]) => statement.get(...params),
      };
    },
    transaction<TArgs extends unknown[]>(fn: (...args: TArgs) => void) {
      return (...args: TArgs) => {
        db.exec('BEGIN');
        try {
          fn(...args);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      };
    },
    close: () => db.close(),
  };
  return adapter as unknown as Db;
}
