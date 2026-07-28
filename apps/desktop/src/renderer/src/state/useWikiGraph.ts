import { useEffect, useMemo, useState } from 'react';
import type { WikiGraph } from '@contracts';
import { buildDocIndex, type DocIndex } from '@/lib/doc-index';
import { buildNetworks, type NetworkIndex } from '@/lib/graph-networks';

/**
 * 활성 위키 빌드의 그래프와, 거기서 뽑은 **문서 네트워크**.
 *
 * 그래프와 문서 트리가 **같은 색을 써야** 한다. 트리에서 파랑 점이 붙은 문서는 그래프에서도
 * 파랑이어야 "아, 저 뭉치구나" 가 성립한다. 그래서 계산을 화면마다 따로 하지 않고 여기서
 * 한 번 해 두 곳에 같은 것을 내려보낸다.
 *
 * `buildId` 가 바뀌면 다시 읽는다 — 빌드가 끝났는데 옛 그래프를 그리고 있으면, 방금 넣은
 * 문서가 없는 것처럼 보인다.
 */
export function useWikiGraph(buildId: string | null | undefined) {
  const [graph, setGraph] = useState<WikiGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.codegate.wiki
      .graph()
      .then((next) => {
        if (!alive) return;
        setGraph(next);
        setError(null);
      })
      .catch((err: unknown) => {
        // 그래프를 못 읽었으면 빈 화면이 아니라 이유를 보여준다.
        if (alive) setError(err instanceof Error ? err.message : '지식 그래프를 불러오지 못했습니다.');
      });
    return () => {
      alive = false;
    };
  }, [buildId]);

  const networks: NetworkIndex = useMemo(
    () => buildNetworks(graph?.nodes ?? [], graph?.edges ?? []),
    [graph],
  );
  const docIndex: DocIndex = useMemo(() => buildDocIndex(graph?.nodes ?? []), [graph]);

  return { graph, error, networks, docIndex };
}
