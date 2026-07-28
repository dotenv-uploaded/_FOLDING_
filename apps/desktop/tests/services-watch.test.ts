import { describe, expect, it } from 'vitest';
import type { FileRow } from '@main/db/store';
import { watchChangeNeedsKnowledgeSync } from '@main/services';

const indexed: FileRow = {
  rootId: 'root-1',
  relPath: 'policy.md',
  absPath: '/workspace/policy.md',
  sha256: 'a'.repeat(64),
  size: 10,
  mtime: '2026-07-22T00:00:00.000Z',
  status: 'done',
  dirty: false,
  deleted: false,
};

describe('watch knowledge sync routing', () => {
  it('touch처럼 SHA가 같은 metadata-only 이벤트는 재동기화하지 않는다', () => {
    const touched = { ...indexed, mtime: '2026-07-22T00:01:00.000Z' };
    expect(watchChangeNeedsKnowledgeSync('change', indexed, touched)).toBe(false);
  });

  it('내용 변경과 실제 삭제만 재동기화한다', () => {
    expect(
      watchChangeNeedsKnowledgeSync('change', indexed, {
        ...indexed,
        sha256: 'b'.repeat(64),
        dirty: true,
      }),
    ).toBe(true);
    expect(watchChangeNeedsKnowledgeSync('unlink', indexed, null)).toBe(true);
    expect(watchChangeNeedsKnowledgeSync('unlink', { ...indexed, deleted: true }, null)).toBe(false);
  });
});
