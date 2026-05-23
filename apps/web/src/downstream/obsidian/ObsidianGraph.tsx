// Force-directed 3D graph view of the vault. Each note is a node;
// each resolved wikilink is an undirected edge. Rendered through
// `react-force-graph-3d` — the Three.js + d3-force-3d stack from
// vasturiano/react-force-graph — configured to match the canonical
// `example/large-graph` showcase verbatim: only graphData,
// nodeLabel, nodeAutoColorBy, linkDirectionalParticles. No custom
// colors, no custom forces, no link styling — the library's defaults
// are the look.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-3d';

import type { ObsidianGraphPayload } from './api';

interface Props {
  graph: ObsidianGraphPayload;
  onOpenNote: (path: string) => void;
}

type GraphNode = NodeObject<{
  id: string;
  label: string;
  degree: number;
  folder: string;
}>;

type GraphLink = LinkObject<GraphNode, { source: string | GraphNode; target: string | GraphNode }>;

function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '(root)' : path.slice(0, i);
}

export function ObsidianGraph({ graph, onOpenNote }: Props) {
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Preserve node objects across renders so the simulation doesn't
  // reset positions every time the parent re-fetches the graph.
  const nodesRef = useRef<Map<string, GraphNode>>(new Map());

  const data = useMemo<{ nodes: GraphNode[]; links: GraphLink[] }>(() => {
    const map = nodesRef.current;
    const nextIds = new Set<string>();
    const nodes: GraphNode[] = graph.nodes.map((n) => {
      nextIds.add(n.id);
      const existing = map.get(n.id);
      const folder = folderOf(n.id);
      if (existing) {
        existing.label = n.label;
        existing.degree = n.degree;
        existing.folder = folder;
        return existing;
      }
      const node: GraphNode = {
        id: n.id,
        label: n.label,
        degree: n.degree,
        folder,
      };
      map.set(n.id, node);
      return node;
    });
    for (const id of Array.from(map.keys())) {
      if (!nextIds.has(id)) map.delete(id);
    }
    const links: GraphLink[] = graph.edges.map((e) => ({
      source: e.source,
      target: e.target,
    }));
    return { nodes, links };
  }, [graph]);

  // ResizeObserver feeds explicit width/height to ForceGraph3D so the
  // WebGL canvas matches the container.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setSize({
        w: Math.max(1, Math.floor(rect.width)),
        h: Math.max(1, Math.floor(rect.height)),
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const resetView = useCallback(() => {
    fgRef.current?.zoomToFit(700, 80);
  }, []);

  const onNodeClick = useCallback(
    (node: NodeObject<GraphNode>) => {
      if (typeof node.id === 'string') onOpenNote(node.id);
    },
    [onOpenNote],
  );

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
      <div className="obsidian-graph__canvas-wrap" ref={containerRef}>
        {size.w > 0 && size.h > 0 ? (
          <ForceGraph3D<GraphNode, GraphLink>
            ref={fgRef as React.MutableRefObject<ForceGraphMethods<GraphNode, GraphLink> | undefined>}
            graphData={data}
            width={size.w}
            height={size.h}
            nodeLabel={(n) => n.label ?? ''}
            nodeAutoColorBy="folder"
            linkDirectionalParticles={1}
            onNodeClick={onNodeClick}
          />
        ) : null}
        <div className="obsidian-graph__hint" aria-hidden>
          {graph.nodes.length} нотаток · {graph.edges.length} звʼязків · drag = обертати · скрол = зум
        </div>
      </div>
    </aside>
  );
}
