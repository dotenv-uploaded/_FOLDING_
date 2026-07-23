import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '@main/db/schema';
import { Store, type Db } from '@main/db/store';

/**
 * 구독 사용량.
 *
 * 여기가 틀리면 **돈이 샌다.** 한도를 넘겼는데 계속 쓰이거나, 안 썼는데 막히거나.
 * 그래서 가짜가 아니라 실제 SQL 로 확인한다 — better-sqlite3 는 Electron ABI 라 러너에서
 * 못 열어 Node 내장 `node:sqlite` 로 같은 문을 실행한다.
 */
type Ctor = new (p: string) => {
  exec(sql: string): void;
  prepare(sql: string): { run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown };
  close(): void;
};
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: Ctor };

function memoryStore(): Store {
  const db = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS) db.exec(m);
  const adapter = {
    prepare(sql: string) {
      const s = db.prepare(sql);
      return {
        run: (...p: unknown[]) => s.run(...p),
        all: (...p: unknown[]) => s.all(...p),
        get: (...p: unknown[]) => s.get(...p),
      };
    },
    transaction<T extends unknown[]>(fn: (...a: T) => void) {
      return (...a: T) => {
        db.exec('BEGIN');
        try { fn(...a); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      };
    },
    close: () => db.close(),
  };
  return new Store(adapter as unknown as Db);
}

const at = '2026-07-23T00:00:00.000Z';

describe('사용량 기록', () => {
  it('호출마다 쌓이고 사람별로 나뉜다', () => {
    const s = memoryStore();
    s.recordUsage({ id: 'a', subjectId: 'u1', costUsd: 0.08, source: 'chat', createdAt: at });
    s.recordUsage({ id: 'b', subjectId: 'u1', costUsd: 0.02, source: 'chat', createdAt: at });
    s.recordUsage({ id: 'c', subjectId: 'u2', costUsd: 5, source: 'chat', createdAt: at });

    expect(s.usageTotal('u1').costUsd).toBeCloseTo(0.1, 6);
    expect(s.usageTotal('u1').calls).toBe(2);
    // 다른 사람의 사용량이 섞이면 한도가 엉뚱한 사람에게 걸린다.
    expect(s.usageTotal('u2').costUsd).toBeCloseTo(5, 6);
    expect(s.usageTotal('없는사람').costUsd).toBe(0);
    s.close();
  });

  it('금액을 모르면 0 으로 적지 않고 아예 남기지 않는다', () => {
    const s = memoryStore();
    // 0 으로 적으면 "안 썼다"가 되어 사용량이 조용히 샌다.
    s.recordUsage({ id: 'a', subjectId: 'u1', costUsd: null, source: 'chat', createdAt: at });
    s.recordUsage({ id: 'b', subjectId: 'u1', costUsd: 0, source: 'chat', createdAt: at });
    expect(s.usageTotal('u1').calls).toBe(0);
    s.close();
  });

  it('추가 크레딧이 남은 금액을 늘린다', () => {
    const s = memoryStore();
    expect(s.creditTotalKrw('u1')).toBe(0);
    s.addCreditKrw({ id: 'c1', subjectId: 'u1', amountKrw: 10_000, createdAt: at });
    s.addCreditKrw({ id: 'c2', subjectId: 'u1', amountKrw: 20_000, createdAt: at });
    expect(s.creditTotalKrw('u1')).toBe(30_000);
    expect(s.creditTotalKrw('u2')).toBe(0);
    s.close();
  });
});
