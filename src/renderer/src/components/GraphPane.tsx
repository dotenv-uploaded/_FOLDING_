import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WikiGraph, WikiGraphNode } from '@contracts';
import { cn } from '@/lib/cn';
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
 * 옵시디언 그래프 뷰의 감각을 그대로 따랐다: 어두운 무한 평면, 링크 수에 비례하는 점,
 * 가리키면 그 문서와 이웃만 남고 나머지는 흐려지는 강조, 그리고 힘을 직접 조절하는 설정.
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

/* ---- 색 (어두운 배경 기준) ---- */
const BACKGROUND = '#1a1a1c';
const LINK_DIM = '#33363d';
const LINK_LIT = '#4ec3e0';
const LABEL = '#c3c8d1';
const LABEL_DIM = '#5d626b';

/** 문서 종류별 색 — 옵시디언의 색 그룹에 해당한다. */
const TYPE_COLOR: Record<string, string> = {
  regulation: '#6aa9ff',
  policy: '#6aa9ff',
  contract: '#ff6b6b',
  procedure: '#7ad17a',
  manual: '#7ad17a',
  guide: '#7ad17a',
  specification: '#c08cff',
  report: '#ffc861',
  meeting_note: '#ffc861',
  general: '#98a0ad',
};
const SELECTED_COLOR = '#ffffff';

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

const DEFAULT_DISPLAY: DisplayOptions = {
  nodeScale: 1,
  linkThickness: 1,
  textFade: 0.4,
  arrows: false,
};

export function GraphPane({
  focusPath,
}: {
  /**
   * 트리에서 더블클릭해 들어온 **파일 경로**. 트리는 doc_id 를 모르므로 경로로 받아
   * 여기서 manifest 의 `sourceUri` 와 대조해 노드를 찾는다.
   */
  focusPath: string | null;
}) {
  const [graph, setGraph] = useState<WikiGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.codegate.wiki
      .graph()
      .then((g) => alive && setGraph(g))
      .catch((err: unknown) => {
        // 그래프를 못 읽었으면 빈 화면이 아니라 이유를 보여준다.
        if (alive) setError(err instanceof Error ? err.message : '지식 그래프를 불러오지 못했습니다.');
      });
    return () => {
      alive = false;
    };
  }, []);

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

  return <GraphCanvas graph={graph} focusPath={focusPath} />;
}

