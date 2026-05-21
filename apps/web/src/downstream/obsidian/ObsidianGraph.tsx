// Force-directed graph view of the vault. Each note is a node; each
// resolved wikilink is an undirected edge. Layout uses a hand-rolled
// d3-style force simulation (repulsion + spring + centering) so we
// don't pull in d3-force as a dependency. Render is SVG — fine for the
// dozen-node mock vault; Phase B+ may switch to canvas/pixi if the
// real vault grows past a few hundred notes.
//
// Force parameters mirror Obsidian's defaults verbatim (centerStrength
// 0.1, repelStrength 10, linkStrength 1, linkDistance 250) so the
// visual character matches once we scale to a real vault. Distances are
// scaled down here for the small mock graph to keep nodes from drifting
// off-screen.
//
// Pan: mouse drag. Zoom: wheel. Click on a node opens that note
// (delegated up via onOpenNote — typically switches back to the Файл
// tab and sets activePath).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ObsidianGraphPayload } from './api';

interface Props {
  graph: ObsidianGraphPayload;
  onOpenNote: (path: string) => void;
}

interface SimNode {
  id: string;
  label: string;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  // When the user is dragging a node we freeze it: forces don't apply
  // and position is set directly from the pointer. Released on
  // pointer-up so the simulation can reflow around the new arrangement.
  fixed: boolean;
}

interface SimEdge {
  source: string;
  target: string;
}

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Obsidian defaults — see app.js search hits in commit notes.
// Strengths bumped over the raw Obsidian defaults so our tiny 10-node
// vault doesn't clump in the middle — with this few nodes the
// inverse-square repulsion needs more headroom to push them apart.
const CENTER_STRENGTH = 0.08;
const REPEL_STRENGTH = 35;
const LINK_STRENGTH = 1;
const LINK_DISTANCE = 130;
const FRICTION = 0.7;
const MIN_VELOCITY = 0.01;
const MAX_STEPS = 600;

const BASE_RADIUS = 4;
const RADIUS_PER_DEGREE = 1.4;
const LABEL_OFFSET = 4;
const INITIAL_VIEW: ViewBox = { x: -400, y: -300, w: 800, h: 600 };

