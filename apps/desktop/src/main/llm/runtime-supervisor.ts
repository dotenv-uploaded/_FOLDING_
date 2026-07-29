import path from 'node:path';
import { LoopbackProcessSupervisor } from '@main/process/loopback-supervisor';
import { resolveLocalLlm, selectGemmaModel } from './local-openai';

export interface LocalModelRuntimeOptions {
  binary?: string;
  modelsDir: string;
  externalBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class LocalModelRuntimeSupervisor {
  private process: LoopbackProcessSupervisor | null = null;
  private readonly fetchImpl: typeof fetch;
  private readiness: Promise<string> | null = null;

  constructor(private readonly options: LocalModelRuntimeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  ensureReady(onProgress?: (message: string) => void): Promise<string> {
    this.readiness ??= this.ensureReadyOnce(onProgress).catch((error) => {
      this.readiness = null;
      throw error;
    });
    return this.readiness;
  }

  async dispose(): Promise<void> {
    await this.process?.dispose();
    this.process = null;
  }

  private async ensureReadyOnce(onProgress?: (message: string) => void): Promise<string> {
    const config = resolveLocalLlm(process.env);
    const externalBaseUrl = this.options.externalBaseUrl ?? config.baseUrl;
    const candidates = externalBaseUrl
      ? [externalBaseUrl]
      : config.backend === 'ollama'
        ? ['http://127.0.0.1:11434/v1']
        : config.backend === 'lmstudio'
          ? ['http://127.0.0.1:1234/v1']
          : ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:1234/v1'];

    for (const baseUrl of candidates) {
      const models = await this.models(baseUrl).catch(() => null);
      if (!models) continue;
      if (selectGemmaModel(models, config.model)) {
        process.env.CODEGATE_LOCAL_LLM_BASE_URL = baseUrl;
        return baseUrl;
      }
      if (isOllamaUrl(baseUrl)) {
        onProgress?.('Gemma4 경량 모델을 처음 한 번 내려받는 중');
        await this.pullModel(baseUrl, config.model);
        process.env.CODEGATE_LOCAL_LLM_BASE_URL = baseUrl;
        return baseUrl;
      }
      throw new Error('LM Studio에 Gemma4 모델이 로드되지 않았습니다.');
    }

    if (!this.options.binary) {
      throw new Error(
        'Ollama 또는 LM Studio에 연결하지 못했고 설치본의 Ollama 런타임도 없습니다.',
      );
    }
    onProgress?.('내장 Ollama 런타임을 시작하는 중');
    const processSupervisor = new LoopbackProcessSupervisor({
      name: 'ollama',
      command: this.options.binary,
      cwd: path.dirname(this.options.binary),
      args: () => ['serve'],
      env: (origin) => ({
        ...safeProcessEnvironment(process.env),
        OLLAMA_HOST: new URL(origin).host,
        OLLAMA_MODELS: path.resolve(this.options.modelsDir),
        OLLAMA_KEEP_ALIVE: '10m',
        OLLAMA_CONTEXT_LENGTH: String(config.contextTokens),
        OLLAMA_NOHISTORY: '1',
      }),
      healthUrl: (origin) => `${origin}/api/version`,
      ready: async (response) => response.ok,
      fetchImpl: this.fetchImpl,
      readyTimeoutMs: 120_000,
    });
    this.process = processSupervisor;
    const origin = await processSupervisor.start();
    const baseUrl = `${origin}/v1`;
    const models = await this.models(baseUrl);
    if (!selectGemmaModel(models, config.model)) {
      onProgress?.('Gemma4 경량 모델을 처음 한 번 내려받는 중');
      await this.pullModel(baseUrl, config.model);
    }
    process.env.CODEGATE_LOCAL_LLM_BASE_URL = baseUrl;
    process.env.CODEGATE_LOCAL_LLM_BACKEND = 'ollama';
    return baseUrl;
  }

  private async models(baseUrl: string): Promise<string[]> {
    const response = await this.fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`모델 목록 HTTP ${response.status}`);
    const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
    return (payload.data ?? [])
      .map((item) => item.id)
      .filter((item): item is string => typeof item === 'string');
  }

  private async pullModel(baseUrl: string, model: string): Promise<void> {
    const origin = new URL(baseUrl);
    origin.pathname = '/api/pull';
    const response = await this.fetchImpl(origin, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false }),
      signal: AbortSignal.timeout(60 * 60 * 1_000),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      throw new Error(`Gemma4 모델 다운로드 실패 (HTTP ${response.status}) ${detail}`);
    }
  }
}

function isOllamaUrl(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  return url.port === '11434' || process.env.CODEGATE_LOCAL_LLM_BACKEND === 'ollama';
}

function safeProcessEnvironment(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'TZ',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'CUDA_VISIBLE_DEVICES',
    'ROCR_VISIBLE_DEVICES',
    'HIP_VISIBLE_DEVICES',
    'GGML_VK_VISIBLE_DEVICES',
    'OLLAMA_VULKAN',
    'HSA_OVERRIDE_GFX_VERSION',
  ]) {
    if (baseEnv[name] !== undefined) safe[name] = baseEnv[name];
  }
  return safe;
}
