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

// Layout parameters tuned to mirror Obsidian's graph view character:
// strong inverse-square repulsion, gentle centering, soft springs along
// edges, AND a collision pass so circles never overlap visually. The
// constants below are intentionally close to Obsidian's app.js defaults
// (centerStrength≈0.5 raw → applied as ×0.05 step factor; repelStrength
// large → broken out into REPEL_K below; linkDistance≈250).
//
// We scale the effective strengths by graph size at simulation time —
// see effectiveParams() — so a 10-node mock vault doesn't drift to the
// horizon while a 200-node real vault doesn't clump into a black hole.
const CENTER_STRENGTH = 0.04;       // gentle pull toward origin
const REPEL_K = 1800;               // numerator of inverse-square force
const LINK_STRENGTH = 0.5;          // 0..1: how rigidly springs pull
const LINK_DISTANCE = 180;          // target resting length for an edge
const COLLISION_PADDING = 6;        // extra space between node circles
const FRICTION = 0.78;              // velocity damping per tick
const MIN_VELOCITY = 0.02;
const MAX_STEPS = 1500;
const INITIAL_SETTLE_STEPS = 250;   // synchronous pre-render iterations

const BASE_RADIUS = 4;
const RADIUS_PER_DEGREE = 1.4;
const LABEL_OFFSET = 4;
const INITIAL_VIEW: ViewBox = { x: -400, y: -300, w: 800, h: 600 };