export function ObsidianGraph({ graph, onOpenNote }: Props) {

  const svgRef = useRef<SVGSVGElement | null>(null);
  const nodesRef = useRef<SimNode[]>(initNodes(graph.nodes));
  const edgesRef = useRef<SimEdge[]>(graph.edges);
  const stepRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  // While the user hasn't interacted with the view, we keep re-fitting
  // the viewBox each tick so the simulation stays framed. As soon as
  // they pan or zoom, we honor their view forever.
  const viewLockedRef = useRef(false);
  // Currently-dragged node id (if any) and the simulation-loop
  // restarter so we can re-warm after the user drops a node.
  const dragNodeIdRef = useRef<string | null>(null);
  const loopStarterRef = useRef<() => void>(() => undefined);

  // Force a re-render at ~30fps while the simulation is still settling.
  // Once velocities fall below MIN_VELOCITY we stop the loop entirely.
  const [, setTick] = useState(0);
  const [view, setView] = useState<ViewBox>(INITIAL_VIEW);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [draggingPan, setDraggingPan] = useState(false);
  const panOriginRef = useRef<{ x: number; y: number; view: ViewBox } | null>(null);

  // Read the SVG's current aspect ratio for fitView calls. Falls back
  // to 4:3 if the SVG isn't mounted yet (first render). Recomputed on
  // each call so window resizes are handled naturally.
  const currentSvgAspect = useCallback((): number => {
    const svg = svgRef.current;
    if (!svg) return DEFAULT_ASPECT;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return DEFAULT_ASPECT;
    return rect.width / rect.height;
  }, []);

  useEffect(() => {
    // Reset simulation each time the graph data identity changes.
    nodesRef.current = initNodes(graph.nodes);
    edgesRef.current = graph.edges;
    stepRef.current = 0;
    viewLockedRef.current = false;
    setView(fitView(nodesRef.current, currentSvgAspect()));
    let lastFrame = 0;
    const loop = (ts: number) => {
      // Throttle to ~30fps so we don't burn CPU on a settled layout.
      if (ts - lastFrame < 33) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }
      lastFrame = ts;
      const settled = tickSimulation(nodesRef.current, edgesRef.current);
      stepRef.current += 1;
      // Re-fit while the user has not touched the view yet — keeps the
      // graph framed as it grows out from the initial seed positions.
      // Skip while a node is being dragged so the cluster's expanding
      // bbox doesn't squeeze the rest of the view.
      if (!viewLockedRef.current && !dragNodeIdRef.current) {
        setView(fitView(nodesRef.current, currentSvgAspect()));
      }
      setTick((n) => n + 1);
      if ((settled || stepRef.current >= MAX_STEPS) && !dragNodeIdRef.current) {
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    const startLoop = () => {
      if (rafRef.current !== null) return;
      lastFrame = 0;
      stepRef.current = 0;
      rafRef.current = requestAnimationFrame(loop);
    };
    loopStarterRef.current = startLoop;
    startLoop();
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [graph]);

  // Wheel zoom — anchor zoom at the cursor so the point under the
  // mouse stays put. Wheel-up zooms in (smaller viewBox), down zooms
  // out. Clamp so the user can't lose the graph entirely.
  const onWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      e.preventDefault();
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const cursorVX = view.x + ((e.clientX - rect.left) / rect.width) * view.w;
      const cursorVY = view.y + ((e.clientY - rect.top) / rect.height) * view.h;
      const factor = Math.exp(e.deltaY * 0.0015);
      const nextW = clamp(view.w * factor, 100, 8000);
      const nextH = clamp(view.h * factor, 75, 6000);
      const ratioW = nextW / view.w;
      const ratioH = nextH / view.h;
      viewLockedRef.current = true;
      setView({
        x: cursorVX - (cursorVX - view.x) * ratioW,
        y: cursorVY - (cursorVY - view.y) * ratioH,
        w: nextW,
        h: nextH,
      });
    },
    [view],
  );

  const onPanDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.button !== 0) return;
      // Only start panning on background — node circles call
      // stopPropagation in their own pointerdown.
      panOriginRef.current = { x: e.clientX, y: e.clientY, view };
      setDraggingPan(true);
      viewLockedRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [view],
  );

  const onPanMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const origin = panOriginRef.current;
      if (!origin) return;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const dx = ((e.clientX - origin.x) / rect.width) * origin.view.w;
      const dy = ((e.clientY - origin.y) / rect.height) * origin.view.h;
      setView({
        x: origin.view.x - dx,
        y: origin.view.y - dy,
        w: origin.view.w,
        h: origin.view.h,
      });
    },
    [],
  );

  const onPanUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    panOriginRef.current = null;
    setDraggingPan(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  // Convert a client-coords pointer event to viewBox-coords. Used by
  // node drag handlers to place the dragged node under the cursor.
  const clientToViewBox = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      return {
        x: view.x + ((clientX - rect.left) / rect.width) * view.w,
        y: view.y + ((clientY - rect.top) / rect.height) * view.h,
      };
    },
    [view],
  );

  // Per-node drag implemented with window-level pointermove/up
  // listeners attached on pointerdown. This is the standard pattern:
  //   * Stops the SVG's pan handler from competing (we stopPropagation
  //     on pointerdown so it never bubbles up).
  //   * Drag continues even when the cursor leaves the node, because
  //     window-level listeners see every move.
  //   * Click vs. drag is distinguished by movement distance — if the
  //     pointer never crosses DRAG_THRESHOLD, pointerup fires the
  //     node's `onOpenNote` callback. Otherwise it's a drag and the
  //     click is suppressed.
  const DRAG_THRESHOLD = 3;
  const dragHandlersRef = useRef<{
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
  } | null>(null);

  const detachDragListeners = useCallback(() => {
    const handlers = dragHandlersRef.current;
    if (!handlers) return;
    window.removeEventListener('pointermove', handlers.move);
    window.removeEventListener('pointerup', handlers.up);
    window.removeEventListener('pointercancel', handlers.up);
    dragHandlersRef.current = null;
  }, []);

  const onNodePointerDown = useCallback(
    (e: React.PointerEvent<SVGGElement>, nodeId: string) => {
      if (e.button !== 0) return;
      // Stop propagation so the SVG's pan-down doesn't fire — without
      // this, both handlers run and the pan handler wins because it
      // captures the pointer.
      e.stopPropagation();
      // Clean up any stale listeners from a previous interrupted drag.
      detachDragListeners();
      const start = { id: nodeId, x: e.clientX, y: e.clientY, active: false };
      const move = (ev: PointerEvent) => {
        if (!start.active) {
          const dx = ev.clientX - start.x;
          const dy = ev.clientY - start.y;
          if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
          // Cross threshold → promote to real drag.
          const dragged = nodesRef.current.find((n) => n.id === start.id);
          if (!dragged) return;
          dragged.fixed = true;
          dragNodeIdRef.current = start.id;
          start.active = true;
          loopStarterRef.current();
        }
        const node = nodesRef.current.find((n) => n.id === start.id);
        if (!node) return;
        const pt = clientToViewBox(ev.clientX, ev.clientY);
        if (!pt) return;
        node.x = pt.x;
        node.y = pt.y;
        setTick((n) => n + 1);
      };
      const up = () => {
        detachDragListeners();
        if (start.active) {
          // Real drag — release the pinned node and re-warm the sim.
          const dragged = nodesRef.current.find((n) => n.id === start.id);
          if (dragged) dragged.fixed = false;
          dragNodeIdRef.current = null;
          loopStarterRef.current();
        } else {
          // Pointer barely moved — treat as a click.
          onOpenNote(start.id);
        }
      };
      dragHandlersRef.current = { move, up };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [clientToViewBox, detachDragListeners, onOpenNote],
  );

  // Make sure no global listeners outlive the component (e.g. switching
  // tabs while a drag is in flight).
  useEffect(() => detachDragListeners, [detachDragListeners]);


  const nodes = nodesRef.current;
  const edges = edgesRef.current;
  const nodeIndex = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const resetView = useCallback(() => {
    viewLockedRef.current = false;
    setView(fitView(nodesRef.current, currentSvgAspect()));
  }, [currentSvgAspect]);

  return (
    <aside className="obsidian-graph" aria-label="Граф звʼязків">
      <header className="obsidian-graph__head">
        <span className="obsidian-graph__title">Граф звʼязків</span>
        <div className="obsidian-graph__head-actions">
          <button
            type="button"
            className="obsidian-graph__head-btn"
            title="Скинути зум"
            aria-label="Скинути зум"
            onClick={resetView}
          >
            ⤢
          </button>
        </div>
      </header>
      <div className="obsidian-graph__canvas-wrap">
        <svg
          ref={svgRef}
          className={`obsidian-graph__canvas${draggingPan ? ' is-panning' : ''}`}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          preserveAspectRatio="xMidYMid meet"
          onWheel={onWheel}
          onPointerDown={onPanDown}
          onPointerMove={onPanMove}
          onPointerUp={onPanUp}
          onPointerCancel={onPanUp}
        >
          <g className="obsidian-graph__edges">
            {edges.map((edge, i) => {
              const a = nodeIndex.get(edge.source);
              const b = nodeIndex.get(edge.target);
              if (!a || !b) return null;
              const highlighted =
                hoverId === edge.source || hoverId === edge.target;
              return (
                <line
                  key={i}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className={`obsidian-graph__edge${highlighted ? ' is-highlighted' : ''}`}
                />
              );
            })}
          </g>
          <g className="obsidian-graph__nodes">
            {nodes.map((node) => {
              const r = BASE_RADIUS + node.degree * RADIUS_PER_DEGREE;
              const isHover = node.id === hoverId;
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  className={[
                    'obsidian-graph__node',
                    isHover ? 'is-hover' : '',
                  ].filter(Boolean).join(' ')}
                  onPointerDown={(e) => onNodePointerDown(e, node.id)}
                  onPointerEnter={() => setHoverId(node.id)}
                  onPointerLeave={() =>
                    setHoverId((current) => (current === node.id ? null : current))
                  }
                >
                  {/* Invisible larger circle expands the hit area so
                      the user doesn't have to land exactly on the
                      visible dot. Matches Obsidian's forgiving click
                      target on graph nodes. */}
                  <circle
                    r={r + 6}
                    fill="transparent"
                    style={{ pointerEvents: 'all' }}
                  />
                  <circle r={r} className="obsidian-graph__node-circle" />
                  <text
                    y={r + LABEL_OFFSET}
                    className="obsidian-graph__node-label"
                    textAnchor="middle"
                    dominantBaseline="hanging"
                  >
                    {node.label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
        <div className="obsidian-graph__hint" aria-hidden>
          {graph.nodes.length} нотаток · {graph.edges.length} звʼязків · скрол = зум
        </div>
      </div>
    </aside>
  );
}

function initNodes(input: { id: string; label: string; degree: number }[]): SimNode[] {
  // Distribute initial positions on a circle so the first tick doesn't
  // explode when nodes start co-located (Coulomb force → ∞ at distance 0).
  const radius = Math.max(120, input.length * 20);
  return input.map((node, i) => {
    const angle = (i / Math.max(1, input.length)) * Math.PI * 2;
    return {
      id: node.id,
      label: node.label,
      degree: node.degree,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      fixed: false,
    };
  });
}

// One simulation step. Returns true when the layout is settled (all
// nodes moving below MIN_VELOCITY), so the RAF loop can shut down.
// Fixed nodes still exert forces on others but don't accumulate
// velocity themselves — useful when the user is actively dragging.
function tickSimulation(nodes: SimNode[], edges: SimEdge[]): boolean {
  // 1. Repulsion: every pair of nodes pushes apart inverse-square.
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distSq = Math.max(dx * dx + dy * dy, 1);
      const force = (REPEL_STRENGTH * 100) / distSq;
      const dist = Math.sqrt(distSq);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!a.fixed) { a.vx -= fx; a.vy -= fy; }
      if (!b.fixed) { b.vx += fx; b.vy += fy; }
    }
  }
  // 2. Spring along edges: pull connected nodes toward LINK_DISTANCE.
  const nodeIndex = new Map(nodes.map((n) => [n.id, n]));
  for (const edge of edges) {
    const a = nodeIndex.get(edge.source);
    const b = nodeIndex.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const displacement = dist - LINK_DISTANCE;
    const force = displacement * LINK_STRENGTH * 0.05;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    if (!a.fixed) { a.vx += fx; a.vy += fy; }
    if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
  }
  // 3. Centering: gentle pull toward origin so the cluster stays put.
  for (const n of nodes) {
    if (n.fixed) continue;
    n.vx -= n.x * CENTER_STRENGTH * 0.05;
    n.vy -= n.y * CENTER_STRENGTH * 0.05;
  }
  // 4. Integrate position + friction.
  let maxV = 0;
  for (const n of nodes) {
    if (n.fixed) {
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx *= FRICTION;
    n.vy *= FRICTION;
    n.x += n.vx;
    n.y += n.vy;
    const speed = Math.abs(n.vx) + Math.abs(n.vy);
    if (speed > maxV) maxV = speed;
  }
  return maxV < MIN_VELOCITY;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Compute a viewBox that contains all nodes with ~30% padding AND
// matches the SVG element's aspect ratio. Without aspect-matching, a
// wide cluster + `preserveAspectRatio="meet"` letterboxes the content
// into a thin horizontal sliver — exactly the "everything stretches
// into the distance" bug.
const MIN_VIEW_SPAN = 600;
const DEFAULT_ASPECT = 4 / 3;

function fitView(nodes: SimNode[], svgAspect = DEFAULT_ASPECT): ViewBox {
  if (nodes.length === 0) return INITIAL_VIEW;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  const aspect = svgAspect > 0 ? svgAspect : DEFAULT_ASPECT;
  const paddedW = Math.max((maxX - minX) * 1.3, MIN_VIEW_SPAN);
  const paddedH = Math.max((maxY - minY) * 1.3, MIN_VIEW_SPAN / aspect);
  // Whichever axis would otherwise be letterboxed expands to match the
  // SVG's aspect — this keeps the viewBox proportional to the actual
  // canvas, so nothing ever looks squished or stretched.
  let w: number;
  let h: number;
  if (paddedW / paddedH > aspect) {
    w = paddedW;
    h = w / aspect;
  } else {
    h = paddedH;
    w = h * aspect;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    x: cx - w / 2,
    y: cy - h / 2,
    w,
    h,
  };
}
