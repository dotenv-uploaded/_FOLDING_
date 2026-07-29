import { describe, expect, it, vi } from 'vitest';
import {
  LocalOpenAiClient,
  normalizeLocalOpenAiBaseUrl,
  resolveLocalLlm,
  selectGemmaModel,
} from '@main/llm/local-openai';
import type { ResolvedLlmKey } from '@main/build/types';

const config: Extract<ResolvedLlmKey, { provider: 'local' }> = {
  provider: 'local',
  backend: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'gemma4:e2b',
  timeoutMs: 5_000,
  maxOutputTokens: 512,
  contextTokens: 8_192,
};

describe('local OpenAI-compatible client', () => {
  it('always resolves the supported Gemma 4 e2b model', () => {
    expect(resolveLocalLlm({ CODEGATE_LOCAL_LLM_MODEL: 'other-model' }).model).toBe(
      'gemma4:e2b',
    );
    expect(selectGemmaModel(['gemma4:e4b'], 'gemma4:e2b')).toBeNull();
  });

  it('loopback 주소만 허용하고 /v1을 보존한다', () => {
    expect(normalizeLocalOpenAiBaseUrl('http://localhost:11434')).toBe(
      'http://localhost:11434/v1',
    );
    expect(normalizeLocalOpenAiBaseUrl('http://127.0.0.1:1234/v1/')).toBe(
      'http://127.0.0.1:1234/v1',
    );
    expect(() => normalizeLocalOpenAiBaseUrl('https://example.com/v1')).toThrow(/loopback/);
  });

  it('정확한 모델을 우선하고 Gemma4 계열 이름으로 폴백한다', () => {
    expect(selectGemmaModel(['gemma4:e2b', 'gemma4:e4b'], 'gemma4:e2b')).toBe('gemma4:e2b');
    expect(selectGemmaModel(['google/gemma-4-e2b-it'], 'gemma4:e2b')).toBe(
      'google/gemma-4-e2b-it',
    );
  });

  it('모델 검색 뒤 structured JSON completion을 호출한다', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'gemma4:e2b' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'gemma4:e2b',
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 12, completion_tokens: 4 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const result = await new LocalOpenAiClient(config, fetchImpl).chatJson({
      system: 'system',
      user: 'user',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
    });

    expect(result).toMatchObject({
      content: '{"ok":true}',
      model: 'gemma4:e2b',
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:11434/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
