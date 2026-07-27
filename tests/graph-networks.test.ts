import { describe, expect, it } from 'vitest';
import { NETWORK_PALETTE, buildNetworks } from '@renderer/lib/graph-networks';
import { buildDocIndex } from '@renderer/lib/doc-index';

/**
 * 문서 네트워크 — 서로 이어진 덩어리에 이름과 색을 준다.
 *
 * 색이 뜻을 가지려면 두 가지가 지켜져야 한다.
 *   1. **같은 빌드는 언제 열어도 같은 색.** 열 때마다 색이 바뀌면 "저 파란 뭉치"라는 말이
 *      성립하지 않는다.
 *   2. **그래프와 트리가 같은 색.** 두 화면이 따로 계산하면 같은 문서가 다른 색이 된다.
 *      그래서 계산은 이 순수 함수 하나뿐이어야 한다.
 */
describe('buildNetworks', () => {
  const node = (docId: string, sourceFilename: string) => ({ docId, sourceFilename });

  it('링크로 이어진 덩어리를 하나의 네트워크로 묶는다', () => {
    const nodes = [
      node('a', '스터디/1주차.docx'),
      node('b', '스터디/2주차.docx'),
      node('c', '스터디/3주차.docx'),
      node('d', '계약/공사계약서.hwp'),
      node('e', '계약/부속합의서.hwp'),
    ];
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'd', to: 'e' },
    ];

    const { networks, byDoc } = buildNetworks(nodes, edges);

    expect(networks).toHaveLength(2);
    expect(networks[0]!.docIds.sort()).toEqual(['a', 'b', 'c']);
    expect(byDoc.get('a')).toBe(byDoc.get('c')); // 같은 덩어리 = 같은 네트워크 객체
    expect(byDoc.get('a')).not.toBe(byDoc.get('d'));
  });

  it('이름은 구성원이 가장 많이 들어 있는 폴더에서 뽑는다', () => {
    const nodes = [node('a', '스터디 보고서/1주차.docx'), node('b', '스터디 보고서/2주차.docx')];
    const { networks } = buildNetworks(nodes, [{ from: 'a', to: 'b' }]);
    expect(networks[0]!.label).toBe('스터디 보고서');
  });

  it('한 폴더가 과반이 아니면 "외 N개" 를 붙여 대표하지 못한다는 사실을 남긴다', () => {
    // 실제 빌드에 있던 덩어리다 — Flutter 9 · Spring 5 · WebScraping 4 가 한 덩어리였다.
    const nodes = [
      node('a', 'FLAG Flutter 스터디 보고서/1.docx'),
      node('b', 'FLAG Spring 스터디 보고서/2.docx'),
      node('c', 'FLAG WebScraping 스터디 보고서/3.docx'),
      node('d', 'FLAG WebScraping 스터디 보고서/4.docx'),
    ];
    const { networks } = buildNetworks(nodes, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
    ]);
    expect(networks[0]!.label).toBe('FLAG WebScraping 스터디 보고서 외 2개');
  });

  it('혼자인 문서는 네트워크가 아니다', () => {
    // 이어진 데 없는 문서까지 색을 주면 색이 수십 개가 되어 색으로 구분하는 의미가 사라진다.
    const nodes = [node('a', 'x/1.hwp'), node('b', 'x/2.hwp'), node('lonely', 'y/3.hwp')];
    const { networks, byDoc } = buildNetworks(nodes, [{ from: 'a', to: 'b' }]);

    expect(networks).toHaveLength(1);
    expect(byDoc.has('lonely')).toBe(false);
  });

  it('큰 덩어리가 먼저 오고, 같은 빌드는 언제나 같은 색이다', () => {
    const nodes = [
      node('a', 'p/1'),
      node('b', 'p/2'),
      node('c', 'q/1'),
      node('d', 'q/2'),
      node('e', 'q/3'),
    ];
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'c', to: 'd' },
      { from: 'd', to: 'e' },
    ];

    const first = buildNetworks(nodes, edges);
    // 문서 순서가 뒤바뀌어도 같은 덩어리는 같은 색이어야 한다.
    const shuffled = buildNetworks([...nodes].reverse(), [...edges].reverse());

    expect(first.networks[0]!.docIds).toHaveLength(3);
    expect(first.networks[0]!.color).toBe(NETWORK_PALETTE[0]);
    expect(shuffled.byDoc.get('c')!.color).toBe(first.byDoc.get('c')!.color);
    expect(shuffled.byDoc.get('a')!.color).toBe(first.byDoc.get('a')!.color);
  });

  it('모르는 문서를 가리키는 링크는 덩어리를 만들지 않는다', () => {
    const { networks } = buildNetworks([node('a', 'p/1')], [{ from: 'a', to: '없는문서' }]);
    expect(networks).toHaveLength(0);
  });
});

/**
 * 트리의 파일 경로 → 위키 문서. 이게 틀리면 트리에 **엉뚱한 색 점**이 붙는다.
 */
describe('buildDocIndex', () => {
  const find = buildDocIndex([
    { docId: 'a', sourceFilename: 'FLAG Flutter 스터디 보고서/Flutter 스터디 5주차.docx' },
    { docId: 'b', sourceUri: 'source://%EA%B3%84%EC%95%BD/%EA%B3%84%EC%95%BD%EC%84%9C.hwp' },
    { docId: 'c', sourceFilename: '보관/계약서.hwp' },
  ]);

  it('앞에 등록 폴더가 붙어 있어도 뒤에서부터 맞춘다', () => {
    expect(find('root-1/FLAG Flutter 스터디 보고서/Flutter 스터디 5주차.docx').docId).toBe('a');
  });

  it('퍼센트 인코딩된 URI 도 같은 경로로 본다', () => {
    expect(find('root-1/계약/계약서.hwp').docId).toBe('b');
  });

  it('이름이 같은 문서가 여럿이면 찍지 않는다', () => {
    // 폴더가 다른 동명 파일 — 여기서 하나를 찍으면 트리와 그래프가 서로 다른 문서를 가리킨다.
    expect(find('어딘가/계약서.hwp')).toEqual({ reason: 'ambiguous' });
  });

  it('빌드에 없는 파일은 없다고 말한다', () => {
    expect(find('root-1/아직 안 넣은 문서.hwp')).toEqual({ reason: 'missing' });
  });
});
