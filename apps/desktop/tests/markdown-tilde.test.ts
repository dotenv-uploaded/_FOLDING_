import { describe, expect, it } from 'vitest';
import { restoreNumericRanges, type MarkdownNode } from '@renderer/lib/markdown';

/**
 * "5~8주", "9~10주차" 처럼 물결표로 범위를 적은 문장이 통째로 삭선 처리되던 문제.
 *
 * 파서 단계(`singleTilde: false`)에서 물결표 하나짜리는 이미 막았다. 여기서 지키는 건
 * 그 다음 단계 — **두 겹으로 적힌 범위**(`5~~8주 … 9~~10주차`)를 글자로 되돌리는 것.
 * 되돌리는 조건을 좁게 두는 게 핵심이라, 사람이 실제로 그은 선은 남는지도 함께 못 박는다.
 */
describe('restoreNumericRanges', () => {
  /** `5~~8주 그리고 9~~10주차` 를 파싱하면 나오는 모양. */
  const numericRange = (): MarkdownNode => ({
    type: 'paragraph',
    children: [
      { type: 'text', value: '5' },
      { type: 'delete', children: [{ type: 'text', value: '8주 그리고 9' }] },
      { type: 'text', value: '10주차' },
    ],
  });

  it('숫자에 끼인 취소선은 범위 표시로 보고 글자로 되돌린다', () => {
    const tree = numericRange();
    restoreNumericRanges(tree);

    expect(tree.children).toEqual([
      { type: 'text', value: '5' },
      { type: 'text', value: '~~8주 그리고 9~~' },
      { type: 'text', value: '10주차' },
    ]);
  });

  it('사람이 그은 취소선은 그대로 둔다', () => {
    // 앞뒤가 숫자가 아니면 범위로 볼 근거가 없다 — 문서가 그은 선을 지우면 그것도 왜곡이다.
    const tree: MarkdownNode = {
      type: 'paragraph',
      children: [
        { type: 'text', value: '이건 ' },
        { type: 'delete', children: [{ type: 'text', value: '취소된 문장' }] },
        { type: 'text', value: ' 입니다' },
      ],
    };
    const before = structuredClone(tree);

    restoreNumericRanges(tree);

    expect(tree).toEqual(before);
  });

  it('한쪽만 숫자면 손대지 않는다', () => {
    for (const [previous, next] of [
      ['5', '주차'],
      ['앞 ', '10주차'],
    ]) {
      const tree: MarkdownNode = {
        type: 'paragraph',
        children: [
          { type: 'text', value: previous },
          { type: 'delete', children: [{ type: 'text', value: '8주 그리고 9' }] },
          { type: 'text', value: next },
        ],
      };
      const before = structuredClone(tree);

      restoreNumericRanges(tree);

      expect(tree).toEqual(before);
    }
  });

  it('안에 서식이 섞여 있으면 글자로 되돌리지 않는다', () => {
    // 되돌리려면 원문을 그대로 복원할 수 있어야 한다. 굵게·링크가 섞이면 복원이 불가능하다.
    const tree: MarkdownNode = {
      type: 'paragraph',
      children: [
        { type: 'text', value: '5' },
        {
          type: 'delete',
          children: [
            { type: 'text', value: '8주 ' },
            { type: 'strong', children: [{ type: 'text', value: '중요' }] },
            { type: 'text', value: ' 9' },
          ],
        },
        { type: 'text', value: '10주차' },
      ],
    };
    const before = structuredClone(tree);

    restoreNumericRanges(tree);

    expect(tree).toEqual(before);
  });

  it('표 셀·목록처럼 깊이 들어간 곳도 고친다', () => {
    const tree: MarkdownNode = {
      type: 'root',
      children: [{ type: 'tableCell', children: numericRange().children }],
    };

    restoreNumericRanges(tree);

    expect(tree.children?.[0].children?.[1]).toEqual({ type: 'text', value: '~~8주 그리고 9~~' });
  });
});
