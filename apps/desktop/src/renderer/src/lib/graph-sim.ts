/**
 * 지식 그래프의 힘-기반 배치 — 그리기와 분리한 순수 계산.
 *
 * 왜 분리했나
 * ----------
 * 배치가 틀리면 화면이 이상해지는데, 캔버스 안에서는 그걸 눈으로만 확인할 수 있다.
 * 좌표 계산을 여기로 빼 두면 "잠들긴 하는가", "화면에 꽉 차게 맞춰지는가" 를 테스트로
 * 못 박을 수 있다.
 *
 * **가두지 않는다.** 예전 구현은 노드를 화면 크기의 사각형 안에 강제로 밀어 넣었다.
 * 그래서 축소하면 그래프가 딱 네모난 덩어리로 보였다 — 벽이 그림의 윤곽이 돼 버린 것이다.
 * 여기서는 벽 없이 중심 인력만으로 모으고, **화면에 맞추는 일은 보기(view) 변환이 한다.**
 * 배치는 무한한 평면 위에서 자유롭게 이뤄지고, 화면은 그 결과를 담을 뿐이다.
 */

export interface GraphBody {
  docId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 이 노드에 붙은 링크 수 — 점 크기를 정한다(옵시디언과 같은 규칙). */
  degree: number;
}

/** 링크는 인덱스 쌍으로 둔다 — 프레임마다 맵을 뒤지지 않기 위해서다. */
export interface GraphLink {
  a: number;
  b: number;
}

export interface SimForces {
  /** 노드끼리 밀어내는 세기 (0~1). */
  repel: number;
  /** 링크가 당기는 세기 (0~1). */
  linkForce: number;
  /** 링크의 자연 길이(px). */
  linkDistance: number;
  /** 그래프를 원점으로 모으는 힘 (0~1). */
  center: number;
}

export const DEFAULT_FORCES: SimForces = {
  repel: 0.5,
  linkForce: 0.45,
  linkDistance: 110,
  center: 0.35,
};

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

const DAMPING = 0.84; // 속도 감쇠 — 없으면 영원히 진동한다
const MAX_SPEED = 30; // 한 프레임 최대 이동
export const SLEEP_ENERGY = 0.015; // 이보다 조용해지면 멈춘다
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;

/** 링크 수로 점 반지름을 정한다. 많이 이어진 문서가 눈에 먼저 들어와야 한다. */
export function nodeRadius(degree: number, nodeScale = 1): number {
  return nodeScale * (3 + Math.sqrt(degree) * 1.8);
}

/** 각 문서에 붙은 링크 수. 방향은 따지지 않는다 — 굵기가 아니라 존재감의 문제다. */
export function degreeMap(edges: { from: string; to: string }[]): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const edge of edges) {
    degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
  }
  return degrees;
}

/**
 * 초기 배치 — 원점을 둘러싼 원 위에 **결정적으로** 흩뿌린다.
 *
 * `Math.random()` 을 쓰면 열 때마다 다른 그림이 나와 "아까 그 문서"를 다시 못 찾는다.
 * 같은 빌드는 언제 열어도 같은 모양이어야 한다.
 */
export function seedBodies(
  nodes: { docId: string }[],
  degrees: Map<string, number>,
  radius = 320,
): GraphBody[] {
  return nodes.map((node, i) => {
    const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2 + ((hash(node.docId) % 100) / 100) * 0.6;
    const r = radius * (0.5 + ((hash(`${node.docId}#r`) % 100) / 100) * 0.5);
    return {
      docId: node.docId,
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
      vx: 0,
      vy: 0,
      degree: degrees.get(node.docId) ?? 0,
    };
  });
}

/** 엣지를 인덱스 쌍으로 바꾼다. **모르는 문서를 가리키는 엣지는 버린다** — 지어내지 않는다. */
export function buildLinks(
  edges: { from: string; to: string }[],
  indexOf: Map<string, number>,
): GraphLink[] {
  const links: GraphLink[] = [];
  for (const edge of edges) {
    const a = indexOf.get(edge.from);
    const b = indexOf.get(edge.to);
    if (a === undefined || b === undefined || a === b) continue;
    links.push({ a, b });
  }
  return links;
}

/**
 * 한 프레임. 되돌려주는 값은 평균 운동에너지 — 호출자가 이걸 보고 잠재울지 정한다.
 *
 * 끌고 있는 노드는 **힘을 받지 않고 커서에 붙는다.** 그래야 손이 이끄는 대로 움직이고
 * 이웃들이 스프링을 통해 뒤따라온다.
 */
