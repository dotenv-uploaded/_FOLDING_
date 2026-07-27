import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FORCES,
  SLEEP_ENERGY,
  buildLinks,
  degreeMap,
  fitTransform,
  graphBounds,
  hitTest,
  nodeRadius,
  seedBodies,
  stepGraph,
  toWorld,
} from '@renderer/lib/graph-sim';

/**
 * 그래프 배치 — 화면에 보이는 결과를 여기서 못 박는다.
 *
 * 특히 두 가지가 회귀하기 쉬웠다.
 *   1. **가두지 않는다.** 예전 구현은 노드를 화면 크기 사각형에 밀어 넣어, 축소하면
 *      그래프가 네모난 덩어리로 보였다. 배치는 무한 평면에서 이뤄져야 한다.
 *   2. **멈춘다.** 잠들지 않으면 가만히 있는 화면이 계속 CPU 를 먹는다.
 */
describe('graph-sim', () => {
  const nodes = Array.from({ length: 24 }, (_, i) => ({ docId: `doc-${i}` }));
  const edges = [
    { from: 'doc-0', to: 'doc-1' },
    { from: 'doc-1', to: 'doc-2' },
    { from: 'doc-2', to: 'doc-0' },
    { from: 'doc-3', to: 'doc-0' },
  ];
  const indexOf = new Map(nodes.map((n, i) => [n.docId, i]));

  it('초기 배치는 같은 문서에 대해 항상 같다', () => {
    // 열 때마다 그림이 바뀌면 "아까 그 문서"를 다시 못 찾는다.
    const a = seedBodies(nodes, degreeMap(edges));
    const b = seedBodies(nodes, degreeMap(edges));
    expect(a.map((body) => [body.x, body.y])).toEqual(b.map((body) => [body.x, body.y]));
  });

  it('링크 수를 세어 점 크기에 반영한다', () => {
    const degrees = degreeMap(edges);
    expect(degrees.get('doc-0')).toBe(3); // 1·2·3 과 이어져 있다
    expect(degrees.get('doc-3')).toBe(1);
    expect(nodeRadius(3)).toBeGreaterThan(nodeRadius(0));
  });

  it('모르는 문서를 가리키는 엣지는 버린다', () => {
    const links = buildLinks(
      [...edges, { from: 'doc-0', to: '없는문서' }, { from: 'doc-0', to: 'doc-0' }],
      indexOf,
    );
    expect(links).toHaveLength(edges.length); // 유령 노드도, 자기 자신 링크도 만들지 않는다
  });

  it('가만히 두면 잠든다', () => {
    const bodies = seedBodies(nodes, degreeMap(edges));
    const links = buildLinks(edges, indexOf);
    let energy = Infinity;
    for (let i = 0; i < 4000 && energy >= SLEEP_ENERGY; i += 1) {
      energy = stepGraph(bodies, links, DEFAULT_FORCES);
    }
    expect(energy).toBeLessThan(SLEEP_ENERGY);
    expect(bodies.every((body) => Number.isFinite(body.x) && Number.isFinite(body.y))).toBe(true);
  });

  it('배치를 화면 상자에 가두지 않는다', () => {
    // 벽이 있으면 축소했을 때 그래프의 윤곽이 네모가 된다 — 그게 예전의 그 증상이었다.
    const many = Array.from({ length: 60 }, (_, i) => ({ docId: `n-${i}` }));
    const bodies = seedBodies(many, new Map());
    for (let i = 0; i < 300; i += 1) stepGraph(bodies, [], DEFAULT_FORCES);

    const bounds = graphBounds(bodies);
    const width = bounds.maxX - bounds.minX;
    // 링크 없이 밀어내기만 받으면 서로 멀어진다. 어떤 고정된 상자에도 갇히지 않는다.
    expect(width).toBeGreaterThan(400);
    // 그리고 원점을 중심으로 퍼진다 — 중심 인력이 흩어짐을 막는 유일한 장치다.
    expect(Math.abs(bounds.minX + bounds.maxX) / width).toBeLessThan(0.2);
  });

  it('맞춤은 그래프 전체를 화면 안에 넣고 가운데에 둔다', () => {
    const bounds = { minX: -200, minY: -100, maxX: 200, maxY: 100 };
    const size = { w: 800, h: 600 };
    const view = fitTransform(bounds, size, 40);

    const corners = [
      { x: bounds.minX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.maxY },
    ].map((point) => ({
      x: point.x * view.scale + view.tx,
      y: point.y * view.scale + view.ty,
    }));

    for (const corner of corners) {
      expect(corner.x).toBeGreaterThanOrEqual(0);
      expect(corner.x).toBeLessThanOrEqual(size.w);
      expect(corner.y).toBeGreaterThanOrEqual(0);
      expect(corner.y).toBeLessThanOrEqual(size.h);
    }
    // 가운데 정렬 — 중심이 화면 중심으로 온다.
    expect((bounds.minX + bounds.maxX) / 2 + view.tx).toBeCloseTo(size.w / 2);
  });

  it('화면 좌표를 그래프 좌표로 되돌린다', () => {
    // 이 역변환이 틀리면 확대한 뒤 끌 때 커서와 점이 어긋난다.
    const view = { scale: 2, tx: 100, ty: -30 };
    expect(toWorld({ x: 300, y: 70 }, view)).toEqual({ x: 100, y: 50 });
  });

  it('커서 아래 점을 고르고, 겹치면 더 가까운 쪽을 고른다', () => {
    const bodies = [
      { docId: 'a', x: 0, y: 0, vx: 0, vy: 0, degree: 0 },
      { docId: 'b', x: 6, y: 0, vx: 0, vy: 0, degree: 8 },
    ];
    expect(hitTest(bodies, { x: 6, y: 0 })).toBe(1);
    expect(hitTest(bodies, { x: -2, y: 0 })).toBe(0);
    expect(hitTest(bodies, { x: 400, y: 400 })).toBe(-1);
  });
});
