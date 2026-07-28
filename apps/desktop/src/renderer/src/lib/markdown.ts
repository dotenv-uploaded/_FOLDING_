/**
 * 물결표(`~`)를 취소선으로 오해하지 않게 하는 보정.
 *
 * 왜 필요한가
 * ----------
 * 한국어 문서에서 `~` 는 **범위 표시**다 — "5~8주", "9~10주차". 그런데 GFM 취소선은
 * 기본값에서 물결표 하나짜리(`~지운글~`)도 취소선으로 본다. 그래서 한 문단에 범위가
 * 둘 이상 나오면 앞 범위의 `~` 가 열고 뒤 범위의 `~` 가 닫아서, **그 사이 문장 전체가
 * 통째로 삭선 처리**됐다. "5~8주: 준비. 9~10주차: 마무리" 가 "8주: 준비. 9" 만 그어진
 * 채로 보이는 식이다. 문서 내용은 멀쩡한데 화면만 틀린, 가장 나쁜 종류의 오류다.
 *
 * 두 겹으로 막는다
 * ----------------
 * 1. `singleTilde: false` (Markdown.tsx) — 물결표 하나는 취소선으로 보지 않는다. 위의
 *    실제 사례가 여기서 없어진다.
 * 2. 이 모듈 — 그래도 `5~~8주 … 9~~10주차` 처럼 **두 겹**으로 적힌 범위는 남는다.
 *    양쪽이 숫자로 둘러싸인 취소선은 사람이 그은 선이 아니라 범위 표시로 보고 되돌린다.
 *
 * `~~진짜 취소선~~` 은 그대로 둔다 — 문서가 실제로 그은 선까지 지우면 그건 또 다른
 * 왜곡이다. 되돌리는 건 **숫자에 끼인 경우로만** 한정한다.
 */

/** mdast 의 최소 형태. `unified` 는 직접 의존이 아니라 여기서 필요한 만큼만 적는다. */
export type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

/** react-markdown 의 `remarkPlugins` 에 그대로 넣는다. */
export function remarkNumericRanges() {
  return (tree: MarkdownNode): void => {
    restoreNumericRanges(tree);
  };
}

/**
 * 숫자 사이에 끼인 취소선을 원래 글자(`~~…~~`)로 되돌린다. 트리를 제자리에서 고친다.
 *
 * 판단 기준은 셋 다 만족할 때뿐이다 — 앞 글자가 숫자, 뒤 글자가 숫자, 안쪽이 숫자로 시작.
 * 셋 다여야 "5~~8주 … 9~~10주차" 같은 범위이고, 하나라도 어긋나면 사람이 그은 선일 수
 * 있으므로 건드리지 않는다(애매하면 원문 보존 쪽).
 */
export function restoreNumericRanges(node: MarkdownNode): void {
  const children = node.children;
  if (!children) return;

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    restoreNumericRanges(child);
    if (child.type !== 'delete') continue;

    const inner = plainText(child);
    // 안에 굵게·링크가 섞여 있으면 글자로 되돌릴 수 없다 — 손대지 않는다.
    if (inner === null || !/^\d/.test(inner)) continue;
    if (!endsWithDigit(children[index - 1]) || !startsWithDigit(children[index + 1])) continue;

    children[index] = { type: 'text', value: `~~${inner}~~` };
  }
}

/** 자식이 모두 글자 노드일 때만 이어 붙인 문자열을 준다. 아니면 `null`. */
function plainText(node: MarkdownNode): string | null {
  const children = node.children ?? [];
  let text = '';
  for (const child of children) {
    if (child.type !== 'text' || typeof child.value !== 'string') return null;
    text += child.value;
  }
  return text;
}

function endsWithDigit(node: MarkdownNode | undefined): boolean {
  return node?.type === 'text' && /\d$/.test(node.value ?? '');
}

function startsWithDigit(node: MarkdownNode | undefined): boolean {
  return node?.type === 'text' && /^\d/.test(node.value ?? '');
}
