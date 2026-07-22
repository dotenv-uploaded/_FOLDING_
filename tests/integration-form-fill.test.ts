/**
 * 채팅 한 줄로 **실제 파일이 만들어지는지**를 끝에서 끝까지 확인한다.
 *
 * 단위 테스트는 판정기와 자리 표시 파싱까지만 본다. 정작 시연에서 물어보는 것은
 * "채팅을 보내면 채워진 파일이 나오느냐"이고, 그건 에이전트·LLM·승인·docx 쓰기가 전부
 * 이어져야 성립한다. 중간 한 곳만 끊겨도 화면에는 그럴듯한 문장만 남는다.
 *
 * 무엇을 재료로 쓰는가
 * -------------------
 * 경로를 적어 두지 않는다. **앱이 지금 쓰고 있는 것**을 그대로 찾아 쓴다:
 *
 *   등록 폴더  ← 앱 SQLite 의 `roots` 표
 *   양식       ← 그 폴더에서 `findTemplates` 가 찾아낸 것 (파일명을 가정하지 않는다)
 *   채울 근거  ← 위키가 만든 `source-md` (지식그래프의 원본 문서들)
 *
 * 경로를 적어 두면 그 컴퓨터에서만 도는 테스트가 되고, 더 나쁘게는 **앱이 실제로 보는
 * 것과 다른 것을 검증**하게 된다. 위키가 비어 있거나 양식이 없으면 조용히 통과하는 대신
 * 무엇이 없어서 건너뛰는지 말하고 멈춘다.
 *
 * 진짜 LLM 을 부르고 진짜 파일을 만들므로 기본은 꺼 둔다:
 *
 *     CODEGATE_FORM_FILL_INTEGRATION=1 pnpm vitest run tests/integration-form-fill.test.ts
 *
 * 찾아낸 양식은 임시 디렉터리로 **복사해서** 쓴다 — 등록 폴더에 파일을 흘리지 않는다.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, AgentDeps, AgentEvent, ApprovalRequest, KordocApi } from '@contracts';
import { createFormFillAgent, findTemplates } from '@main/agent/form-fill';
import { readPlaceholders } from '@main/kordoc/docx-template';
import { readInternalApiKey, readInternalKeyFor } from '@main/auth/internal-key';

/** 앱이 상태를 두는 곳. Electron 의 `app.getPath('userData')` 와 같은 자리다. */
function userDataDir(): string {
  if (process.env.CODEGATE_USER_DATA_DIR) return process.env.CODEGATE_USER_DATA_DIR;
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'codegate-local');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'codegate-local');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'codegate-local');
}

/** 위키가 변환해 둔 문서들 — 양식을 채울 근거다. */
function wikiInputRoot(): string {
  return (
    process.env.CODEGATE_LLMWIKI_INPUT_ROOT ?? path.join(userDataDir(), 'sidecar', 'source-md')
  );
}

/**
 * 등록된 폴더. 앱의 SQLite 를 직접 읽는다.
 *
 * better-sqlite3 는 Electron ABI 로 빌드돼 있어 테스트 러너에서 열 수 없다. 읽기만 하면
 * 되므로 Node 내장 `node:sqlite` 를 쓴다. (Vite 가 이 내장 모듈을 아직 몰라 `import` 하면
 * 파일로 찾으려다 실패한다 — 실행 시점에 Node 에게 직접 묻는다.)
 */
function registeredRoots(): string[] {
  if (process.env.CODEGATE_FORM_FILL_ROOT) return [process.env.CODEGATE_FORM_FILL_ROOT];
  const dbPath = path.join(userDataDir(), 'codegate.db');
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string, o?: unknown) => {
        prepare(sql: string): { all(): unknown[] };
        close(): void;
      };
    };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return (db.prepare('SELECT path FROM roots ORDER BY added_at').all() as { path: string }[])
        .map((row) => row.path)
        .filter(Boolean);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