// Effective parameters depend on graph size. A bigger graph needs
// proportionally stronger repulsion and a weaker centering force, or
// nodes pile up in the middle.
function effectiveParams(nodeCount: number): {
  centerStrength: number;
  repelK: number;
  linkDistance: number;
} {
  const scale = Math.max(1, Math.sqrt(nodeCount / 10));
  return {
    centerStrength: CENTER_STRENGTH / scale,
    repelK: REPEL_K * scale,
    linkDistance: LINK_DISTANCE * (0.85 + 0.25 * Math.log10(nodeCount + 1)),
  };
}

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

  // Track ids that arrived recently (last 4s) so we can pulse them
  // in. Used by D4 to highlight live indexer writes.
  const [recentlyAddedIds, setRecentlyAddedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Merge: preserve positions of nodes we already had, seed new ids
    // near the origin so they animate INTO place via simulation. This
    // keeps the live indexer flow visually calm — only the just-
    // appeared node moves, the existing layout stays put.
    const prevById = new Map(nodesRef.current.map((n) => [n.id, n]));
    const newlyAdded: string[] = [];
    nodesRef.current = graph.nodes.map((node) => {
      const prev = prevById.get(node.id);
      if (prev) {
        return { ...prev, label: node.label, degree: node.degree };
      }
      newlyAdded.push(node.id);
      const angle = Math.random() * Math.PI * 2;
      const r = 30 + Math.random() * 30;
      return {
        id: node.id,
        label: node.label,
        degree: node.degree,
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        vx: 0,
        vy: 0,
        fixed: false,
      };
    });
    edgesRef.current = graph.edges;
    if (newlyAdded.length > 0) {
      setRecentlyAddedIds((prev) => {
        const next = new Set(prev);
        for (const id of newlyAdded) next.add(id);
        return next;
      });
      const ids = newlyAdded.slice();
      window.setTimeout(() => {
        setRecentlyAddedIds((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.delete(id);
          return next;
        });
      }, 4000);
    }
    stepRef.current = 0;

    // Synchronously pre-settle the layout on first mount so users never
    // see the "everything in one ball" frame. Without this the RAF loop
    // at ~30fps needs ~5-10 seconds of visible thrashing for a 50+ node
    // graph to spread out. With it, the first paint already shows a
    // reasonable arrangement and RAF only polishes.
    if (prevById.size === 0 && nodesRef.current.length > 0) {
      for (let i = 0; i < INITIAL_SETTLE_STEPS; i++) {
        if (tickSimulation(nodesRef.current, edgesRef.current)) break;
      }
    }

    // Only auto-fit if the user hasn't interacted with the view yet AND
    // this is the first time we get any nodes (initial layout). On
    // subsequent live refreshes we keep the user's current view stable.
    if (!viewLockedRef.current && prevById.size === 0) {
      setView(fitView(nodesRef.current, currentSvgAspect()));
    }
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
              const r = nodeRadius(node.degree);
              const isHover = node.id === hoverId;
              const isRecent = recentlyAddedIds.has(node.id);
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  className={[
                    'obsidian-graph__node',
                    isHover ? 'is-hover' : '',
                    isRecent ? 'is-recent' : '',
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
  // Sort by degree descending so the highest-degree hubs end up near
  // the center of the seed pattern — they'll attract their satellites
  // outward from there and the layout settles cleanly. Use a Vogel
  // spiral (golden-angle) so the initial arrangement spreads evenly
  // instead of stacking pairs at antipodal points like a plain circle.
  const sorted = input
    .map((n, originalIndex) => ({ n, originalIndex }))
    .sort((a, b) => b.n.degree - a.n.degree);
  const n = sorted.length;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const spacing = Math.max(22, 220 / Math.sqrt(Math.max(n, 1)));
  return sorted
    .map(({ n: node, originalIndex }, i) => {
      const r = spacing * Math.sqrt(i + 0.5);
      const angle = i * goldenAngle;
      return {
        originalIndex,
        node: {
          id: node.id,
          label: node.label,
          degree: node.degree,
          x: Math.cos(angle) * r,
          y: Math.sin(angle) * r,
          vx: 0,
          vy: 0,
          fixed: false,
        } as SimNode,
      };
    })
    // Preserve original input ordering so the rest of the rendering
    // (key indices, hover indices) doesn't reshuffle.
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map((e) => e.node);
}

function nodeRadius(degree: number): number {
  return BASE_RADIUS + degree * RADIUS_PER_DEGREE;
}

// One simulation step. Returns true when the layout is settled (all
// nodes moving below MIN_VELOCITY), so the RAF loop can shut down.
// Fixed nodes still exert forces on others but don't accumulate
// velocity themselves — useful when the user is actively dragging.
function tickSimulation(nodes: SimNode[], edges: SimEdge[]): boolean {
  const { centerStrength, repelK, linkDistance } = effectiveParams(nodes.length);

  // 1. Repulsion: every pair pushes apart inverse-square. Force is
  //    softened by repelK / dist² with a minimum distance clamp so very
  //    close pairs don't explode the integrator. This produces the
  //    "exploded" Obsidian look where unrelated subgraphs drift apart.
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distSq = Math.max(dx * dx + dy * dy, 25);
      const dist = Math.sqrt(distSq);
      const force = repelK / distSq;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!a.fixed) { a.vx -= fx; a.vy -= fy; }
      if (!b.fixed) { b.vx += fx; b.vy += fy; }
    }
  }

  // 2. Springs along edges: pull connected nodes toward linkDistance.
  const nodeIndex = new Map(nodes.map((n) => [n.id, n]));
  for (const edge of edges) {
    const a = nodeIndex.get(edge.source);
    const b = nodeIndex.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const displacement = dist - linkDistance;
    const force = displacement * LINK_STRENGTH * 0.05;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    if (!a.fixed) { a.vx += fx; a.vy += fy; }
    if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
  }

  // 3. Centering: gentle pull toward origin so the cluster stays in
  //    frame. Linear-in-distance instead of inverse-square so distant
  //    outliers come back without yanking the bulk to a single point.
  for (const n of nodes) {
    if (n.fixed) continue;
    n.vx -= n.x * centerStrength * 0.05;
    n.vy -= n.y * centerStrength * 0.05;
  }

  // 4. Collision: hard radius-based push so dots never visually
  //    overlap. This is the missing force that makes Obsidian's graph
  //    look "clean" — without it big hubs and their neighbors stack.
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const minDist = nodeRadius(a.degree) + nodeRadius(b.degree) + COLLISION_PADDING;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distSq = dx * dx + dy * dy;
      if (distSq >= minDist * minDist) continue;
      const dist = Math.sqrt(distSq) || 0.1;
      const overlap = (minDist - dist) * 0.5;
      const nx = dx / dist;
      const ny = dy / dist;
      if (!a.fixed) { a.x -= nx * overlap; a.y -= ny * overlap; }
      if (!b.fixed) { b.x += nx * overlap; b.y += ny * overlap; }
    }
  }

  // 5. Integrate position + friction.
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
