/**
 * 문서 네트워크 — 서로 링크로 이어진 덩어리를 찾아 이름과 색을 준다.
 *
 * 그래프에서 눈에 먼저 들어오는 것은 "이 뭉치가 무엇인가"다. 점이 전부 같은 색이면 뭉치를
 * 세는 것조차 눈으로 해야 한다. 그래서 **서로 이어진 덩어리(연결 요소)** 를 하나의 네트워크로
 * 보고 색을 준다.
 *
 * 이름은 사람이 붙이지 않는다 — 구성원들이 실제로 들어 있는 **폴더 이름**에서 뽑는다.
 * 사람이 폴더를 나눈 기준이 곧 그 뭉치의 정체이기 때문이다.
 *
 * 혼자인 문서는 네트워크가 아니다. 이어진 데가 없는 문서까지 색을 주면 색이 수십 개가 되어
 * 색으로 구분한다는 의미가 사라진다. 그런 문서는 회색으로 남긴다.
 */

/** 네트워크 색 — 흰 바탕에서 서로 구분되는 것들로 고른 categorical 팔레트. */
export const NETWORK_PALETTE = [
  '#2B5DFD', // 파랑
  '#E8594A', // 빨강
  '#17A673', // 초록
  '#B45BF0', // 보라
  '#F0932B', // 주황
  '#0FA3B1', // 청록
  '#E0409A', // 분홍
  '#8A6D3B', // 갈색
  '#6C7BFF', // 연보라
  '#3FA845', // 연두
  '#C2447A', // 자주
  '#D4A017', // 황금
] as const;

/** 어디에도 이어지지 않은 문서의 색 (ink-300). */
export const UNLINKED_COLOR = '#B4BACB';

export interface DocNetwork {
  id: string;
  label: string;
  color: string;
  docIds: string[];
}

export interface NetworkIndex {
  /** 큰 덩어리부터. */
  networks: DocNetwork[];
  byDoc: Map<string, DocNetwork>;
}

export interface NetworkNode {
  docId: string;
  sourceFilename?: string;
  sourceUri?: string;
  title?: string;
}

/**
 * 링크로 이어진 덩어리를 찾아 네트워크로 만든다.
 *
 * 큰 덩어리부터 색을 준다 — 화면에서 가장 많이 보이는 뭉치가 가장 또렷한 색을 갖도록.
 * 팔레트를 다 쓰면 앞에서부터 다시 쓴다. 색이 겹치는 것은 이름표로 구분된다.
 */
export function buildNetworks(nodes: NetworkNode[], edges: { from: string; to: string }[]): NetworkIndex {
  const indexOf = new Map<string, number>();
  nodes.forEach((node, i) => indexOf.set(node.docId, i));

  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    // 경로 압축 — 큰 그래프에서 같은 문서를 몇 번이고 되짚지 않게.
    let cursor = i;
    while (parent[cursor] !== root) {
      const next = parent[cursor]!;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };

  for (const edge of edges) {
    const a = indexOf.get(edge.from);
    const b = indexOf.get(edge.to);
    if (a === undefined || b === undefined) continue; // 모르는 문서를 가리키는 링크는 버린다
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  }

  const groups = new Map<number, string[]>();
  nodes.forEach((node, i) => {
    const root = find(i);
    const members = groups.get(root);
    if (members) members.push(node.docId);
    else groups.set(root, [node.docId]);
  });

  const named = new Map(nodes.map((node) => [node.docId, node]));
  const networks: DocNetwork[] = [...groups.values()]
    // 혼자인 문서는 네트워크로 치지 않는다.
    .filter((members) => members.length > 1)
    // 큰 덩어리 먼저. 크기가 같으면 문서 식별자로 갈라 **열 때마다 같은 색**이 되게 한다.
    .sort((a, b) => b.length - a.length || (a[0]! < b[0]! ? -1 : 1))
    .map((members, rank) => ({
      id: `network-${rank + 1}`,
      label: networkLabel(members.map((docId) => named.get(docId)!)),
      color: NETWORK_PALETTE[rank % NETWORK_PALETTE.length]!,
      docIds: members,
    }));

  // 같은 폴더가 서로 이어지지 않은 덩어리 여럿으로 갈릴 수 있다(실제 빌드에서 한 폴더가
  // 5개로 갈렸다). 이름이 같으면 어느 뭉치를 말하는지 알 수 없으므로 번호를 붙여 갈라 준다.
  const labelCounts = new Map<string, number>();
  for (const network of networks) {
    labelCounts.set(network.label, (labelCounts.get(network.label) ?? 0) + 1);
  }
  const numbered = new Map<string, number>();
  for (const network of networks) {
    if ((labelCounts.get(network.label) ?? 0) < 2) continue;
    const seq = (numbered.get(network.label) ?? 0) + 1;
    numbered.set(network.label, seq);
    network.label = `${network.label} (${seq})`;
  }

  const byDoc = new Map<string, DocNetwork>();
  for (const network of networks) {
    for (const docId of network.docIds) byDoc.set(docId, network);
  }
  return { networks, byDoc };
}

/**
 * 덩어리의 이름 — 구성원이 가장 많이 들어 있는 **최상위 폴더**.
 *
 * 한 폴더가 과반이 안 되면 "외 N개" 를 붙인다. 폴더 하나로 뭉뚱그리면 나머지 문서를 못
 * 찾은 것처럼 보이기 때문이다 — 이름이 덩어리 전체를 대표하지 못한다는 사실 자체를 보여준다.
 */
function networkLabel(members: NetworkNode[]): string {
  const counts = new Map<string, number>();
  for (const member of members) {
    const folder = topFolder(member);
    if (folder) counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  if (counts.size === 0) return `문서 ${members.length}개`;

  const [best, count] = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
  if (counts.size === 1) return best;
  // 절반으로는 대표라고 할 수 없다 — **넘어야** 그 폴더 이름으로 뭉치를 부를 수 있다.
  return count * 2 > members.length ? best : `${best} 외 ${counts.size - 1}개`;
}

/** 문서가 들어 있는 최상위 폴더. 폴더 없이 바로 놓인 파일이면 빈 문자열. */
function topFolder(node: NetworkNode): string {
  const path = node.sourceFilename || decodeUri(node.sourceUri);
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments.length > 1 ? segments[0]! : '';
}

function decodeUri(uri: string | undefined): string {
  if (!uri) return '';
  const withoutScheme = uri.replace(/^source:\/\//, '');
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme;
  }
}