const hasKey = Boolean(readInternalKeyFor(process.env, 'gemini') ?? readInternalApiKey(process.env));
const enabled = process.env.CODEGATE_FORM_FILL_INTEGRATION === '1' && hasKey;

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe.skipIf(!enabled)('form fill end-to-end', () => {
  it('앱이 지금 쓰는 등록 폴더와 위키에서 재료를 찾는다', async () => {
    const roots = registeredRoots();
    expect(roots, '등록된 폴더가 없다 — 앱에서 폴더를 먼저 등록해야 한다').not.toHaveLength(0);

    const templates = await findTemplates(roots);
    expect(
      templates,
      `등록 폴더에 자리 표시가 든 .docx 양식이 없다 (찾은 곳: ${roots.join(', ')})`,
    ).not.toHaveLength(0);

    const sources = await fs.readdir(wikiInputRoot()).catch(() => [] as string[]);
    expect(
      sources.filter((name) => name.endsWith('.md')),
      `위키에 변환된 문서가 없다 (${wikiInputRoot()}) — 빌드를 먼저 돌려야 한다`,
    ).not.toHaveLength(0);
  });

  it('채팅 한 줄로 양식을 채운 파일이 실제로 만들어진다', async () => {
    const templates = await findTemplates(registeredRoots());
    const root = await temporaryRoot();
    const templatePath = path.join(root, path.basename(templates[0]!));
    await fs.copyFile(templates[0]!, templatePath);
    const templateBefore = await fs.readFile(templatePath);
    const names = await readPlaceholders(templatePath);

    const approvals: ApprovalRequest[] = [];
    const deps = agentDeps(root, wikiInputRoot(), async (request) => {
      approvals.push(request);
      return true;
    });

    // fallback 이 불리면 양식 채우기가 아니라 sidecar 로 샜다는 뜻이다 — 실패로 친다.
    let fellBack = false;
    const fallback: Agent = {
      // eslint-disable-next-line require-yield
      async *send() {
        fellBack = true;
      },
    };

    const before = await listDocx(root);
    const events = await collect(
      createFormFillAgent(deps, fallback).send(
        '일일업무 보고서 작성에 대한 내용으로 워드 문서 작성해줘',
        { conversationId: 'integration' },
      ),
    );

    expect(fellBack, 'sidecar 로 새면 안 된다').toBe(false);

    // 1) 무엇을 하는지 화면에 알렸는가
    const tools = events.filter((e) => e.type === 'tool_start').map((e) => e.name);
    expect(tools).toContain('find_template');
    expect(tools).toContain('fill_form');

    // 2) 파일을 만들기 **전에** 승인을 받았는가
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.tool).toBe('fill_form');

    // 3) 새 파일이 실제로 생겼는가 — 원본은 그대로인가
    const created = (await listDocx(root)).filter((name) => !before.includes(name));
    expect(created, '새 파일이 하나 생겨야 한다').toHaveLength(1);
    expect(created[0]).not.toBe(path.basename(templatePath));
    expect(await fs.readFile(templatePath), '원본 양식은 건드리지 않는다').toEqual(templateBefore);

    // 4) 그 파일이 실제로 **채워져** 있는가.
    //    값은 위키 문서에서 오므로 무엇이 들어갈지 미리 알 수 없다. 그래서 특정 낱말이
    //    아니라 **자리 표시가 사라지고 내용이 들어찼는지**로 본다.
    const targetPath = path.join(root, created[0]!);
    expect(await readPlaceholders(targetPath), '남은 자리 표시가 없어야 한다').toEqual([]);
    const filled = countFilled(approvals[0]!.diff);
    expect(filled, `${names.length}칸 중 하나도 못 채웠다`).toBeGreaterThan(0);
    const text = await documentText(targetPath);
    expect(text.length, '본문이 비어 있으면 안 된다').toBeGreaterThan(0);

    // 5) 사용자에게 결과를 말했는가
    const said = spoken(events);
    expect(said).toContain(created[0]!);
    expect(events.at(-1)?.type).toBe('done');
  }, 180_000);

  it('승인을 거절하면 파일을 만들지 않는다', async () => {
    const templates = await findTemplates(registeredRoots());
    const root = await temporaryRoot();
    await fs.copyFile(templates[0]!, path.join(root, path.basename(templates[0]!)));

    const before = await listDocx(root);
    const deps = agentDeps(root, wikiInputRoot(), async () => false);
    const events = await collect(
      createFormFillAgent(deps, throwingFallback()).send('일일업무 보고서 작성해줘', {
        conversationId: 'integration-reject',
      }),
    );

    // 거절했는데 파일이 남으면 승인 게이트가 장식이 된다.
    expect(await listDocx(root)).toEqual(before);
    expect(spoken(events)).toContain('취소');
  }, 180_000);
});

/** 승인 화면에 보여 준 미리보기에서 실제로 채워진 칸을 센다 (`+ 이름: 값`). */
function countFilled(diff: string): number {
  return diff.split('\n').filter((line) => line.startsWith('+')).length;
}

function spoken(events: AgentEvent[]): string {
  return events
    .filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
    .map((e) => e.text)
    .join('');
}

function agentDeps(
  root: string,
  inputRoot: string,
  approvalHandler: (request: ApprovalRequest) => Promise<boolean>,
): AgentDeps {
  return {
    config: { roots: [root], backendUrl: '', wikiDir: root, wikiInputRoot: inputRoot },
    auth: { getToken: async () => '', canWrite: () => true },
    kordoc: {} as KordocApi,
    approvalHandler,
  };
}

function throwingFallback(): Agent {
  return {
    // eslint-disable-next-line require-yield
    async *send() {
      throw new Error('sidecar fallback 이 불렸다 — 양식 채우기가 가로채지 못했다.');
    },
  };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

async function listDocx(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries.filter((name) => name.endsWith('.docx')).sort();
}

/** docx 본문 텍스트 — 태그를 걷어내 값이 실제로 들어갔는지 본다. */
async function documentText(file: string): Promise<string> {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const xml = await zip.file('word/document.xml')?.async('string');
  return (xml ?? '').replace(/<[^>]+>/g, '').trim();
}

async function temporaryRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codegate-form-fill-'));
  temporary.push(dir);
  return dir;
}
