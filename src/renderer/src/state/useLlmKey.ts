import { useCallback, useEffect, useState } from 'react';
import type { LlmKeyStatus, LlmProvider } from '@contracts';

/**
 * L4 — enrichment LLM 키 (자격증명 ②, 스펙 v1.4 §5).
 *
 * 원문 키는 메인 프로세스만 안다. 여기서 다루는 건 "설정됨 여부 + 끝 4자리"뿐이다.
 * 키가 하나도 없으면 빌드를 시작할 수 없다.
 */
export function useLlmKey() {
  const [keys, setKeys] = useState<LlmKeyStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    window.codegate.llmKey
      .status()
      .then((k) => alive && setKeys(k))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(async (provider: LlmProvider, apiKey: string) => {
    setKeys(await window.codegate.llmKey.set({ provider, apiKey }));
  }, []);

  const clear = useCallback(async (provider: LlmProvider) => {
    setKeys(await window.codegate.llmKey.clear(provider));
  }, []);

  return {
    keys,
    loading,
    /** 하나라도 설정돼 있으면 빌드 가능 */
    configured: keys.some((k) => k.configured),
    save,
    clear,
  };
}
