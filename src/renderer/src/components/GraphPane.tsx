import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SharedEntity, WikiGraph, WikiGraphNode } from '@contracts';
import { cn } from '@/lib/cn';
import type { DocIndex } from '@/lib/doc-index';
import { documentLabel } from '@/lib/format';
import { UNLINKED_COLOR, type DocNetwork, type NetworkIndex } from '@/lib/graph-networks';
import {
  DEFAULT_FORCES,
  SLEEP_ENERGY,
  buildLinks,
  clampScale,
  degreeMap,
  fitTransform,
  graphBounds,
  hitTest,
  nodeRadius,
  seedBodies,
  stepGraph,
  toWorld,
  type GraphBody,
  type SimForces,
  type ViewTransform,
} from '@/lib/graph-sim';

/**
 * 지식 그래프 — 활성 위키 빌드의 문서(노드)와 링크(엣지)를 그린다.
 *
 * 옵시디언 그래프 뷰의 **동작**을 그대로 따랐다: 가둠 없는 무한 평면, 링크 수에 비례하는
 * 점, 가리키면 그 문서와 이웃만 남고 나머지는 흐려지는 강조, 힘을 직접 조절하는 설정.
 * 다만 **색은 이 앱의 것**이다 — 옵시디언은 어둡지만 이 앱은 흰 바탕이고, 그래프만
 * 어두우면 탭을 옮길 때마다 눈이 다시 적응해야 한다.
 *
 * **외부 그래프 라이브러리를 쓰지 않는다.** 문서 수백 개 규모에서는 자체 시뮬레이션으로
 * 충분하고, 의존성 하나가 늘면 Electron 번들과 보안 검토가 함께 늘어난다.
 *
 * SVG 가 아니라 **캔버스**로 그린다. 노드마다 DOM 을 만들면 프레임마다 수백 개를 다시
 * 그려야 해서, 흐림·강조 같은 효과를 넣는 순간 화면이 끊긴다.
 *
 * 시뮬레이션은 **계속 돌지 않는다** — 조용해지면 멈추고, 드래그 같은 입력에만 깨어난다.
 * 가만히 있는 화면이 CPU 를 먹으면 노트북 배터리가 준다.
 */

/* ---- 색 ----
 *
 * 앱의 나머지가 흰 바탕이다. 그래프만 어두우면 탭을 옮길 때마다 눈이 다시 적응해야 한다.
 * 그래서 옵시디언의 **동작**은 그대로 가져오되 **색은 이 앱의 것**을 쓴다.
 * 값은 styles/tokens/colors.css 의 ink·blue 스케일과 같은 것이다.
 */
const BACKGROUND = '#FFFFFF';
const LINK_DIM = '#DDE1EA';
const LINK_LIT = '#2B5DFD'; // blue-500
const LABEL = '#5B6480'; // ink-500
const LABEL_DIM = '#B4BACB'; // ink-300

/**
 * 점 색은 그 문서가 속한 **네트워크**(서로 링크로 이어진 덩어리)의 색이다.
 *
 * 문서 종류로 나눠 봤을 때는 색이 화면 곳곳에 흩어져 아무것도 말해 주지 않았다. 네트워크로
 * 나누면 색이 곧 뭉치라서, 색이 모여 있는 것 자체가 정보가 된다. 어디에도 이어지지 않은
 * 문서는 회색으로 남는다 — 그것도 봐야 할 사실이다(연결이 없다는 뜻).
 */
const SELECTED_RING = '#0D1630'; // ink-950 — 색을 덮지 않고 테두리로만 고른 것을 표시한다

interface DisplayOptions {
  /** 점 크기 배율. */
  nodeScale: number;
  /** 링크 굵기(px). */
  linkThickness: number;
  /** 이 배율보다 작아지면 이름표가 사라진다. */
  textFade: number;
  /** 링크 방향 화살표. 옵시디언과 같이 기본은 꺼 둔다 — 대개 그림만 복잡해진다. */
  arrows: boolean;
}

/** 고른 문서에서 뻗어 나간 연결 하나와, 그것을 만든 근거. */
interface Connection {
  node: WikiGraphNode;
  sharedEntities?: SharedEntity[];
}

const DEFAULT_DISPLAY: DisplayOptions = {
  nodeScale: 1,
  linkThickness: 1,
  textFade: 0.4,
  arrows: false,
};

export interface GraphPaneProps {
  /**
   * 트리에서 더블클릭해 들어온 **파일 경로**. 트리는 doc_id 를 모르므로 경로로 받아
   * `docIndex` 로 문서를 찾는다.
   */
  focusPath: string | null;
  graph: WikiGraph | null;
  error: string | null;
  /** 문서 네트워크 — 트리와 **같은 것**을 쓴다. 같은 뭉치는 어디서나 같은 색이어야 한다. */
  networks: NetworkIndex;
  docIndex: DocIndex;
}

