import { describe, expect, it } from 'vitest';
import type { FileNode, Root } from '@contracts';
import { buildSuggestedCommandGroups } from '@renderer/lib/chat-suggestions';

const roots: Root[] = [
  {
    id: 'root-1',
    path: '/문서/[시연]업무기록',
    includedCount: 4,
    excludedCount: 0,
    addedAt: '2026-07-23T00:00:00.000Z',
  },
];

describe('folder-aware chat suggested commands', () => {
  it('uses the indexed folder filenames and document semantics', () => {
    const groups = buildSuggestedCommandGroups(
      tree(
        'GBX-ONB-003_일정_리스크_추적표.xlsx',
        'GBX-ONB-002_고객온보딩_킥오프회의록.docx',
        '일일업무.hwp',
        '변경승인서.pdf',
      ),
      roots,
    );

    expect(groups.map((group) => group.key)).toEqual(['read', 'edit', 'delete']);
    expect(groups[0]?.commands).toEqual([
      'GBX-ONB-003_일정_리스크_추적표.xlsx에서 지연 일정, 위험 요소와 담당자를 찾아줘',
      'GBX-ONB-002_고객온보딩_킥오프회의록.docx의 결정사항, 담당자와 후속 조치를 요약해줘',
    ]);
    expect(groups[1]?.commands).toEqual([
      '일일업무.hwp에서 작성자와 담당자 항목의 현재 값을 알려줘',
    ]);
    expect(groups[2]?.commands[0]).toContain('GBX-ONB-003_일정_리스크_추적표.xlsx 파일 지워');
  });

  it('does not suggest editing for read-only formats', () => {
    const groups = buildSuggestedCommandGroups(tree('주간 성과보고.pdf', '계획서.docx'), roots);

    expect(groups.map((group) => group.key)).toEqual(['read', 'delete']);
    expect(groups.flatMap((group) => group.commands).join('\n')).not.toContain('test (1).hwp');
  });

  it('recomputes commands when the selected folder tree changes', () => {
    const before = buildSuggestedCommandGroups(tree('기존 회의록.docx'), roots);
    const after = buildSuggestedCommandGroups(tree('신규 주간 성과보고.pptx'), roots);

    expect(before[0]?.commands[0]).toContain('기존 회의록.docx');
    expect(after[0]?.commands[0]).toContain('신규 주간 성과보고.pptx');
    expect(after.flatMap((group) => group.commands).join('\n')).not.toContain('기존 회의록.docx');
  });

  it('uses the folder name while indexing and offers bulk deletion only for multiple contracts', () => {
    expect(buildSuggestedCommandGroups([], roots)[0]?.commands).toEqual([
      '[시연]업무기록 폴더에서 주요 문서와 담당자를 찾아줘',
    ]);

    const groups = buildSuggestedCommandGroups(tree('계약서 A.hwp', '계약서 B.pdf'), roots);
    expect(groups.find((group) => group.key === 'delete')?.commands).toContain(
      '계약서 전부 다 지워줘',
    );
  });

  it('omits duplicate or control-character basenames from exact-file suggestions', () => {
    const nodes = tree('중복문서.hwp', '중복문서.hwp', '위험\n명령.pdf');
    const commands = buildSuggestedCommandGroups(nodes, roots)
      .flatMap((group) => group.commands)
      .join('\n');

    expect(commands).not.toContain('중복문서.hwp');
    expect(commands).not.toContain('위험\n명령.pdf');
  });
});

function tree(...names: string[]): FileNode[] {
  return [
    {
      path: '업무기록',
      name: '업무기록',
      isDir: true,
      status: 'done',
      children: names.map((name, index) => ({
        path: `업무기록/${index}/${name}`,
        name,
        isDir: false,
        status: 'done',
      })),
    },
  ];
}
