import { describe, expect, it } from 'vitest';
import { runtimeConfig } from '../src/main/runtime-config';

describe('runtimeConfig', () => {
  it('prefers a runtime override over the embedded production value', () => {
    expect(
      runtimeConfig(
        'CODEGATE_CLOUD_API_URL',
        { CODEGATE_CLOUD_API_URL: 'https://runtime.example/api/v1' },
        { CODEGATE_CLOUD_API_URL: 'https://build.example/api/v1' },
      ),
    ).toBe('https://runtime.example/api/v1');
  });

  it('uses the embedded value when the process environment is empty', () => {
    expect(
      runtimeConfig('CODEGATE_BACKEND_URL', {}, { CODEGATE_BACKEND_URL: 'https://api.example' }),
    ).toBe('https://api.example');
  });
});