export function GraphPane({ focusPath, graph, error, networks, docIndex }: GraphPaneProps) {
  if (error) return <Centered tone="error">{error}</Centered>;
  if (!graph) return <Centered>지식 그래프를 불러오는 중…</Centered>;
  if (graph.nodes.length === 0) {
    return (
      <Centered>
        아직 위키 빌드가 없습니다.
        <br />
        폴더를 등록하고 빌드를 한 번 돌리면 문서 사이의 관계가 여기에 나타납니다.
      </Centered>
    );
  }

  return (
    <GraphCanvas graph={graph} focusPath={focusPath} networks={networks} docIndex={docIndex} />
  );
}

function GraphCanvas({
  graph,
  focusPath,
  networks,
  docIndex,
}: {
  graph: WikiGraph;
  focusPath: string | null;
  networks: NetworkIndex;
  docIndex: DocIndex;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: 0 });

  const [display, setDisplay] = useState<DisplayOptions>(DEFAULT_DISPLAY);
  const [forces, setForces] = useState<SimForces>(DEFAULT_FORCES);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selected, setSelected] = useState<WikiGraphNode | null>(null);
  /** 아래 정보줄을 문서 대신 **네트워크 요약**으로 바꿔 놓았는지. */
  const [networkOpen, setNetworkOpen] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);

  // 프레임마다 바뀌는 값은 ref 에 둔다 — setState 로 돌리면 리렌더가 시뮬레이션을 못 따라온다.
  const bodiesRef = useRef<GraphBody[]>([]);
  const viewRef = useRef<ViewTransform>({ scale: 1, tx: 0, ty: 0 });
  const hoverRef = useRef(-1);
  const selectedRef = useRef(-1);
  const dragRef = useRef<{ index: number; x: number; y: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  /** 사용자가 화면을 만지기 전까지는 자동으로 전체가 보이게 맞춘다. */
  const autoFitRef = useRef(true);
  const runningRef = useRef(false);
  const displayRef = useRef(display);
  const forcesRef = useRef(forces);
  displayRef.current = display;
  forcesRef.current = forces;

  const nodes = graph.nodes;
  const edges = graph.edges;

  const indexOf = useMemo(() => {
    const map = new Map<string, number>();
    nodes.forEach((node, i) => map.set(node.docId, i));
    return map;
  }, [nodes]);

  const links = useMemo(() => buildLinks(edges, indexOf), [edges, indexOf]);

  /** 점에 붙일 이름·색. 프레임마다 다시 만들지 않도록 한 번만 계산해 둔다. */
  const labels = useMemo(() => nodes.map((node) => truncate(documentLabel(node))), [nodes]);
  const colors = useMemo(
    () => nodes.map((node) => networks.byDoc.get(node.docId)?.color ?? UNLINKED_COLOR),
    [networks, nodes],
  );

  /** 강조할 때 쓰는 이웃 표. 매 프레임 링크를 훑지 않으려고 미리 만들어 둔다. */
  const neighbors = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const link of links) {
      if (!map.has(link.a)) map.set(link.a, new Set());
      if (!map.has(link.b)) map.set(link.b, new Set());
      map.get(link.a)!.add(link.b);
      map.get(link.b)!.add(link.a);
    }
    return map;
  }, [links]);

  useEffect(() => {
    bodiesRef.current = seedBodies(nodes, degreeMap(edges));
    autoFitRef.current = true;
  }, [nodes, edges]);

  /* ---- 그리기 ---- */

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const { w, h } = sizeRef.current;
    if (w === 0 || h === 0) return;

    const bodies = bodiesRef.current;
    const view = viewRef.current;
    const opts = displayRef.current;
    const dpr = window.devicePixelRatio || 1;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, w, h);
    context.translate(view.tx, view.ty);
    context.scale(view.scale, view.scale);

    // 강조 대상 — 가리킨 점이 우선이고, 없으면 고른 점.
    const focus = hoverRef.current >= 0 ? hoverRef.current : selectedRef.current;
    const lit = focus >= 0 ? (neighbors.get(focus) ?? new Set<number>()) : null;
    const isLit = (i: number) => !lit || i === focus || lit.has(i);

    /* 링크 — 흐린 것과 강조된 것을 나눠 그린다(색을 바꿀 때마다 획을 끊으면 느려진다). */
    for (const pass of [false, true]) {
      context.beginPath();
      let drew = false;
      for (const link of links) {
        const a = bodies[link.a];
        const b = bodies[link.b];
        if (!a || !b) continue;
        const active = focus >= 0 && (link.a === focus || link.b === focus);
        if (active !== pass) continue;
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        drew = true;
      }
      if (!drew) continue;
      context.strokeStyle = pass ? LINK_LIT : LINK_DIM;
      context.globalAlpha = pass ? 0.85 : focus >= 0 ? 0.18 : 0.55;
      // 굵기는 그래프와 함께 확대된다(옵시디언과 같다). 다만 아주 축소해도 선이 아주
      // 사라지지는 않게 화면 기준 최소 굵기를 둔다 — 관계가 없어 보이면 그래프가 아니다.
      const width = pass ? opts.linkThickness * 1.5 : opts.linkThickness;
      context.lineWidth = Math.max(width, 0.6 / view.scale);
      context.stroke();
    }
    context.globalAlpha = 1;

    if (opts.arrows) drawArrows(context, bodies, links, opts, focus);

    /* 점 */
    for (let i = 0; i < bodies.length; i += 1) {
      const body = bodies[i]!;
      const node = nodes[i]!;
      const radius = nodeRadius(body.degree, opts.nodeScale);
      const active = isLit(i);
      context.globalAlpha = active ? (node.status === 'active' ? 1 : 0.55) : 0.15;

      const color = colors[i] ?? UNLINKED_COLOR;

      if (i === focus) {
        // 가리킨 점 둘레의 옅은 후광 — 어디를 보고 있는지 한눈에 들어온다.
        context.beginPath();
        context.arc(body.x, body.y, radius * 1.9 + 2, 0, Math.PI * 2);
        context.fillStyle = color;
        context.globalAlpha = 0.22;
        context.fill();
        context.globalAlpha = 1;
      }

      context.beginPath();
      context.arc(body.x, body.y, radius, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();

      if (i === selectedRef.current) {
        // 고른 점은 **색을 덮지 않고** 테두리로 표시한다 — 색은 이미 네트워크를 뜻한다.
        context.beginPath();
        context.arc(body.x, body.y, radius + 2.5, 0, Math.PI * 2);
        context.strokeStyle = SELECTED_RING;
        context.lineWidth = Math.max(1.5, 2 / view.scale);
        context.stroke();
      }
    }
    context.globalAlpha = 1;

    /*
     * 이름표 — 그래프와 함께 확대되고, 너무 축소하면 서서히 사라진다.
     *
     * 읽을 수 없는 크기의 글자를 남겨 두면 점보다 글자가 많아져 그림이 뭉개진다. 옵시디언이
     * 텍스트 페이드를 둔 이유도 같다. 사라지는 배율은 설정에서 사람이 정한다.
     */
    const labelAlpha = Math.max(0, Math.min(1, (view.scale - opts.textFade) / 0.3));
    if (labelAlpha > 0.01) {
      context.textAlign = 'center';
      context.textBaseline = 'top';
      // 글자는 그래프와 함께 커지되 어느 선에서 멈춘다. 끝없이 커지면 크게 볼수록
      // 이름표끼리 겹쳐서, 정작 가까이 보려던 것을 못 보게 된다.
      const fontSize = Math.min(11, 17 / view.scale);
      context.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Pretendard", sans-serif`;
      for (let i = 0; i < bodies.length; i += 1) {
        const body = bodies[i]!;
        const active = isLit(i);
        context.globalAlpha = labelAlpha * (active ? 1 : 0.12);
        context.fillStyle = active ? LABEL : LABEL_DIM;
        context.fillText(
          labels[i] ?? '',
          body.x,
          body.y + nodeRadius(body.degree, opts.nodeScale) + 3,
        );
      }
      context.globalAlpha = 1;
    }

    /*
     * 네트워크 이름 — **가리켰을 때만** 뜬다.
     *
     * 항상 띄워 두면 문서 이름표와 겹쳐서 둘 다 못 읽는다. 알고 싶은 순간은 어차피
     * "지금 보고 있는 이 뭉치가 뭐지?" 하나뿐이라, 그 순간에만 덩어리 한가운데에 크게 띄운다.
     */
    const hoveredNetwork = hoverRef.current >= 0 ? networkAt(hoverRef.current) : null;
    if (hoveredNetwork) {
      const center = centerOf(hoveredNetwork.docIds);
      if (center) {
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        // 이 이름은 그래프의 일부가 아니라 **화면에 얹은 안내**다. 그래서 확대·축소와
        // 무관하게 늘 같은 크기로 읽히게 둔다 — 축소했을 때 못 읽으면 있으나 마나다.
        context.font = `600 ${15 / view.scale}px -apple-system, BlinkMacSystemFont, "Pretendard", sans-serif`;
        // 흰 테두리를 먼저 그어 점·선 위에 겹쳐도 글자가 읽히게 한다.
        context.lineWidth = 5 / view.scale;
        context.strokeStyle = BACKGROUND;
        context.globalAlpha = 0.9;
        context.strokeText(hoveredNetwork.label, center.x, center.y);
        context.globalAlpha = 1;
        context.fillStyle = hoveredNetwork.color;
        context.fillText(hoveredNetwork.label, center.x, center.y);
      }
    }

    const percent = Math.round(view.scale * 100);
    setZoomPercent((current) => (current === percent ? current : percent));

    function networkAt(index: number) {
      const docId = nodes[index]?.docId;
      return docId ? (networks.byDoc.get(docId) ?? null) : null;
    }

    /** 그 네트워크에 속한 점들의 한가운데. 이름을 여기에 놓으면 덩어리 위에 얹힌다. */
    function centerOf(docIds: string[]) {
      let x = 0;
      let y = 0;
      let count = 0;
      for (const docId of docIds) {
        const index = indexOf.get(docId);
        const body = index === undefined ? undefined : bodies[index];
        if (!body) continue;
        x += body.x;
        y += body.y;
        count += 1;
      }
      return count === 0 ? null : { x: x / count, y: y / count };
    }
  }, [colors, indexOf, labels, links, neighbors, networks, nodes]);

  /* ---- 시뮬레이션 ---- */

  const wake = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    const loop = () => {
      if (!runningRef.current) return;
      const energy = stepGraph(bodiesRef.current, links, forcesRef.current, dragRef.current);
      if (autoFitRef.current) {
        viewRef.current = fitTransform(
          graphBounds(bodiesRef.current, displayRef.current.nodeScale),
          sizeRef.current,
        );
      }
      draw();
      if (energy < SLEEP_ENERGY && !dragRef.current) {
        runningRef.current = false; // 잠재운다 — 만지면 다시 깨어난다
        return;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, [draw, links]);

  // 힘을 바꾸면 배치가 달라져야 한다.
  useEffect(() => {
    wake();
  }, [forces, wake]);

  useEffect(() => () => void (runningRef.current = false), []);

  /* ---- 화면 크기 ---- */

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (!box || box.width === 0 || box.height === 0) return;
      sizeRef.current = { w: box.width, h: box.height };
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(box.width * dpr);
      canvas.height = Math.round(box.height * dpr);
      canvas.style.width = `${box.width}px`;
      canvas.style.height = `${box.height}px`;
      if (autoFitRef.current) {
        viewRef.current = fitTransform(
          graphBounds(bodiesRef.current, displayRef.current.nodeScale),
          sizeRef.current,
        );
      }
      draw();
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [draw]);

  useEffect(() => {
    draw();
  }, [display, draw]);

  /* ---- 입력 ---- */

  const pointerAt = (e: { clientX: number; clientY: number }) => {
    const box = canvasRef.current?.getBoundingClientRect();
    return { x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const screen = pointerAt(e);
    const world = toWorld(screen, viewRef.current);
    const index = hitTest(bodiesRef.current, world, display.nodeScale);
    autoFitRef.current = false; // 손을 댄 순간부터는 사용자의 화면이다
    if (index >= 0) {
      dragRef.current = { index, x: world.x, y: world.y };
      selectedRef.current = index;
      setSelected(nodes[index] ?? null);
      wake();
      return;
    }
    // 빈 곳을 누르면 화면을 끈다. 선택은 손을 뗄 때 푼다(끌기와 구분하기 위해).
    panRef.current = { x: screen.x, y: screen.y, tx: viewRef.current.tx, ty: viewRef.current.ty };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const screen = pointerAt(e);
    const world = toWorld(screen, viewRef.current);

    if (dragRef.current) {
      dragRef.current = { ...dragRef.current, x: world.x, y: world.y };
      wake();
      return;
    }
    if (panRef.current) {
      const pan = panRef.current;
      viewRef.current = {
        ...viewRef.current,
        tx: pan.tx + (screen.x - pan.x),
        ty: pan.ty + (screen.y - pan.y),
      };
      draw();
      return;
    }

    const index = hitTest(bodiesRef.current, world, display.nodeScale);
    if (index === hoverRef.current) return;
    hoverRef.current = index;
    e.currentTarget.style.cursor = index >= 0 ? 'pointer' : 'grab';
    draw();
  };

  const endPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const wasPanning = panRef.current;
    const screen = pointerAt(e);
    if (wasPanning) {
      const moved = Math.hypot(screen.x - wasPanning.x, screen.y - wasPanning.y);
      // 끌지 않고 그냥 눌렀다 뗀 것이면 선택 해제.
      if (moved < 3) {
        selectedRef.current = -1;
        setSelected(null);
      }
    }
    panRef.current = null;
    if (dragRef.current) {
      dragRef.current = null;
      wake(); // 놓은 뒤 스스로 자리를 잡도록 한 번 더 돌린다
    }
    draw();
  };

  /** 휠 확대/축소 — **커서 아래 지점을 고정**한다. 중심 기준으로 키우면 보던 곳을 놓친다. */
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const screen = pointerAt(e);
    const view = viewRef.current;
    const next = clampScale(view.scale * Math.exp(-e.deltaY * 0.0015));
    const k = next / view.scale;
    autoFitRef.current = false;
    viewRef.current = {
      scale: next,
      tx: screen.x - (screen.x - view.tx) * k,
      ty: screen.y - (screen.y - view.ty) * k,
    };
    draw();
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const world = toWorld(pointerAt(e), viewRef.current);
    const index = hitTest(bodiesRef.current, world, display.nodeScale);
    const uri = index >= 0 ? nodes[index]?.sourceUri : undefined;
    if (uri) void window.codegate.shell.openOriginal(uri);
  };

  const fit = useCallback(() => {
    autoFitRef.current = true;
    viewRef.current = fitTransform(
      graphBounds(bodiesRef.current, displayRef.current.nodeScale),
      sizeRef.current,
    );
    draw();
  }, [draw]);

  /* ---- 고른 문서의 연결과 그 근거 ---- */

  /** 문서를 코드에서 고른다(연결 목록·네트워크 목록에서 눌렀을 때). */
  const selectDoc = useCallback(
    (docId: string) => {
      const index = indexOf.get(docId);
      if (index === undefined) return;
      selectedRef.current = index;
      setSelected(nodes[index] ?? null);
      setNetworkOpen(false);
      draw();
    },
    [draw, indexOf, nodes],
  );

  const connections = useMemo((): Connection[] => {
    if (!selected) return [];
    const byId = new Map(nodes.map((node) => [node.docId, node]));
    const found: Connection[] = [];
    for (const edge of edges) {
      const otherId =
        edge.from === selected.docId ? edge.to : edge.to === selected.docId ? edge.from : null;
      if (!otherId) continue;
      const other = byId.get(otherId);
      if (!other) continue;
      found.push({ node: other, sharedEntities: edge.sharedEntities });
    }
    // 근거가 많은 연결이 먼저 — 겹친 개수가 곧 연결의 강도다.
    return found.sort(
      (a, b) => (b.sharedEntities?.length ?? 0) - (a.sharedEntities?.length ?? 0),
    );
  }, [edges, nodes, selected]);

  const selectedNetwork = selected ? (networks.byDoc.get(selected.docId) ?? null) : null;

  /** 네트워크를 묶은 것 — 그 안의 관계들이 근거로 삼은 엔티티를 많이 나온 순으로. */
  const networkReasons = useMemo(() => {
    if (!selectedNetwork) return [];
    const members = new Set(selectedNetwork.docIds);
    const counts = new Map<string, number>();
    for (const edge of edges) {
      if (!members.has(edge.from) || !members.has(edge.to)) continue;
      for (const entity of edge.sharedEntities ?? []) {
        counts.set(entity.name, (counts.get(entity.name) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
      .slice(0, 12);
  }, [edges, selectedNetwork]);

  const networkDocuments = useMemo(() => {
    if (!selectedNetwork) return [];
    const byId = new Map(nodes.map((node) => [node.docId, node]));
    return selectedNetwork.docIds
      .map((docId) => byId.get(docId))
      .filter((node): node is WikiGraphNode => Boolean(node));
  }, [nodes, selectedNetwork]);

  /* ---- 트리에서 들어온 파일 ---- */

  const fromTree = useMemo(
    () => (focusPath ? docIndex(focusPath) : {}),
    [docIndex, focusPath],
  );
  useEffect(() => {
    const index = fromTree.docId === undefined ? undefined : indexOf.get(fromTree.docId);
    const node = index === undefined ? undefined : nodes[index];
    if (index === undefined || !node) return;
    selectedRef.current = index;
    setSelected(node);
    // 고른 문서를 화면 한가운데로 데려온다 — 어디 있는지 찾게 두지 않는다.
    const body = bodiesRef.current[index];
    if (body) {
      autoFitRef.current = false;
      const { scale } = viewRef.current;
      viewRef.current = {
        scale,
        tx: sizeRef.current.w / 2 - body.x * scale,
        ty: sizeRef.current.h / 2 - body.y * scale,
      };
    }
    draw();
  }, [draw, fromTree, indexOf, nodes]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex items-center gap-3 border-b border-ink-100 px-5 py-3">
        <span className="text-xs font-semibold text-ink-700">지식 그래프</span>
        <span className="text-2xs text-ink-400">
          문서 {nodes.length} · 관계 {edges.length}
        </span>
        {focusPath && fromTree.reason && (
          /*
           * 조용히 넘어가면 "왜 안 켜지지" 가 된다. 그리고 **못 찾은 것과 여럿인 것은 다르다** —
           * 전자는 빌드를 돌리면 되고, 후자는 어느 문서인지 사람이 정해야 한다.
           */
          <span className="truncate text-2xs text-amber-600">
            {fromTree.reason === 'missing'
              ? `«${basename(focusPath)}» 는 아직 이 빌드에 없습니다`
              : `«${basename(focusPath)}» 에 연결된 문서가 여럿이라 하나를 고르지 못했습니다`}
          </span>
        )}
        <span className="flex-1" />
        <span className="shrink-0 text-2xs text-ink-300">
          점을 끌어 옮기고, 빈 곳을 끌어 화면 이동 · 휠로 확대·축소 · 두 번 눌러 원본 열기
        </span>
        <span className="shrink-0 font-mono text-2xs text-ink-400">{zoomPercent}%</span>
        <button
          onClick={fit}
          className="shrink-0 text-2xs font-semibold text-ink-500 hover:text-ink-800"
        >
          맞춤
        </button>
      </header>

      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden">
        <canvas
          ref={canvasRef}
          className="block touch-none select-none"
          style={{ cursor: 'grab' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onWheel={onWheel}
          onDoubleClick={onDoubleClick}
        />

        <button
          onClick={() => setPanelOpen((open) => !open)}
          aria-label="그래프 설정"
          className={cn(
            'absolute left-3 top-3 grid h-8 w-8 place-items-center rounded-md border border-ink-150 bg-white text-ink-500',
            'hover:text-ink-800',
            panelOpen && 'text-ink-800',
          )}
        >
          <GearIcon />
        </button>
        {panelOpen && (
          <SettingsPanel
            display={display}
            forces={forces}
            onDisplay={setDisplay}
            onForces={setForces}
          />
        )}
      </div>

      {selected &&
        (networkOpen && selectedNetwork ? (
          <NetworkDetail
            network={selectedNetwork}
            documents={networkDocuments}
            reasons={networkReasons}
            onClose={() => setNetworkOpen(false)}
            onSelect={selectDoc}
          />
        ) : (
          <NodeDetail
            node={selected}
            network={selectedNetwork}
            connections={connections}
            onSelect={selectDoc}
            onShowNetwork={() => setNetworkOpen(true)}
          />
        ))}
    </div>
  );
}

/* ---- 설정 ---- */

function SettingsPanel({
  display,
  forces,
  onDisplay,
  onForces,
}: {
  display: DisplayOptions;
  forces: SimForces;
  onDisplay: (next: DisplayOptions) => void;
  onForces: (next: SimForces) => void;
}) {
  return (
    <div className="absolute left-3 top-[52px] w-60 rounded-lg border border-ink-150 bg-white p-3 shadow-xl">
      <Section title="표시">
        <Slider
          label="점 크기"
          min={0.4}
          max={3}
          step={0.1}
          value={display.nodeScale}
          onChange={(nodeScale) => onDisplay({ ...display, nodeScale })}
        />
        <Slider
          label="링크 굵기"
          min={0.3}
          max={4}
          step={0.1}
          value={display.linkThickness}
          onChange={(linkThickness) => onDisplay({ ...display, linkThickness })}
        />
        <Slider
          label="이름표 표시 배율"
          min={0}
          max={2}
          step={0.05}
          value={display.textFade}
          onChange={(textFade) => onDisplay({ ...display, textFade })}
        />
        <Toggle
          label="화살표"
          checked={display.arrows}
          onChange={(arrows) => onDisplay({ ...display, arrows })}
        />
      </Section>
      <Section title="힘">
        <Slider
          label="중심으로 모으기"
          min={0}
          max={1}
          step={0.05}
          value={forces.center}
          onChange={(center) => onForces({ ...forces, center })}
        />
        <Slider
          label="서로 밀어내기"
          min={0}
          max={1}
          step={0.05}
          value={forces.repel}
          onChange={(repel) => onForces({ ...forces, repel })}
        />
        <Slider
          label="링크 당기기"
          min={0}
          max={1}
          step={0.05}
          value={forces.linkForce}
          onChange={(linkForce) => onForces({ ...forces, linkForce })}
        />
        <Slider
          label="링크 길이"
          min={30}
          max={320}
          step={5}
          value={forces.linkDistance}
          onChange={(linkDistance) => onForces({ ...forces, linkDistance })}
        />
      </Section>
      <button
        onClick={() => {
          onDisplay(DEFAULT_DISPLAY);
          onForces(DEFAULT_FORCES);
        }}
        className="mt-1 w-full rounded-md border border-ink-150 py-1 text-2xs text-ink-500 hover:text-ink-800"
      >
        기본값으로
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-400">{title}</p>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-0.5 flex justify-between text-2xs text-ink-500">
        {label}
        <span className="font-mono text-ink-300">{value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-ink-150 accent-blue-500"
      />
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between text-2xs text-ink-500">
      {label}
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-blue-500"
      />
    </label>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** 화살표는 링크 위에 따로 그린다 — 켰을 때만 도는 비용이라 기본값(꺼짐)에는 부담이 없다. */
function drawArrows(
  context: CanvasRenderingContext2D,
  bodies: GraphBody[],
  links: { a: number; b: number }[],
  opts: DisplayOptions,
  focus: number,
) {
  const size = 4;
  for (const link of links) {
    const a = bodies[link.a];
    const b = bodies[link.b];
    if (!a || !b) continue;
    const active = focus >= 0 && (link.a === focus || link.b === focus);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const back = nodeRadius(b.degree, opts.nodeScale) + size;
    const tipX = b.x - (dx / d) * back;
    const tipY = b.y - (dy / d) * back;
    const angle = Math.atan2(dy, dx);
    context.globalAlpha = active ? 0.85 : focus >= 0 ? 0.15 : 0.45;
    context.fillStyle = active ? LINK_LIT : LINK_DIM;
    context.beginPath();
    context.moveTo(tipX, tipY);
    context.lineTo(
      tipX - Math.cos(angle - 0.4) * size * 2,
      tipY - Math.sin(angle - 0.4) * size * 2,
    );
    context.lineTo(
      tipX - Math.cos(angle + 0.4) * size * 2,
      tipY - Math.sin(angle + 0.4) * size * 2,
    );
    context.closePath();
    context.fill();
  }
  context.globalAlpha = 1;
}

/**
 * 고른 문서의 정보줄 — **왜 이어졌는지**까지 보여준다.
 *
 * 관계를 그려 놓고 이유를 못 대면 사용자는 그것을 믿을 수도 고칠 수도 없다. 특히 이 관계는
 * 사람이 적은 링크가 아니라 **엔티티 겹침으로 유도한 것**이라 더욱 그렇다. 그래서 이웃마다
 * 함께 언급한 것이 무엇인지, 그리고 **양쪽이 각각 어느 문장에서 말했는지**를 나란히 둔다.
 * 한쪽만 보이면 "이 문서가 저 문서를 가리킨다"로 읽히는데, 엔티티 겹침에는 방향이 없다.
 */
function NodeDetail({
  node,
  network,
  connections,
  onSelect,
  onShowNetwork,
}: {
  node: WikiGraphNode;
  network: DocNetwork | null;
  connections: Connection[];
  onSelect: (docId: string) => void;
  onShowNetwork: () => void;
}) {
  return (
    <footer className="max-h-64 shrink-0 overflow-y-auto border-t border-ink-100 bg-ink-50 px-5 py-3">
      <div className="flex items-center gap-2">
        <span className="truncate text-xs font-semibold text-ink-800">{documentLabel(node)}</span>
        {network && (
          <button
            onClick={onShowNetwork}
            title="이 네트워크는 무엇으로 묶였는지 보기"
            className="flex shrink-0 items-center gap-1 rounded-full border border-ink-150 bg-white px-2 py-0.5 text-2xs text-ink-600 hover:border-ink-300"
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: network.color }} />
            {network.label}
          </button>
        )}
        <span className="shrink-0 font-mono text-2xs text-ink-400">{node.docType}</span>
        <span className="flex-1" />
        {node.sourceUri && (
          <button
            onClick={() => void window.codegate.shell.openOriginal(node.sourceUri!)}
            className="shrink-0 text-2xs font-semibold text-blue-600 hover:text-blue-700"
          >
            원본 열기
          </button>
        )}
      </div>
      {node.summary && <p className="mt-1.5 line-clamp-2 text-2xs text-ink-500">{node.summary}</p>}

      <p className="mt-2.5 text-2xs font-semibold text-ink-500">
        {connections.length === 0 ? '이어진 문서 없음' : `이어진 문서 ${connections.length}`}
      </p>
      {connections.length === 0 ? (
        // 왜 혼자인지도 말해 준다 — 빈 목록만 두면 고장인지 사실인지 알 수 없다.
        <p className="mt-1 text-2xs text-ink-400">
          이 문서에는 다른 문서와 함께 언급한 것이 없어 아직 어디에도 이어지지 않았습니다.
        </p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1.5">
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.node.docId}
              connection={connection}
              onSelect={() => onSelect(connection.node.docId)}
            />
          ))}
        </ul>
      )}
    </footer>
  );
}

function ConnectionRow({
  connection,
  onSelect,
}: {
  connection: Connection;
  onSelect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const shared = connection.sharedEntities ?? [];
  return (
    <li className="rounded-md border border-ink-100 bg-white px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <button
          onClick={onSelect}
          className="min-w-0 flex-1 truncate text-left text-2xs font-medium text-ink-700 hover:text-blue-600"
        >
          {documentLabel(connection.node)}
        </button>
        {shared.length > 0 && (
          <span className="flex shrink-0 items-center gap-1">
            {shared.slice(0, 3).map((entity) => (
              <span
                key={entity.name}
                className="rounded-sm bg-ink-100 px-1.5 py-0.5 text-[10px] text-ink-600"
              >
                {entity.name}
              </span>
            ))}
            {shared.length > 3 && (
              <span className="text-[10px] text-ink-400">+{shared.length - 3}</span>
            )}
          </span>
        )}
        {shared.length > 0 ? (
          <button
            onClick={() => setOpen((value) => !value)}
            className="shrink-0 text-[10px] text-ink-400 hover:text-ink-700"
          >
            {open ? '근거 접기' : '근거 보기'}
          </button>
        ) : (
          // 옛 빌드에는 근거가 저장돼 있지 않다. 없는 것을 있는 척하지 않는다.
          <span className="shrink-0 text-[10px] text-ink-300">근거 없음</span>
        )}
      </div>
      {open && (
        <dl className="mt-1.5 flex flex-col gap-1.5 border-t border-ink-100 pt-1.5">
          {shared.map((entity) => (
            <div key={entity.name}>
              <dt className="text-[10px] font-semibold text-ink-600">
                {entity.name}
                {entity.type && <span className="ml-1 font-normal text-ink-300">{entity.type}</span>}
              </dt>
              {/*
               * 양쪽 문장을 나란히 — 사용자가 "둘 다 이것을 적었구나"를 직접 확인한다.
               * 다만 문장이 엔티티 이름 그대로이거나 양쪽이 똑같으면 같은 줄을 두 번 보여주는
               * 셈이라, 근거가 많아 보이게 만들 뿐 아무것도 더 알려주지 않는다.
               */}
              {quotesOf(entity).map((quote, index) => (
                <dd
                  key={index}
                  className="mt-0.5 border-l-2 border-ink-150 pl-2 text-[10px] leading-relaxed text-ink-500"
                >
                  {quote}
                </dd>
              ))}
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

/**
 * 보여줄 만한 근거 문장만 남긴다.
 *
 * 뽑힌 문장이 엔티티 이름과 똑같으면(짧은 발표자료에서 흔하다) 이름을 한 번 더 적는 것뿐이라
 * 아무것도 더 알려주지 않는다. 양쪽 문장이 같을 때도 한 번만 보여준다.
 */
function quotesOf(entity: SharedEntity): string[] {
  const meaningful = [entity.fromQuote, entity.toQuote].filter(
    (quote) => quote.trim() !== entity.name.trim(),
  );
  return [...new Set(meaningful)];
}

/**
 * 네트워크 요약 — "이 문서들이 왜 한 색인가".
 *
 * 개별 연결의 근거를 모아 **무엇이 이 뭉치를 묶었는지**를 많이 나온 순으로 보여준다.
 * 사람 이름만 잔뜩 보인다면 그 자체가 알아야 할 사실이다 — 이 뭉치는 주제가 아니라
 * 등장인물로 묶여 있다는 뜻이니까.
 */
function NetworkDetail({
  network,
  documents,
  reasons,
  onClose,
  onSelect,
}: {
  network: DocNetwork;
  documents: WikiGraphNode[];
  reasons: { name: string; count: number }[];
  onClose: () => void;
  onSelect: (docId: string) => void;
}) {
  return (
    <footer className="max-h-64 shrink-0 overflow-y-auto border-t border-ink-100 bg-ink-50 px-5 py-3">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: network.color }} />
        <span className="truncate text-xs font-semibold text-ink-800">{network.label}</span>
        <span className="shrink-0 text-2xs text-ink-400">문서 {network.docIds.length}</span>
        <span className="flex-1" />
        <button onClick={onClose} className="shrink-0 text-2xs font-semibold text-ink-500 hover:text-ink-800">
          닫기
        </button>
      </div>

      <p className="mt-2.5 text-2xs font-semibold text-ink-500">이 뭉치를 묶은 것</p>
      {reasons.length === 0 ? (
        <p className="mt-1 text-2xs text-ink-400">
          이 빌드에는 관계의 근거가 저장돼 있지 않습니다. 다시 빌드하면 나타납니다.
        </p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-1">
          {reasons.map((reason) => (
            <li
              key={reason.name}
              className="rounded-sm bg-white px-1.5 py-0.5 text-[10px] text-ink-600 ring-1 ring-ink-100"
            >
              {reason.name}
              <span className="ml-1 font-mono text-ink-400">{reason.count}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2.5 text-2xs font-semibold text-ink-500">문서</p>
      <ul className="mt-1 flex flex-col">
        {documents.map((document) => (
          <li key={document.docId}>
            <button
              onClick={() => onSelect(document.docId)}
              className="w-full truncate rounded-sm px-1 py-0.5 text-left text-2xs text-ink-600 hover:bg-white hover:text-blue-600"
            >
              {documentLabel(document)}
            </button>
          </li>
        ))}
      </ul>
    </footer>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div className="flex h-full items-center justify-center bg-white px-8 text-center">
      <p className={cn('text-sm leading-relaxed', tone === 'error' ? 'text-red-600' : 'text-ink-400')}>
        {children}
      </p>
    </div>
  );
}

function basename(path: string): string {
  return path.split('/').pop() || path;
}

function truncate(text: string, max = 22): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
