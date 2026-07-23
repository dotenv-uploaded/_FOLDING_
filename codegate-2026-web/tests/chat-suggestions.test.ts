import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const suggestions = readFileSync(
  resolve('src/renderer/src/components/chat-suggestions.ts'),
  'utf8',
);

describe('chat suggested commands', () => {
  it('groups supported examples into read, edit, and delete actions', () => {
    expect(suggestions).toContain("key: 'read'");
    expect(suggestions).toContain("label: '읽기'");
    expect(suggestions).toContain("key: 'edit'");
    expect(suggestions).toContain("label: '수정'");
    expect(suggestions).toContain("key: 'delete'");
    expect(suggestions).toContain("label: '삭제'");
    expect(suggestions).not.toContain("label: '쓰기'");
  });

  it('shows both exact-file and bulk deletion examples', () => {
    expect(suggestions).toContain('test (1).hwp 파일 지워');
    expect(suggestions).toContain('계약서 전부 다 지워줘');
    expect(suggestions).toContain('승인 후 파일을 삭제하며 Undo할 수 있습니다.');
  });
});
