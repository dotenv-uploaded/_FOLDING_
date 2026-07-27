/**
 * 파일 경로로 위키 문서를 찾는다.
 *
 * 두 값의 모양이 다르다 — 트리는 `<rootId>/<상대경로>`, 위키 manifest 는 `source://<...>`
 * 이거나 폴더를 포함한 상대경로다. 그래서 **뒤에서부터 겹치는지**로 맞추고, 그래도 못 찾으면
 * 파일 이름으로 한 번 더 본다.
 *
 * **후보가 여럿이면 찍지 않는다.** 엉뚱한 문서를 짚어 놓고 맞다고 하는 것보다, 못 찾았다고
 * 말하는 편이 낫다. 그래프에서 다른 문서를 켜는 것도, 트리에서 다른 색 점을 다는 것도
 * 사용자에게는 똑같이 거짓말이다.
 */

export interface DocMatch {
  docId?: string;
  reason?: 'missing' | 'ambiguous';
}

/** 경로 하나를 문서로 옮기는 함수. 문서 목록이 바뀔 때만 다시 만든다. */
export type DocIndex = (path: string) => DocMatch;

export function buildDocIndex(
  nodes: { docId: string; sourceUri?: string; sourceFilename?: string }[],
): DocIndex {
  const entries = nodes.map((node) => {
    const path = normalize(node.sourceFilename || node.sourceUri || '');
    return { docId: node.docId, path, name: basename(path) };
  });

  return (rawPath: string): DocMatch => {
    const target = normalize(rawPath);
    if (!target) return { reason: 'missing' };

    const overlapping = entries.filter(
      (entry) =>
        entry.path &&
        (entry.path === target ||
          entry.path.endsWith(`/${target}`) ||
          target.endsWith(`/${entry.path}`)),
    );
    if (overlapping.length === 1) return { docId: overlapping[0]!.docId };
    if (overlapping.length > 1) return { reason: 'ambiguous' };

    const name = basename(target);
    const sameName = entries.filter((entry) => entry.name && entry.name === name);
    if (sameName.length === 1) return { docId: sameName[0]!.docId };
    return { reason: sameName.length > 1 ? 'ambiguous' : 'missing' };
  };
}

/** `source://` 를 떼고 퍼센트 인코딩을 풀어 비교 가능한 경로로 만든다. */
export function normalize(pathLike: string): string {
  const withoutScheme = pathLike.replace(/^source:\/\//, '');
  let decoded = withoutScheme;
  try {
    decoded = decodeURIComponent(withoutScheme);
  } catch {
    // 못 풀면 원문 그대로 비교한다 — 그래도 맞는 경우가 있다.
  }
  return decoded.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

export function basename(path: string): string {
  return path.split('/').pop() || path;
}