function GraphCanvas({ graph, focusPath }: { graph: WikiGraph; focusPath: string | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: 0 });

  const [display, setDisplay] = useState<DisplayOptions>(DEFAULT_DISPLAY);
  const [forces, setForces] = useState<SimForces>(DEFAULT_FORCES);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selected, setSelected] = useState<WikiGraphNode | null>(null);
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

      if (i === focus) {
        // 가리킨 점 둘레의 옅은 후광 — 어디를 보고 있는지 한눈에 들어온다.
        context.beginPath();
        context.arc(body.x, body.y, radius * 1.9 + 2, 0, Math.PI * 2);
        context.fillStyle = LINK_LIT;
        context.globalAlpha = 0.2;
        context.fill();
        context.globalAlpha = 1;
      }

      context.beginPath();
      context.arc(body.x, body.y, radius, 0, Math.PI * 2);
      context.fillStyle =
        i === selectedRef.current ? SELECTED_COLOR : (TYPE_COLOR[node.docType] ?? TYPE_COLOR.general);
      context.fill();
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
      context.font = '11px -apple-system, BlinkMacSystemFont, "Pretendard", sans-serif';
      for (let i = 0; i < bodies.length; i += 1) {
        const body = bodies[i]!;
        const active = isLit(i);
        context.globalAlpha = labelAlpha * (active ? 1 : 0.12);
        context.fillStyle = active ? LABEL : LABEL_DIM;
        context.fillText(
          truncate(nodes[i]!.title),
          body.x,
          body.y + nodeRadius(body.degree, opts.nodeScale) + 3,
        );
      }
      context.globalAlpha = 1;
    }

    const percent = Math.round(view.scale * 100);
    setZoomPercent((current) => (current === percent ? current : percent));
  }, [links, neighbors, nodes]);

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

  /* ---- 트리에서 들어온 파일 ---- */

  const fromTree = useMemo(() => matchNode(nodes, focusPath), [nodes, focusPath]);
  useEffect(() => {
    const node = fromTree.node;
    if (!node) return;
    const index = indexOf.get(node.docId);
    if (index === undefined) return;
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
  }, [draw, fromTree, indexOf]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#1a1a1c]">
      <header className="flex items-center gap-3 border-b border-[#2a2b30] px-5 py-3">
        <span className="text-xs font-semibold text-[#d5d9e0]">지식 그래프</span>
        <span className="text-2xs text-[#71767f]">
          문서 {nodes.length} · 관계 {edges.length}
        </span>
        {focusPath && fromTree.reason && (
          /*
           * 조용히 넘어가면 "왜 안 켜지지" 가 된다. 그리고 **못 찾은 것과 여럿인 것은 다르다** —
           * 전자는 빌드를 돌리면 되고, 후자는 어느 문서인지 사람이 정해야 한다.
           */
          <span className="truncate text-2xs text-amber-400">
            {fromTree.reason === 'missing'
              ? `«${basename(focusPath)}» 는 아직 이 빌드에 없습니다`
              : `«${basename(focusPath)}» 에 연결된 문서가 여럿이라 하나를 고르지 못했습니다`}
          </span>
        )}
        <span className="flex-1" />
        <span className="shrink-0 text-2xs text-[#5d626b]">
          점을 끌어 옮기고, 빈 곳을 끌어 화면 이동 · 휠로 확대·축소 · 두 번 눌러 원본 열기
        </span>
        <span className="shrink-0 font-mono text-2xs text-[#71767f]">{zoomPercent}%</span>
        <button
          onClick={fit}
          className="shrink-0 text-2xs font-semibold text-[#9aa0aa] hover:text-[#e6e9ee]"
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
            'absolute left-3 top-3 grid h-8 w-8 place-items-center rounded-md border border-[#2f3037] bg-[#232428] text-[#9aa0aa]',
            'hover:text-[#e6e9ee]',
            panelOpen && 'text-[#e6e9ee]',
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

      {selected && <NodeDetail node={selected} />}
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
    <div className="absolute left-3 top-[52px] w-60 rounded-lg border border-[#2f3037] bg-[#232428] p-3 shadow-xl">
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
        className="mt-1 w-full rounded-md border border-[#33343b] py-1 text-2xs text-[#9aa0aa] hover:text-[#e6e9ee]"
      >
        기본값으로
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-[#71767f]">{title}</p>
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
      <span className="mb-0.5 flex justify-between text-2xs text-[#9aa0aa]">
        {label}
        <span className="font-mono text-[#5d626b]">{value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-[#3a3b42] accent-[#4ec3e0]"
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
    <label className="flex cursor-pointer items-center justify-between text-2xs text-[#9aa0aa]">
      {label}
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[#4ec3e0]"
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

function NodeDetail({ node }: { node: WikiGraphNode }) {
  return (
    <footer className="border-t border-[#2a2b30] bg-[#202124] px-5 py-3">
      <div className="flex items-center gap-2">
        <span className="truncate text-xs font-semibold text-[#e6e9ee]">{node.title}</span>
        <span className="shrink-0 font-mono text-2xs text-[#71767f]">
          {node.docId} · {node.docType} · {node.status}
        </span>
        <span className="flex-1" />
        {node.sourceUri && (
          <button
            onClick={() => void window.codegate.shell.openOriginal(node.sourceUri!)}
            className="shrink-0 text-2xs font-semibold text-[#4ec3e0] hover:text-[#7ad6ec]"
          >
            원본 열기
          </button>
        )}
      </div>
      {node.summary && <p className="mt-1.5 line-clamp-2 text-2xs text-[#8b919b]">{node.summary}</p>}
    </footer>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div className="flex h-full items-center justify-center bg-[#1a1a1c] px-8 text-center">
      <p className={cn('text-sm leading-relaxed', tone === 'error' ? 'text-red-400' : 'text-[#71767f]')}>
        {children}
      </p>
    </div>
  );
}

/**
 * 트리의 파일 경로로 그래프 노드를 찾는다.
 *
 * 두 값의 모양이 다르다 — 트리는 `<rootId>/<상대경로>`, manifest 는 `source://<...>` 이거나
 * 절대경로다. 그래서 **뒤에서부터 겹치는지**로 맞춘다. 그래도 못 찾으면 파일명으로 한 번 더
 * 본다. 어느 쪽이든 **후보가 여럿이면 찍지 않는다** — 엉뚱한 노드를 켜 놓고 맞다고 하는
 * 것보다, 못 찾았다고 말하는 편이 낫다.
 */
function matchNode(
  nodes: WikiGraphNode[],
  path: string | null,
): { node?: WikiGraphNode; reason?: 'missing' | 'ambiguous' } {
  if (!path) return {};
  const tail = path.replace(/^source:\/\//, '');

  const exact = nodes.filter((n) => {
    const uri = n.sourceUri?.replace(/^source:\/\//, '');
    if (!uri) return false;
    return uri === tail || uri.endsWith(`/${tail}`) || tail.endsWith(`/${uri}`);
  });
  if (exact.length === 1) return { node: exact[0] };
  if (exact.length > 1) return { reason: 'ambiguous' };

  const name = basename(tail);
  const byName = nodes.filter((n) => (n.sourceFilename ?? basename(n.sourceUri ?? '')) === name);
  if (byName.length === 1) return { node: byName[0] };
  return { reason: byName.length > 1 ? 'ambiguous' : 'missing' };
}

function basename(path: string): string {
  return path.split('/').pop() || path;
}

function truncate(text: string, max = 18): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
