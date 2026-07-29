import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRootSelection } from '@main/util/roots';

const 사업 = path.resolve('사업');
const 개인 = path.resolve('개인');
const 보관 = path.resolve('보관');
const 계약 = path.join(사업, '계약');
const 제안 = path.join(사업, '제안');
const 사업2 = path.resolve('사업2');

/**
 * 폴더 등록 규칙 — **최상위만 남긴다.**
 *
 * 겹치는 폴더를 허용하면 같은 파일이 두 번 인덱싱되어 위키에 중복 문서가 생기고,
 * 인용이 어느 쪽을 가리키는지 알 수 없게 된다.
 */
describe('resolveRootSelection', () => {
  it('겹치지 않는 폴더는 그대로 쌓인다', () => {
    const result = resolveRootSelection([사업], [개인, 보관]);
    expect(result.roots).toEqual([사업, 개인, 보관]);
    expect(result.replaced).toEqual([]);
    expect(result.alreadyCovered).toEqual([]);
  });

  it('이미 등록된 폴더의 하위를 고르면 추가하지 않는다', () => {
    const result = resolveRootSelection([사업], [계약]);
    expect(result.roots).toEqual([사업]);
    expect(result.alreadyCovered).toEqual([계약]);
  });

  it('상위 폴더를 고르면 하위들을 흡수하고 최상위만 남는다', () => {
    const result = resolveRootSelection([계약, 제안, 개인], [사업]);
    expect(result.roots).toEqual([개인, 사업]);
    expect(result.replaced).toEqual([계약, 제안]);
  });

  it('같은 폴더를 다시 고르면 조용히 무시한다 — 오류가 아니다', () => {
    const result = resolveRootSelection([사업], [사업]);
    expect(result.roots).toEqual([사업]);
    expect(result.alreadyCovered).toEqual([사업]);
  });

  it('끝의 슬래시가 달라도 같은 폴더로 본다', () => {
    const result = resolveRootSelection([사업], [`${사업}${path.sep}`]);
    expect(result.roots).toEqual([사업]);
    expect(result.alreadyCovered).toHaveLength(1);
  });

  it('이름이 비슷할 뿐인 형제 폴더를 하위로 착각하지 않는다', () => {
    const result = resolveRootSelection([사업], [사업2]);
    expect(result.roots).toEqual([사업, 사업2]);
    expect(result.alreadyCovered).toEqual([]);
  });

  it('한 번에 여러 개를 골라도 서로 겹치면 최상위만 남는다', () => {
    const result = resolveRootSelection([], [계약, 사업, 제안]);
    expect(result.roots).toEqual([사업]);
    expect(result.replaced).toEqual([계약]);
    expect(result.alreadyCovered).toEqual([제안]);
  });

  it('상대 경로도 절대 경로로 정규화해 비교한다', () => {
    const result = resolveRootSelection([사업], [path.join(사업, '계약', '..', '제안')]);
    expect(result.roots).toEqual([사업]);
    expect(result.alreadyCovered).toEqual([제안]);
  });
});