export function stepGraph(
  bodies: GraphBody[],
  links: GraphLink[],
  forces: SimForces,
  pinned?: { index: number; x: number; y: number } | null,
): number {
  const repulsion = 600 + forces.repel * 18_000;
  const springK = forces.linkForce * 0.08;
  const centerPull = forces.center * 0.02;

  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const a = bodies[i]!;
      const b = bodies[j]!;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        // 완전히 겹치면 밀어낼 방향이 없다 — 인덱스로 정해진 방향을 준다(무작위 금지).
        dx = (i % 7) - 3 || 1;
        dy = (j % 5) - 2 || 1;
        d2 = dx * dx + dy * dy;
      }
      const d = Math.sqrt(d2);
      const f = repulsion / d2;
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }
  }

  for (const link of links) {
    const a = bodies[link.a]!;
    const b = bodies[link.b]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const f = (d - forces.linkDistance) * springK;
    a.vx += (dx / d) * f;
    a.vy += (dy / d) * f;
    b.vx -= (dx / d) * f;
    b.vy -= (dy / d) * f;
  }

  // 원점으로 모으는 힘. 벽 대신 이것만으로 그래프가 흩어지지 않게 잡는다.
  for (const body of bodies) {
    body.vx -= body.x * centerPull;
    body.vy -= body.y * centerPull;
  }

  let energy = 0;
  for (let i = 0; i < bodies.length; i += 1) {
    const body = bodies[i]!;
    if (pinned && pinned.index === i) {
      // 끌리는 노드는 커서가 위치를 정한다. 속도를 0 으로 둬야 놓았을 때 튀지 않는다.
      body.x = pinned.x;
      body.y = pinned.y;
      body.vx = 0;
      body.vy = 0;
      continue;
    }
    body.vx = clamp(body.vx * DAMPING, MAX_SPEED);
    body.vy = clamp(body.vy * DAMPING, MAX_SPEED);
    body.x += body.vx;
    body.y += body.vy;
    energy += body.vx * body.vx + body.vy * body.vy;
  }
  return energy / Math.max(bodies.length, 1);
}

/** 점과 이름표까지 포함한 그래프 전체의 경계. 비어 있으면 원점 주변의 작은 상자. */
export function graphBounds(bodies: GraphBody[], nodeScale = 1): Bounds {
  if (bodies.length === 0) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const body of bodies) {
    const r = nodeRadius(body.degree, nodeScale);
    minX = Math.min(minX, body.x - r);
    minY = Math.min(minY, body.y - r);
    maxX = Math.max(maxX, body.x + r);
    maxY = Math.max(maxY, body.y + r);
  }
  return { minX, minY, maxX, maxY };
}

/** 그래프 전체가 화면에 담기는 보기 변환. 여백(padding)은 이름표가 잘리지 않게 둔다. */
export function fitTransform(
  bounds: Bounds,
  size: { w: number; h: number },
  padding = 48,
): ViewTransform {
  const width = Math.max(bounds.maxX - bounds.minX, 1);
  const height = Math.max(bounds.maxY - bounds.minY, 1);
  const usableW = Math.max(size.w - padding * 2, 1);
  const usableH = Math.max(size.h - padding * 2, 1);
  const scale = clampScale(Math.min(usableW / width, usableH / height));
  return {
    scale,
    tx: size.w / 2 - ((bounds.minX + bounds.maxX) / 2) * scale,
    ty: size.h / 2 - ((bounds.minY + bounds.maxY) / 2) * scale,
  };
}

/** 화면 좌표 → 그래프 좌표. */
export function toWorld(point: { x: number; y: number }, view: ViewTransform) {
  return { x: (point.x - view.tx) / view.scale, y: (point.y - view.ty) / view.scale };
}

/** 커서 아래의 노드. 겹쳐 있으면 **더 가까운 쪽**을 고른다. 없으면 -1. */
export function hitTest(
  bodies: GraphBody[],
  world: { x: number; y: number },
  nodeScale = 1,
  slack = 4,
): number {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < bodies.length; i += 1) {
    const body = bodies[i]!;
    const reach = nodeRadius(body.degree, nodeScale) + slack;
    const distance = Math.hypot(body.x - world.x, body.y - world.y);
    if (distance <= reach && distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

/** 확대 배율 한계 — 너무 줄이면 점이 사라지고, 너무 키우면 길을 잃는다. */
export function clampScale(value: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
}

function clamp(value: number, max: number): number {
  return Math.max(-max, Math.min(max, value));
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
