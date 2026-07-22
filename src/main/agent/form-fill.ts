/**
 * 채팅으로 **양식을 채워 파일로 내보내는** 경로.
 *
 * 왜 sidecar 를 거치지 않는가
 * -------------------------
 * sidecar 의 변경 계약(`replace_exact`)은 기존 문서의 한 대목을 정확히 지목해 바꾸는 데
 * 맞춰져 있다. 양식 채우기는 성격이 다르다 — 여러 칸을 한꺼번에 채우고, 원본이 아니라
 * **새 파일**을 만들며, 되돌릴 원본이 없다. 그 계약에 억지로 태우면 관문마다 걸린다.
 *
 * 그래서 이 경로는 앱이 직접 처리한다. 다만 **승인은 그대로 거친다** — 파일이 만들어지기
 * 전에 사용자가 무엇이 채워지는지 보고 승인해야 한다.
 *
 * 채우는 값은 지어내지 않는다
 * -------------------------
 * 값은 사용자가 이번 메시지에 적은 내용에서만 뽑는다. 적히지 않은 칸은 비워 둔다.
 * 이름·날짜·숫자를 모델이 만들어 채우면 그럴듯한 거짓 보고서가 되어 나간다.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Agent, AgentDeps, AgentEvent } from '@contracts';
import { readInternalApiKey } from '@main/auth/internal-key';
import { fillDocxTemplate, isDocxTemplate, readPlaceholders } from '@main/kordoc/docx-template';
import { logError } from '@main/util/errors';

/** 양식을 채워 달라는 말인가. */
export function isFormFillRequest(text: string): boolean {
  const t = text.replace(/\s+/g, '');
  const wantsForm = /양식|서식|보고서|보고|일지|템플릿/.test(t);
  const wantsFill = /채워|채우|작성|만들어|써줘|기입/.test(t);
  return wantsForm && wantsFill;
}

/** 등록 폴더에서 자리 표시가 들어 있는 Word 양식을 찾는다. */
export async function findTemplates(roots: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !isDocxTemplate(entry.name)) continue;
      // `~$` 로 시작하는 것은 Word 가 만든 임시 잠금 파일이다.
      if (entry.name.startsWith('~$')) continue;
      const full = path.join(root, entry.name);
      const names = await readPlaceholders(full).catch(() => []);
      if (names.length > 0) found.push(full);
    }
  }
  return found;
}

/**
 * 사용자의 문장에서 각 자리에 넣을 값을 뽑는다.
 *
 * 모델에게 **적힌 것만 옮기라**고 못 박는다. 적히지 않은 칸은 빈 문자열로 두게 해서,
 * 뒤에서 "몇 칸이 비었는지" 그대로 사용자에게 알릴 수 있게 한다.
 */
export async function extractValues(
  message: string,
  names: string[],
  apiKey: string,
): Promise<Record<string, string>> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system:
        '너는 문서 양식의 빈칸을 채운다. 사용자의 문장에 **적혀 있는 내용만** 옮겨 적는다. ' +
        '적히지 않은 칸은 반드시 빈 문자열("")로 둔다. 이름·날짜·숫자·부서를 추측하거나 ' +
        '만들어 넣지 않는다. 여러 항목은 줄바꿈으로 나눈다. ' +
        'JSON 객체 하나만 출력하고 다른 말은 하지 않는다.',
      messages: [
        {
          role: 'user',
          content: `양식의 빈칸 이름: ${JSON.stringify(names)}\n\n사용자 요청:\n${message}\n\n각 빈칸에 넣을 값을 JSON 으로만 답해라.`,
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`값을 뽑아내지 못했습니다 (HTTP ${response.status}).`);
  }
  const payload = (await response.json()) as { content?: { text?: string }[] };
  const text = payload.content?.map((block) => block.text ?? '').join('') ?? '';
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return Object.fromEntries(names.map((name) => [name, String(parsed[name] ?? '').trim()]));
}

/** 겹치지 않는 이름을 고른다 — 이미 있는 파일을 덮지 않는다. */
async function uniqueTarget(templatePath: string): Promise<string> {
  const dir = path.dirname(templatePath);
  const base = path.basename(templatePath, '.docx').replace(/_?양식$/, '');
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  for (let n = 1; n < 100; n += 1) {
    const name = n === 1 ? `${base}_${stamp}.docx` : `${base}_${stamp} (${n}).docx`;
    const candidate = path.join(dir, name);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error('저장할 이름을 정하지 못했습니다.');
}

/**
 * 양식 채우기를 처리하는 에이전트. 해당 요청이 아니면 `fallback` 에 그대로 넘긴다.
 */
export function createFormFillAgent(deps: AgentDeps, fallback: Agent): Agent {
  return {
    send(userText, options): AsyncIterable<AgentEvent> {
      if (!isFormFillRequest(userText)) return fallback.send(userText, options);
      return run(deps, fallback, userText, options);
    },
  };
}

async function* run(
  deps: AgentDeps,
  fallback: Agent,
  userText: string,
  options: Parameters<Agent['send']>[1],
): AsyncGenerator<AgentEvent> {
  yield { type: 'tool_start', name: 'find_template', summary: '등록 폴더에서 양식을 찾는 중' };
  const templates = await findTemplates(deps.config.roots).catch((error: unknown) => {
    logError('form-fill:find', error);
    return [] as string[];
  });
  if (templates.length === 0) {
    // 양식이 없으면 우리 일이 아니다 — 원래 에이전트가 답하게 둔다.
    yield* fallback.send(userText, options);
    return;
  }

  const templatePath = templates[0];
  const names = await readPlaceholders(templatePath);
  const apiKey = readInternalApiKey(process.env);
  if (!apiKey) {
    yield { type: 'text_delta', text: '문서 분석 서비스에 연결하지 못했습니다.' };
    yield { type: 'done', citations: [] };
    return;
  }

  yield {
    type: 'tool_start',
    name: 'fill_form',
    summary: `${path.basename(templatePath)} · ${names.length}개 항목`,
  };
  const values = await extractValues(userText, names, apiKey);
  const filled = names.filter((name) => values[name]);
  const missing = names.filter((name) => !values[name]);

  // 무엇이 채워지는지 보여주고 승인을 받는다. 승인 전에는 파일을 만들지 않는다.
  const preview = names
    .map((name) => `${values[name] ? '+' : ' '} ${name}: ${values[name] || '(비어 있음)'}`)
    .join('\n');
  yield { type: 'approval_request', diff: preview, target: templatePath };
  const approved = await deps.approvalHandler({
    tool: 'fill_form',
    target: path.basename(templatePath),
    diff: preview,
    rationale: `${filled.length}/${names.length}개 항목을 채웁니다.`,
  });
  if (!approved) {
    yield { type: 'text_delta', text: '\n\n취소했습니다. 파일을 만들지 않았습니다.' };
    yield { type: 'done', citations: [] };
    return;
  }

  const targetPath = await uniqueTarget(templatePath);
  await fillDocxTemplate({ templatePath, values, targetPath });

  const summary =
    `「${path.basename(targetPath)}」 를 만들었습니다.\n\n` +
    `양식 ${path.basename(templatePath)} 의 ${names.length}개 항목 중 ${filled.length}개를 채웠습니다.` +
    (missing.length > 0
      ? `\n\n채우지 못한 항목: ${missing.join(', ')} — 요청에 내용이 없어 비워 뒀습니다.`
      : '');
  yield { type: 'text_delta', text: summary };
  yield { type: 'done', citations: [] };
}
