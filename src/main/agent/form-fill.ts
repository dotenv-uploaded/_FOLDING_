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
import { readInternalApiKey, readInternalKeyFor } from '@main/auth/internal-key';
import { fillDocxTemplate, isDocxTemplate, readPlaceholders } from '@main/kordoc/docx-template';
import { logError, UserFacingError } from '@main/util/errors';

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
      // 왜 못 읽었는지 남긴다. 조용히 건너뛰면 "양식이 없다"와 구분이 안 된다.
      const names = await readPlaceholders(full).catch((error: unknown) => {
        logError(`form-fill:read:${entry.name}`, error);
        return [] as string[];
      });
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
/** 빈칸을 채우는 규칙. 제공자가 달라도 지시는 같아야 결과가 흔들리지 않는다. */
const FILL_SYSTEM_PROMPT =
  '너는 문서 양식의 빈칸을 채운다. 값은 **사용자의 요청**과 **참고 문서**에 있는 ' +
  '내용에서만 가져온다. 두 곳 어디에도 근거가 없는 칸은 반드시 빈 문자열("")로 둔다 — ' +
  '이름·날짜·숫자를 지어내면 그럴듯한 거짓 보고서가 된다. ' +
  '참고 문서에서 가져올 때는 원문의 사실을 옮기되 양식 칸에 맞게 간결히 정리한다. ' +
  '여러 항목은 줄바꿈으로 나눈다. JSON 객체 하나만 출력하고 다른 말은 하지 않는다.';

function fillUserPrompt(message: string, names: string[], sources: string): string {
  return (
    `양식의 빈칸 이름: ${JSON.stringify(names)}\n\n` +
    `사용자 요청:\n${message}\n\n` +
    (sources ? `참고 문서 (등록 폴더에서 읽은 실제 업무 기록):\n${sources}\n\n` : '') +
    '각 빈칸에 넣을 값을 JSON 으로만 답해라.'
  );
}

/** 모델이 앞뒤로 말을 붙여도 JSON 객체만 골라낸다. */
function parseFilled(text: string, names: string[]): Record<string, string> {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return Object.fromEntries(names.map((name) => [name, String(parsed[name] ?? '').trim()]));
}

async function extractWithAnthropic(
  message: string,
  names: string[],
  apiKey: string,
  sources: string,
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
      system: FILL_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: fillUserPrompt(message, names, sources) }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic 호출 실패 (HTTP ${response.status}).`);
  }
  const payload = (await response.json()) as { content?: { text?: string }[] };
  return parseFilled(payload.content?.map((block) => block.text ?? '').join('') ?? '', names);
}

async function extractWithGemini(
  message: string,
  names: string[],
  apiKey: string,
  sources: string,
): Promise<Record<string, string>> {
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent' +
    `?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: FILL_SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: fillUserPrompt(message, names, sources) }] }],
      // JSON 만 받겠다고 못 박는다. 코드펜스나 설명이 섞이면 파싱이 흔들린다.
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 2000 },
    }),
  });
  if (!response.ok) {
    throw new Error(`Gemini 호출 실패 (HTTP ${response.status}).`);
  }
  const payload = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text =
    payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
  return parseFilled(text, names);
}

export interface FillKeys {
  anthropic: string | null;
  gemini: string | null;
}

/**
 * 사용자의 문장에서 각 자리에 넣을 값을 뽑는다.
 *
 * 모델에게 **적힌 것만 옮기라**고 못 박는다. 적히지 않은 칸은 빈 문자열로 두게 해서,
 * 뒤에서 "몇 칸이 비었는지" 그대로 사용자에게 알릴 수 있게 한다.
 *
 * 제공자를 둘 다 받는 이유
 * ----------------------
 * 이 경로는 사이드카를 거치지 않으므로, 여기만 살아 있으면 **채팅으로 양식을 채우는 일은
 * 계속 된다.** 한쪽 계정이 막혀도 시연이 멈추지 않게 두 곳을 순서대로 시도한다.
 *
 * **Anthropic(Claude) 경로는 그대로 살아 있다.** 순서만 `CODEGATE_FILL_PROVIDER` 로 고른다:
 *
 *     CODEGATE_FILL_PROVIDER=anthropic   # 예전 그대로 Claude 를 먼저 부른다
 *     CODEGATE_FILL_PROVIDER=gemini      # Gemini 를 먼저 (설정이 없을 때의 기본)
 *
 * 기본을 Gemini 로 둔 것은 취향이 아니라 관측 결과다 — Anthropic 키는 있는데 크레딧이
 * 없어서 매번 실패했고, 그때마다 왕복 한 번이 통째로 버려져 화면에서 눈에 띄게 느려졌다.
 * 크레딧이 충전되면 위 변수만 바꾸면 원래 순서로 돌아온다. 둘 다 없으면 그 사실을 알린다.
 */
