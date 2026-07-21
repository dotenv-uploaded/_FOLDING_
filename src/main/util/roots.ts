import path from 'node:path';
import { isInside } from './vpath';

/**
 * 등록 폴더 목록을 **최상위만 남기도록** 정규화한다.
 *
 * 사용자가 폴더를 여러 개 고를 때 흔한 두 가지를 처리한다:
 *   - 이미 등록된 폴더의 **하위**를 고름 → 새로 넣지 않는다 (이미 포함돼 있다)
 *   - 이미 등록된 폴더의 **상위**를 고름 → 하위들을 걷어내고 상위 하나만 남긴다
 *
 * 겹치는 폴더를 그대로 두면 같은 파일이 두 번 인덱싱되어 위키에 중복 문서가 생기고,
 * 인용이 어느 쪽을 가리키는지 알 수 없게 된다. 그래서 **표현이 아니라 저장 단계에서** 정리한다.
 */
export interface RootSelection {
  /** 정규화된 최종 목록 (겹침 없음, 입력 순서 유지) */
  roots: string[];
  /** 상위 폴더에 흡수되어 사라진 폴더들 */
  replaced: string[];
  /** 이미 포함돼 있어 추가하지 않은 폴더들 */
  alreadyCovered: string[];
}

export function resolveRootSelection(existing: string[], incoming: string[]): RootSelection {
  const roots = existing.map(normalize);
  const replaced: string[] = [];
  const alreadyCovered: string[] = [];

  for (const raw of incoming) {
    const candidate = normalize(raw);

    // 같은 폴더를 다시 고른 것은 조용히 무시한다 (오류가 아니다).
    if (roots.some((root) => root === candidate)) {
      alreadyCovered.push(candidate);
      continue;
    }
    // 이미 등록된 어느 폴더 안에 들어 있으면 추가하지 않는다.
    if (roots.some((root) => isInside(root, candidate))) {
      alreadyCovered.push(candidate);
      continue;
    }
    // 반대로 등록된 폴더들의 상위라면 그것들을 흡수한다.
    for (let i = roots.length - 1; i >= 0; i -= 1) {
      if (isInside(candidate, roots[i]!)) {
        replaced.push(roots[i]!);
        roots.splice(i, 1);
      }
    }
    roots.push(candidate);
  }

  return { roots, replaced: replaced.reverse(), alreadyCovered };
}

/**
 * 끝의 구분자와 `.`·`..` 를 정리한다.
 * `/a/b/` 와 `/a/b` 가 다른 폴더로 등록되면 같은 파일을 두 번 읽는다.
 */
function normalize(value: string): string {
  return path.resolve(value);
}
