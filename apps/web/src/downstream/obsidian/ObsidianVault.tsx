// Vault content — file tree on the left, note body on the right. The
// outer tab strip, view-mode pills and toolbar live in
// `ObsidianWorkspace.tsx`; this component just renders the tree + body
// for the active note in the requested mode (preview / source / edit).
//
// Phase A renders mock data; Phase B will swap in a daemon-backed
// `.od/obsidian-global/` filesystem and turn the textarea into a real
// editor with save semantics.

import { useState, type ReactNode } from 'react';

import { Icon } from '../../components/Icon';
import {
  MOCK_NOTES,
  MOCK_TREE,
  resolveWikilink,
  type ObsidianNote,
  type ObsidianTreeNode,
} from './mock-data';

export type ObsidianViewMode = 'preview' | 'source' | 'edit';

interface Props {
  activePath: string;
  onSelectTreeNode: (path: string) => void;
  onOpenWikilink: (path: string) => void;
  mode: ObsidianViewMode;
}

export function ObsidianVault({
  activePath,
  onSelectTreeNode,
  onOpenWikilink,
  mode,
}: Props) {
  return (
    <div className="obsidian-vault" aria-label="Сховище нотаток">
      <aside className="obsidian-tree" aria-label="Дерево файлів">
        <div className="obsidian-tree__head">
          <span className="obsidian-tree__title">Vault</span>
          <button
            type="button"
            className="obsidian-chat__head-btn"
            title="Нова нотатка (буде у Фазі B)"
            aria-label="Нова нотатка"
            disabled
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        <div className="obsidian-tree__list">
          {MOCK_TREE.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              activePath={activePath}
              onSelect={onSelectTreeNode}
              depth={0}
            />
          ))}
        </div>
      </aside>
      <ObsidianNoteBody path={activePath} mode={mode} onOpenWikilink={onOpenWikilink} />
    </div>
  );
}

// Single-note body — used both inside `.obsidian-vault` (next to the
// tree) and as the standalone content of a per-note workspace tab.
interface ObsidianNoteBodyProps {
  path: string;
  mode: ObsidianViewMode;
  onOpenWikilink: (path: string) => void;
}

export function ObsidianNoteBody({ path, mode, onOpenWikilink }: ObsidianNoteBodyProps) {
  const note: ObsidianNote | null = MOCK_NOTES[path] ?? null;
  return (
    <main className="obsidian-content">
      <div className="obsidian-content__scroll">
        {note ? renderNoteBody(note, mode, onOpenWikilink) : (
          <article className="obsidian-content__body">
            <p>Нотатка не знайдена.</p>
          </article>
        )}
      </div>
    </main>
  );
}