export async function extractValues(
  message: string,
  names: string[],
  keys: FillKeys,
  sources: string = '',
  preferred: string = process.env.CODEGATE_FILL_PROVIDER ?? 'gemini',
): Promise<Record<string, string>> {
  const providers: { name: string; key: string | null; run: (key: string) => Promise<Record<string, string>> }[] = [
    { name: 'gemini', key: keys.gemini, run: (k) => extractWithGemini(message, names, k, sources) },
    {
      name: 'anthropic',
      key: keys.anthropic,
      run: (k) => extractWithAnthropic(message, names, k, sources),
    },
  ];
  // 선호하는 쪽을 앞으로. 나머지는 순서를 유지한 채 뒤따른다 — 하나가 막혀도 멈추지 않는다.
  const ordered = [
    ...providers.filter((p) => p.name === preferred),
    ...providers.filter((p) => p.name !== preferred),
  ];
  const attempts = ordered
    .filter((p): p is typeof p & { key: string } => Boolean(p.key))
    .map((p) => ({ name: p.name, run: () => p.run(p.key) }));

  if (attempts.length === 0) {
    throw new UserFacingError('문서 분석 서비스에 연결하지 못했습니다. LLM 키를 확인해 주세요.');
  }

  let last: unknown;
  for (const attempt of attempts) {
    try {
      return await attempt.run();
    } catch (error) {
      // 어느 제공자가 왜 떨어졌는지 남긴다. 조용히 다음으로 넘어가면 "느리다"만 남는다.
      logError(`form-fill:extract:${attempt.name}`, error);
      last = error;
    }
  }
  throw new UserFacingError(
    `양식에 넣을 내용을 만들지 못했습니다. ${last instanceof Error ? last.message : ''}`.trim(),
  );
}

/**
 * 근거로 실어 보낼 글자 수의 상한.
 *
 * 문서 개수가 아니라 글자로 재는 이유는, 개수로 자르면 **짧은 문서 여섯 개**를 담고
 * 정작 필요한 긴 문서를 버리는 일이 생기기 때문이다. 상한은 모델의 한 번 입력에
 * 여유 있게 들어가는 크기로 잡았다 — 등록 폴더가 수백 개로 늘어도 요청이 터지지 않게
 * 막아 두되, 보통 규모(수십 개)에서는 사실상 전부 들어간다.
 */
const SOURCE_BUDGET_CHARS = 120_000;

/**
 * 양식을 채울 **근거**로 쓸 문서를 읽는다.
 *
 * 사용자가 값을 일일이 적지 않아도 "일일업무 보고서 작성해줘" 만으로 채워지려면, 채울
 * 내용이 어딘가에 있어야 한다. 그게 등록 폴더의 실제 업무 기록이다. 지어내는 대신
 * **이미 있는 문서에서** 가져온다.
 *
 * 잘랐으면 잘랐다고 말한다
 * ----------------------
 * 예전에는 `readdir` 순서로 앞 6개만 읽고 문서당 1,800자에서 잘랐다. 그런데 그 순서는
 * 파일시스템이 정하는 것이라 언제든 바뀐다. 실제로 문서 14개 중 8개가 **아무 말 없이**
 * 빠져 있었고, 그날 결과가 멀쩡했던 건 필요한 업무 기록이 우연히 앞쪽에 있었기 때문이다.
 * 문서가 하나만 추가돼도 근거가 조용히 사라지고 빈 양식이 나왔을 것이다 — 그러면 사용자는
 * "왜 안 채워지는지" 알 방법이 없다.
 *
 * 그래서 (1) 이름순으로 **정해진 순서**를 쓰고, (2) 개수가 아니라 글자 예산으로 담고,
 * (3) 예산을 넘겨 버린 문서가 있으면 **로그로 남긴다.**
 */
export async function loadSourceDocuments(
  inputRoot: string,
  budgetChars = SOURCE_BUDGET_CHARS,
): Promise<string> {
  const entries = await fs.readdir(inputRoot).catch(() => [] as string[]);
  // readdir 순서는 보장되지 않는다. 같은 폴더면 같은 근거가 나가도록 정렬한다.
  const names = entries.filter((n) => n.endsWith('.md')).sort();

  const parts: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const name of names) {
    const raw = await fs.readFile(path.join(inputRoot, name), 'utf8').catch(() => '');
    if (!raw) continue;
    // frontmatter 는 계약이라 근거가 아니다. 두 번째 `---` 뒤 본문만 쓴다.
    const end = raw.indexOf('\n---\n', raw.indexOf('---') + 3);
    const body = (end >= 0 ? raw.slice(end + 5) : raw).trim();
    if (!body) continue;
    if (used + body.length > budgetChars) {
      dropped += 1;
      continue;
    }
    parts.push(body);
    used += body.length;
  }

  if (dropped > 0) {
    // 조용히 자르면 "근거를 다 봤다"로 읽힌다. 무엇을 못 봤는지 남긴다.
    logError(
      'form-fill:sources',
      new Error(
        `근거 예산(${budgetChars}자)을 넘겨 ${dropped}/${names.length}개 문서를 제외했습니다.`,
      ),
    );
  }
  return parts.join('\n\n---\n\n');
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
  // 한쪽이 막혀도 양식 채우기는 계속돼야 한다 — 둘 다 넘기고 순서는 extractValues 가 정한다.
  const keys: FillKeys = {
    anthropic: readInternalApiKey(process.env),
    gemini: readInternalKeyFor(process.env, 'gemini'),
  };
  if (!keys.anthropic && !keys.gemini) {
    yield { type: 'text_delta', text: '문서 분석 서비스에 연결하지 못했습니다.' };
    yield { type: 'done', citations: [] };
    return;
  }

  yield {
    type: 'tool_start',
    name: 'fill_form',
    summary: `${path.basename(templatePath)} · ${names.length}개 항목`,
  };
  const sources = await loadSourceDocuments(deps.config.wikiInputRoot ?? '');
  const values = await extractValues(userText, names, keys, sources);
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
