import type { FileNode, Root } from '@contracts';

export type SuggestedCommandKey = 'read' | 'edit' | 'delete';

export interface SuggestedCommandGroup {
  key: SuggestedCommandKey;
  label: string;
  description: string;
  commands: string[];
}

interface SuggestedFile {
  name: string;
  path: string;
  extension: string;
  ready: boolean;
}

const EDITABLE_EXTENSIONS = new Set(['hwp', 'hwpx', 'md', 'markdown', 'txt']);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** 현재 폴더 트리만 사용해 실행 가능한 추천 명령을 결정론적으로 만든다. */
export function buildSuggestedCommandGroups(
  tree: FileNode[],
  roots: Root[],
): SuggestedCommandGroup[] {
  const files = uniqueBasenames(collectFiles(tree)).sort(compareSuggestionFiles);
  const readCommands = readSuggestions(files);
  if (readCommands.length === 0) {
    const folder = folderName(roots[0]?.path);
    readCommands.push(
      folder
        ? `${folder} 폴더에서 주요 문서와 담당자를 찾아줘`
        : '등록한 폴더에서 주요 문서와 담당자를 찾아줘',
    );
  }

  const groups: SuggestedCommandGroup[] = [
    {
      key: 'read',
      label: '읽기',
      description: '현재 폴더의 문서를 찾아 핵심 내용을 확인합니다.',
      commands: readCommands,
    },
  ];

  const editable = files.filter((file) => EDITABLE_EXTENSIONS.has(file.extension)).slice(0, 2);
  if (editable.length > 0) {
    groups.push({
      key: 'edit',
      label: '수정',
      description: '수정 가능한 원문의 현재 값을 먼저 확인합니다.',
      commands: editable.map(editSuggestion),
    });
  }

  if (files.length > 0) {
    const commands = [`${files[0]!.name} 파일 지워`];
    if (files.filter((file) => /계약서|contract/i.test(file.name)).length >= 2) {
      commands.push('계약서 전부 다 지워줘');
    }
    groups.push({
      key: 'delete',
      label: '삭제',
      description: '정확한 파일을 확인하고 승인 후 삭제하며 Undo할 수 있습니다.',
      commands,
    });
  }

  return groups;
}

function collectFiles(nodes: FileNode[]): SuggestedFile[] {
  const files: SuggestedFile[] = [];
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.shift()!;
    if (node.isDir) {
      pending.unshift(...(node.children ?? []));
      continue;
    }
    const name = node.name.normalize('NFC');
    if (!name || name.length > 160 || CONTROL_CHARACTER.test(name)) continue;
    files.push({
      name,
      path: node.path,
      extension: extensionOf(name),
      ready: node.status === 'done',
    });
  }
  return files;
}

/** 정확한 파일명 명령이 모호해지는 중복 basename은 추천에서 제외한다. */
function uniqueBasenames(files: SuggestedFile[]): SuggestedFile[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const key = file.name.toLocaleLowerCase('ko-KR');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return files.filter((file) => counts.get(file.name.toLocaleLowerCase('ko-KR')) === 1);
}

function compareSuggestionFiles(left: SuggestedFile, right: SuggestedFile): number {
  if (left.ready !== right.ready) return left.ready ? -1 : 1;
  const score = suggestionPriority(right.name) - suggestionPriority(left.name);
  return score || left.path.localeCompare(right.path, 'ko-KR');
}

function suggestionPriority(name: string): number {
  if (/리스크|위험|일정|schedule|risk/i.test(name)) return 100;
  if (/회의록|미팅|회의|meeting/i.test(name)) return 90;
  if (/성과|업무보고|주간보고|리포트|report/i.test(name)) return 80;
  if (/승인서|신청서|계약서|approval|application|contract/i.test(name)) return 70;
  if (/계획서|기획서|plan/i.test(name)) return 60;
  return 10;
}

function readSuggestions(files: SuggestedFile[]): string[] {
  const commands: string[] = [];
  const categories = new Set<string>();
  for (const file of files) {
    const suggestion = readSuggestion(file);
    if (categories.has(suggestion.category)) continue;
    categories.add(suggestion.category);
    commands.push(suggestion.command);
    if (commands.length === 2) return commands;
  }
  for (const file of files) {
    const command = readSuggestion(file).command;
    if (!commands.includes(command)) commands.push(command);
    if (commands.length === 2) break;
  }
  return commands;
}

function readSuggestion(file: SuggestedFile): { category: string; command: string } {
  const name = file.name;
  if (/리스크|위험|일정|schedule|risk/i.test(name)) {
    return { category: 'schedule', command: `${name}에서 지연 일정, 위험 요소와 담당자를 찾아줘` };
  }
  if (/회의록|미팅|회의|meeting/i.test(name)) {
    return { category: 'meeting', command: `${name}의 결정사항, 담당자와 후속 조치를 요약해줘` };
  }
  if (/성과|업무보고|주간보고|리포트|report/i.test(name)) {
    return { category: 'report', command: `${name}의 주요 성과, 이슈와 다음 할 일을 요약해줘` };
  }
  if (/승인서|신청서|계약서|approval|application|contract/i.test(name)) {
    return { category: 'approval', command: `${name}의 핵심 조건, 승인 내용과 기한을 알려줘` };
  }
  if (/계획서|기획서|plan/i.test(name)) {
    return { category: 'plan', command: `${name}의 목표, 일정과 담당자를 요약해줘` };
  }
  if (file.extension === 'xlsx' || file.extension === 'xls' || file.extension === 'csv') {
    return { category: 'table', command: `${name}에서 일정, 상태와 담당자를 정리해줘` };
  }
  return { category: 'general', command: `${name}의 핵심 내용을 요약해줘` };
}

function editSuggestion(file: SuggestedFile): string {
  if (/업무|보고|회의록/i.test(file.name)) {
    return `${file.name}에서 작성자와 담당자 항목의 현재 값을 알려줘`;
  }
  return `${file.name}에서 수정 가능한 표 항목과 현재 값을 알려줘`;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLocaleLowerCase('en-US') : '';
}

function folderName(folderPath: string | undefined): string | null {
  if (!folderPath) return null;
  const segments = folderPath.replace(/[\\/]+$/, '').split(/[\\/]/);
  const name = segments.at(-1)?.normalize('NFC') ?? '';
  return name && !CONTROL_CHARACTER.test(name) ? name.slice(0, 80) : null;
}
