import { isIP } from 'node:net';
import { UserFacingError } from '@main/util/errors';
import type { LocalLlmBackend, ResolvedLlmKey } from '@main/build/types';

export const LOCAL_GEMMA_MODEL = 'gemma4:e2b' as const;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
const DEFAULT_CONTEXT_TOKENS = 8_192;

export interface LocalChatUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LocalChatResult {
  content: string;
  model: string;
  baseUrl: string;
  usage: LocalChatUsage;
}

interface ModelList {
  data?: Array<{ id?: unknown }>;
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
  model?: unknown;
  error?: { message?: unknown } | string;
}

export function resolveLocalLlm(
  env: NodeJS.ProcessEnv = process.env,
): Extract<ResolvedLlmKey, { provider: 'local' }> {
  const backend = parseBackend(env.CODEGATE_LOCAL_LLM_BACKEND);
  const baseUrl = env.CODEGATE_LOCAL_LLM_BASE_URL?.trim();
  return {
    provider: 'local',
    backend,
    baseUrl: baseUrl ? normalizeLocalOpenAiBaseUrl(baseUrl) : undefined,
    model: LOCAL_GEMMA_MODEL,
    apiKey: env.CODEGATE_LOCAL_LLM_API_TOKEN?.trim() || undefined,
    timeoutMs: positiveInteger(env.CODEGATE_LOCAL_LLM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxOutputTokens: positiveInteger(
      env.CODEGATE_LOCAL_LLM_MAX_OUTPUT_TOKENS,
      DEFAULT_MAX_OUTPUT_TOKENS,
    ),
    contextTokens: positiveInteger(
      env.CODEGATE_LOCAL_LLM_CONTEXT_TOKENS,
      DEFAULT_CONTEXT_TOKENS,
    ),
  };
}

export class LocalOpenAiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: Extract<ResolvedLlmKey, { provider: 'local' }>,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  async chatJson(input: {
    system: string;
    user: string;
    schema: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<LocalChatResult> {
    const endpoint = await this.resolveEndpoint(input.signal);
    const baseBody = {
      model: endpoint.model,
      temperature: 0,
      max_tokens: this.config.maxOutputTokens,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
    };
    const schemaBody = {
      ...baseBody,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'folding_local_response',
          strict: true,
          schema: input.schema,
        },
      },
    };
    let response = await this.request(
      `${endpoint.baseUrl}/chat/completions`,
      schemaBody,
      input.signal,
    );
    if (response.status === 400 || response.status === 422) {
      response = await this.request(
        `${endpoint.baseUrl}/chat/completions`,
        { ...baseBody, response_format: { type: 'json_object' } },
        input.signal,
      );
    }
    if (!response.ok) {
      throw responseError(response.status, await response.text().catch(() => ''));
    }
    const payload = (await response.json()) as ChatCompletion;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new UserFacingError('로컬 Gemma4 응답에서 JSON 본문을 찾지 못했습니다.');
    }
    return {
      content,
      model: typeof payload.model === 'string' ? payload.model : endpoint.model,
      baseUrl: endpoint.baseUrl,
      usage: {
        inputTokens: finiteNumber(payload.usage?.prompt_tokens),
        outputTokens: finiteNumber(payload.usage?.completion_tokens),
      },
    };
  }

  private async resolveEndpoint(
    signal?: AbortSignal,
  ): Promise<{ baseUrl: string; model: string }> {
    const failures: string[] = [];
    for (const baseUrl of candidateBaseUrls(this.config)) {
      try {
        const response = await this.get(`${baseUrl}/models`, signal);
        if (!response.ok) {
          failures.push(`${baseUrl} HTTP ${response.status}`);
          continue;
        }
        const payload = (await response.json()) as ModelList;
        const models = (payload.data ?? [])
          .map((item) => item.id)
          .filter((item): item is string => typeof item === 'string' && item.length > 0);
        const model = selectGemmaModel(models, this.config.model);
        if (!model) {
          failures.push(`${baseUrl}에 Gemma4 모델이 없습니다`);
          continue;
        }
        return { baseUrl, model };
      } catch (error) {
        failures.push(`${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new UserFacingError(
      '로컬 Gemma4에 연결하지 못했습니다. Ollama에서 `ollama pull gemma4:e2b`를 실행하거나 ' +
        'LM Studio에서 Gemma4 모델을 불러온 뒤 Local Server를 켜 주세요.' +
        (failures.length > 0 ? ` (${failures.join('; ')})` : ''),
    );
  }

  private get(url: string, signal?: AbortSignal): Promise<Response> {
    return this.withTimeout(
      (combinedSignal) =>
        this.fetchImpl(url, {
          headers: this.headers(),
          signal: combinedSignal,
        }),
      signal,
    );
  }

  private request(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.withTimeout(
      (combinedSignal) =>
        this.fetchImpl(url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: combinedSignal,
        }),
      signal,
    );
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
    };
  }

  private async withTimeout(
    operation: (signal: AbortSignal) => Promise<Response>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function normalizeLocalOpenAiBaseUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'http:' ||
    !isLoopbackHost(host) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new UserFacingError('로컬 LLM 주소는 인증정보가 없는 loopback HTTP 주소여야 합니다.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`;
  return url.toString().replace(/\/+$/, '');
}

export function selectGemmaModel(models: string[], requested: string): string | null {
  if (requested !== LOCAL_GEMMA_MODEL) return null;
  const exact = models.find((model) => model === requested);
  if (exact) return exact;
  return (
    models.find((model) => {
      const normalized = model.replace(/[-_.:/ ]/g, '').toLowerCase();
      return normalized.includes('gemma4') && normalized.includes('e2b');
    }) ?? null
  );
}

function candidateBaseUrls(
  config: Extract<ResolvedLlmKey, { provider: 'local' }>,
): string[] {
  if (config.baseUrl) return [config.baseUrl];
  const urls: Partial<Record<LocalLlmBackend, string[]>> = {
    ollama: ['http://127.0.0.1:11434/v1'],
    lmstudio: ['http://127.0.0.1:1234/v1'],
    auto: ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:1234/v1'],
  };
  return urls[config.backend] ?? urls.auto!;
}

function parseBackend(value: string | undefined): LocalLlmBackend {
  const normalized = value?.trim().toLowerCase() || 'auto';
  if (normalized === 'auto' || normalized === 'ollama' || normalized === 'lmstudio') {
    return normalized;
  }
  throw new UserFacingError(
    'CODEGATE_LOCAL_LLM_BACKEND는 auto, ollama, lmstudio 중 하나여야 합니다.',
  );
}

function isLoopbackHost(host: string): boolean {
  if (host.toLowerCase() === 'localhost') return true;
  return isIP(host) > 0 && (host === '::1' || host.startsWith('127.'));
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function responseError(status: number, body: string): UserFacingError {
  const detail = body.slice(0, 300).trim();
  if (status === 404) {
    return new UserFacingError('로컬 Gemma4 모델을 찾지 못했습니다. gemma4:e2b를 설치해 주세요.');
  }
  return new UserFacingError(
    `로컬 Gemma4 요청이 실패했습니다 (HTTP ${status})${detail ? ` ${detail}` : ''}`,
  );
}