function renderNoteBody(
  note: ObsidianNote,
  mode: ObsidianViewMode,
  onNavigate: (path: string) => void,
): ReactNode {
  if (mode === 'source') {
    return (
      <pre className="obsidian-content__source">
        <code>{note.content}</code>
      </pre>
    );
  }
  if (mode === 'edit') {
    return (
      <div className="obsidian-content__edit">
        <textarea
          className="obsidian-content__editor"
          value={note.content}
          readOnly
          aria-label="Редактор (буде доступний у Фазі B)"
        />
        <div className="obsidian-content__edit-hint">
          Редагування буде доступне у Фазі B (поки лише прев'ю).
        </div>
      </div>
    );
  }
  return (
    <article className="obsidian-content__body">
      {renderMarkdown(note.content, onNavigate)}
      <div className="obsidian-content__meta">
        <span>Оновлено: {formatDate(note.updatedAt)}</span>
        <span>Шлях: {note.path}.md</span>
      </div>
    </article>
  );
}

interface TreeNodeProps {
  node: ObsidianTreeNode;
  activePath: string;
  onSelect: (path: string) => void;
  depth: number;
}

function TreeNode({ node, activePath, onSelect, depth }: TreeNodeProps) {
  // Folders default to expanded in Phase A. Once the vault gets bigger
  // we'll persist expansion state per-folder.
  const [expanded, setExpanded] = useState(true);

  if (node.kind === 'note') {
    return (
      <div className="obsidian-tree__node">
        <button
          type="button"
          className={`obsidian-tree__row${activePath === node.path ? ' is-active' : ''}`}
          onClick={() => onSelect(node.path)}
          style={{ paddingInlineStart: 8 + depth * 12 }}
        >
          <span className="obsidian-tree__row-glyph">
            <Icon name="file" size={13} />
          </span>
          <span className="obsidian-tree__row-label">{node.name}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="obsidian-tree__node">
      <button
        type="button"
        className="obsidian-tree__row"
        onClick={() => setExpanded((v) => !v)}
        style={{ paddingInlineStart: 8 + depth * 12 }}
      >
        <span className="obsidian-tree__row-glyph">
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} />
        </span>
        <span className="obsidian-tree__row-glyph">
          <Icon name="folder" size={13} />
        </span>
        <span className="obsidian-tree__row-label">{node.name}</span>
      </button>
      {expanded ? (
        <div className="obsidian-tree__children">
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              activePath={activePath}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('uk-UA', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// Minimal markdown renderer: enough to make mock notes look right.
// Replace with a proper renderer in Phase B once we ship real content.
function renderMarkdown(source: string, onNavigate: (path: string) => void): ReactNode {
  const blocks = splitBlocks(source);
  return blocks.map((block, i) => renderBlock(block, i, onNavigate));
}

interface Block {
  kind: 'heading' | 'paragraph' | 'list' | 'code';
  level?: number;
  text: string;
  items?: string[];
}

function splitBlocks(source: string): Block[] {
  const lines = source.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      // Fenced code block — collect until closing fence.
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? '';
        if (next.startsWith('```')) break;
        codeLines.push(next);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ kind: 'code', text: codeLines.join('\n') });
      continue;
    }
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch && headingMatch[1] && headingMatch[2] !== undefined) {
      blocks.push({
        kind: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2],
      });
      i++;
      continue;
    }
    if (line.match(/^[-*]\s+/)) {
      const items: string[] = [];
      while (i < lines.length) {
        const next = lines[i] ?? '';
        if (!next.match(/^[-*]\s+/)) break;
        items.push(next.replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'list', text: '', items });
      continue;
    }
    // Paragraph — collect contiguous non-empty, non-block lines.
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i] ?? '';
      if (!next.trim()) break;
      if (next.startsWith('#') || next.startsWith('```') || next.match(/^[-*]\s+/)) break;
      paraLines.push(next);
      i++;
    }
    blocks.push({ kind: 'paragraph', text: paraLines.join(' ') });
  }
  return blocks;
}

function renderBlock(
  block: Block,
  key: number,
  onNavigate: (path: string) => void,
): ReactNode {
  if (block.kind === 'code') {
    return (
      <pre key={key}>
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.kind === 'heading') {
    const text = renderInline(block.text, onNavigate, `h-${key}`);
    if (block.level === 1) return <h1 key={key}>{text}</h1>;
    if (block.level === 2) return <h2 key={key}>{text}</h2>;
    return <h3 key={key}>{text}</h3>;
  }
  if (block.kind === 'list') {
    return (
      <ul key={key}>
        {(block.items ?? []).map((item, j) => (
          <li key={j}>{renderInline(item, onNavigate, `li-${key}-${j}`)}</li>
        ))}
      </ul>
    );
  }
  return <p key={key}>{renderInline(block.text, onNavigate, `p-${key}`)}</p>;
}

// Inline pass: handle [[wikilink]] and `code` spans. Order matters —
// process wikilinks first so they can wrap text containing backticks if
// future notes ever need that.
function renderInline(
  source: string,
  onNavigate: (path: string) => void,
  keyPrefix: string,
): ReactNode {
  const out: ReactNode[] = [];
  let cursor = 0;
  // Combined regex: [[name]] or `code`.
  const re = /\[\[([^\]]+)\]\]|`([^`]+)`/g;
  let match: RegExpExecArray | null;
  let chunkIdx = 0;
  while ((match = re.exec(source)) !== null) {
    if (match.index > cursor) {
      out.push(source.slice(cursor, match.index));
    }
    if (match[1] !== undefined) {
      const name = match[1];
      const resolved = resolveWikilink(name);
      out.push(
        <a
          key={`${keyPrefix}-w-${chunkIdx}`}
          className={`obsidian-wikilink${resolved ? '' : ' is-broken'}`}
          onClick={(e) => {
            e.preventDefault();
            if (resolved) onNavigate(resolved);
          }}
          title={resolved ?? 'Нотатка не знайдена'}
          href="#"
        >
          {name}
        </a>,
      );
    } else if (match[2] !== undefined) {
      out.push(<code key={`${keyPrefix}-c-${chunkIdx}`}>{match[2]}</code>);
    }
    cursor = match.index + match[0].length;
    chunkIdx++;
  }
  if (cursor < source.length) out.push(source.slice(cursor));
  return out;
}
