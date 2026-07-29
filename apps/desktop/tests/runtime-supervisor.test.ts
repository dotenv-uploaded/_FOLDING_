import { describe, expect, it } from 'vitest';
import { safeProcessEnvironment } from '@main/llm/runtime-supervisor';

describe('local model runtime environment', () => {
  it('defaults bundled Ollama to CPU', () => {
    expect(safeProcessEnvironment({ PATH: 'C:\\Windows' })).toMatchObject({
      PATH: 'C:\\Windows',
      OLLAMA_LLM_LIBRARY: 'cpu',
    });
  });

  it('lets Ollama auto-detect a GPU only when the user selects GPU', () => {
    const environment = safeProcessEnvironment(
      { OLLAMA_LLM_LIBRARY: 'cpu', CUDA_VISIBLE_DEVICES: '0' },
      'gpu',
    );
    expect(environment).toMatchObject({
      CUDA_VISIBLE_DEVICES: '0',
    });
    expect(environment).not.toHaveProperty('OLLAMA_LLM_LIBRARY');
  });

});
