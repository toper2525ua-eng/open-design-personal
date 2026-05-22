// Chat backend for the global Obsidian knowledge base.
//
// Each turn spawns a fresh `claude -p` subprocess with CWD = repo root
// and the WHOLE conversation history fed as the prompt. The agent is
// stateless across turns; we re-supply context every time. This avoids
// long-lived process management at the cost of re-priming context per
// turn — acceptable while conversations stay short and prompt-cache
// hits cover repeated prefixes.
//
// Conservative system prompt: read knowledge base first, fall through
// to source code, only write a note when the answer is long-term
// reusable. The agent uses Claude Code's built-in Read/Grep/Glob/Edit/
// Write tools — no custom MCP tools, the vault is just `.md` files the
// agent can manipulate directly.
//
// Conversation persistence: one JSON file per conversation under
// `.od/obsidian-global/.conversations/`. Kept out-of-band from the
// vault tree (dot-prefixed so the tree-listing filter skips it).

import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { listAllNotes, vaultRoot } from './storage.js';
import { getProgress as getIndexerProgress } from './indexer.js';

const CONVERSATIONS_DIRNAME = '.conversations';
const CLAUDE_BIN = 'claude';
// Claude Code defaults to its `default` model alias — we don't pin one
// so the user gets whichever model is current on their plan (sonnet
// today, opus once they swap).
const MODEL: string | undefined = undefined;

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  // Populated only on assistant messages, once the agent run completes.
  // Lets the UI render a "Готово · 25с · 632 токени" footer matching
  // ProjectView's chat without re-querying any usage endpoint.
  elapsedMs?: number;
  outputTokens?: number;
  inputTokens?: number;
}

export interface ChatConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ChatConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

const SYSTEM_PROMPT = `Ти — асистент бази знань проєкту Open Design.

КОНТЕКСТ:
- Open Design — це fork-репозиторій на Windows; ти знаходишся в його корені.
- База знань живе у \`.od/obsidian-global/\` як markdown-файли з wikilinks \`[[Назва]]\`.
- Реальний код живе у \`apps/\` (web, daemon, desktop), \`packages/\`, \`tools/\`, \`e2e/\`, \`docs/\`.
- Користувач — розробник цього форку; він питатиме тебе про архітектуру, фічі, патерни.

АЛГОРИТМ ВІДПОВІДІ:
1. Спершу ЗАВЖДИ перевір базу знань: Grep / Read у \`.od/obsidian-global/**/*.md\`.
2. Якщо в базі є відповідь — посилайся на конкретну нотатку (\`Downstream/Auto-updater.md\` тощо).
3. Якщо в базі нема або інформація неповна — читай код напряму через Read / Grep / Glob.
4. Відповідай користувачу українською, коротко й по суті.

КОЛИ ПИСАТИ НОТАТКУ У БАЗУ:
- ✅ Якщо ти дізнався щось ДОВГОСТРОКОВЕ: архітектурне рішення, опис нової фічі, прихований bug-fix, патерн розробки.
- ✅ Якщо є кілька related-фактів, що варто згрупувати в одну нотатку.
- ❌ НЕ пиши нотатку для одноразових питань ("де ця функція?" — просто скажи).
- ❌ НЕ пиши нотатку для дрібниць (типу "ця змінна так називається").
- ❌ НЕ створюй дубль наявної нотатки — оновлюй існуючу.

КОЛИ ПИШЕШ:
- Шлях типу \`.od/obsidian-global/<Категорія>/<Назва>.md\`.
- Перший рядок: \`# Назва нотатки\`.
- Лінкуй до інших нотаток через \`[[Шлях/Назва]]\` або просто \`[[Назва]]\` (резолвиться по basename).
- Тільки факти. Без аналізу типу "це круто" чи "варто змінити".

Якщо щось незрозуміло — постав уточнююче питання користувачу замість гадання.`;

function conversationsRoot(): string {
  return path.join(vaultRoot(), CONVERSATIONS_DIRNAME);
}

async function ensureConversationsRoot(): Promise<string> {
  const root = conversationsRoot();
  await mkdir(root, { recursive: true });
  return root;
}

function conversationFile(id: string): string {
  // Reject any non-UUID-shaped id so a malicious caller can't escape
  // the conversations dir via id="../something".
  if (!/^[a-z0-9-]{1,80}$/i.test(id)) {
    throw new Error('invalid conversation id');
  }
  return path.join(conversationsRoot(), `${id}.json`);
}

export async function listConversations(): Promise<ChatConversationSummary[]> {
  await ensureConversationsRoot();
  const entries = await readdir(conversationsRoot());
  const out: ChatConversationSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -'.json'.length);
    try {
      const conv = await readConversation(id);
      if (!conv) continue;
      out.push({
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        messageCount: conv.messages.length,
      });
    } catch {
      // Corrupted file — skip silently rather than break the list.
    }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

export async function readConversation(id: string): Promise<ChatConversation | null> {
  let raw: string;
  try {
    raw = await readFile(conversationFile(id), 'utf-8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as ChatConversation;
  // Defensive shape check — old files might not match the current
  // schema. Bail to null instead of throwing so the UI can recover.
  if (
    typeof parsed.id !== 'string' ||
    !Array.isArray(parsed.messages)
  ) {
    return null;
  }
  return parsed;
}

export async function writeConversation(conv: ChatConversation): Promise<void> {
  await ensureConversationsRoot();
  await writeFile(conversationFile(conv.id), JSON.stringify(conv, null, 2), 'utf-8');
}

export async function createConversation(title: string): Promise<ChatConversation> {
  const now = new Date().toISOString();
  const conv: ChatConversation = {
    id: randomUUID(),
    title: title.trim() || 'Нова розмова',
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  await writeConversation(conv);
  return conv;
}

export async function deleteConversation(id: string): Promise<boolean> {
  try {
    await rm(conversationFile(id));
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return false;
    throw err;
  }
}

export async function appendUserMessage(
  id: string,
  content: string,
): Promise<{ conv: ChatConversation; message: ChatMessage } | null> {
  const conv = await readConversation(id);
  if (!conv) return null;
  const message: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
  };
  conv.messages.push(message);
  conv.updatedAt = message.createdAt;
  // Auto-title from first user message when conversation is still
  // "Нова розмова". Truncate to ~60 chars for the history dropdown.
  if (conv.messages.filter((m) => m.role === 'user').length === 1) {
    const trimmed = content.trim().replace(/\s+/g, ' ');
    if (trimmed.length > 0) {
      conv.title = trimmed.slice(0, 60) + (trimmed.length > 60 ? '…' : '');
    }
  }
  await writeConversation(conv);
  return { conv, message };
}

// Compose the prompt fed to `claude -p`. We dump the system
// instructions + a live snapshot of the knowledge base (TOC summary +
// indexer status), then the conversation history with role markers.
// The snapshot is what lets the agent answer "what do you have on X?"
// without doing a Glob/Grep on every turn.
async function buildKnowledgeSnapshot(): Promise<string> {
  const indexer = getIndexerProgress();
  const notes = await listAllNotes().catch(() => []);
  const byCategory = new Map<string, string[]>();
  for (const note of notes) {
    if (note.path === 'README' || note.path.startsWith('.')) continue;
    const cat = note.path.includes('/') ? (note.path.split('/')[0] ?? 'Корінь') : 'Корінь';
    const arr = byCategory.get(cat) ?? [];
    arr.push(note.title);
    byCategory.set(cat, arr);
  }
  const categoriesSummary = Array.from(byCategory.entries())
    .sort((a, b) => a[0].localeCompare(b[0], 'uk'))
    .map(([cat, titles]) => `- **${cat}** (${titles.length}): ${titles.slice(0, 8).join(', ')}${titles.length > 8 ? '…' : ''}`)
    .join('\n');
  const handled = indexer.completed + indexer.skipped + indexer.failed;
  const coveragePercent = indexer.total > 0 ? Math.round((handled / indexer.total) * 100) : 0;
  const indexerLine = indexer.status === 'idle'
    ? 'Індексер ще не запускався. База — лише seed-нотатки.'
    : `Індексер: **${indexer.status}** · Тіер ${indexer.currentTier}/3 · покриття ${coveragePercent}% (${handled}/${indexer.total})${indexer.currentFile ? ` · поточний файл: \`${indexer.currentFile}\`` : ''}.`;

  return [
    '## Поточний стан бази знань',
    '',
    indexerLine,
    `Всього нотаток у вуйті: ${notes.length}.`,
    '',
    categoriesSummary || '_База ще порожня — крім seed-нотаток._',
    '',
    'ПЕРШИЙ КРОК у відповіді: якщо запитання стосується програми, спершу `Read .od/obsidian-global/README.md` (Master TOC) і потім конкретну нотатку з потрібної категорії. Це швидше за Glob/Grep і дає тобі повну картину.',
  ].join('\n');
}

async function composePromptAsync(conv: ChatConversation): Promise<string> {
  const snapshot = await buildKnowledgeSnapshot();
  const parts: string[] = [SYSTEM_PROMPT.trim(), '', snapshot, ''];
  if (conv.messages.length > 1) {
    parts.push('--- ПОПЕРЕДНЯ РОЗМОВА ---');
    for (const msg of conv.messages.slice(0, -1)) {
      const role = msg.role === 'user' ? 'Користувач' : msg.role === 'assistant' ? 'Асистент' : 'Система';
      parts.push(`${role}: ${msg.content}`);
      parts.push('');
    }
    parts.push('--- /ПОПЕРЕДНЯ РОЗМОВА ---');
    parts.push('');
  }
  const latest = conv.messages[conv.messages.length - 1];
  if (latest && latest.role === 'user') {
    parts.push(`Поточне питання користувача:`);
    parts.push(latest.content);
  }
  return parts.join('\n');
}

export interface ChatStreamEvent {
  kind: 'text-delta' | 'tool-use' | 'tool-result' | 'usage' | 'done' | 'error';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  detail?: string;
  // Populated on 'usage' (interim, possibly multiple) and 'done'
  // (final). The 'done' event carries the totals the UI renders in
  // the assistant-footer.
  elapsedMs?: number;
  outputTokens?: number;
  inputTokens?: number;
}

// Streams the agent's reply for the latest user message. Caller must
// have already appended the user message to the conversation. We:
//   1. Compose the full prompt from history.
//   2. Spawn `claude -p` with stream-json output for live tool/text
//      events, bypassPermissions so it can Read/Write freely.
//   3. Parse JSONL events from stdout and re-emit them as ChatStreamEvent.
//   4. On exit, append the assistant message to the conversation
//      (with elapsedMs + usage) and yield a 'done' event with the
//      saved message id + final stats so the UI can render the
//      "Готово · 25с · 632 токени" footer.
//
// CWD is the repo root so Read/Grep/Edit see both the vault and the
// real source tree.
export async function* streamAssistantReply(
  conv: ChatConversation,
  repoRoot: string,
): AsyncGenerator<ChatStreamEvent, void, undefined> {
  const startedAt = Date.now();
  const prompt = await composePromptAsync(conv);
  const args: string[] = [
    '-p',
    '--input-format', 'text',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
  ];
  if (MODEL) args.push('--model', MODEL);

  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawn(CLAUDE_BIN, args, {
      cwd: repoRoot,
      shell: process.platform === 'win32',
      env: process.env,
    });
  } catch (err) {
    yield { kind: 'error', detail: err instanceof Error ? err.message : String(err) };
    return;
  }

  proc.stdin.write(prompt);
  proc.stdin.end();

  const stdoutQueue: string[] = [];
  let stdoutDone = false;
  let stderrBuf = '';
  let exitCode: number | null = null;
  let resolveWait: (() => void) | null = null;
  const wait = () => new Promise<void>((resolve) => { resolveWait = resolve; });
  const wakeup = () => {
    if (resolveWait) { resolveWait(); resolveWait = null; }
  };

  proc.stdout.setEncoding('utf-8');
  let leftover = '';
  proc.stdout.on('data', (chunk: string) => {
    const combined = leftover + chunk;
    const lines = combined.split(/\r?\n/);
    leftover = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      stdoutQueue.push(line);
    }
    wakeup();
  });
  proc.stdout.on('end', () => { stdoutDone = true; wakeup(); });
  proc.stderr.setEncoding('utf-8');
  proc.stderr.on('data', (chunk: string) => { stderrBuf += chunk; });
  proc.on('exit', (code) => { exitCode = code; stdoutDone = true; wakeup(); });
  proc.on('error', (err) => {
    stderrBuf += `\n${err.message}`;
    stdoutDone = true;
    wakeup();
  });

  let assistantText = '';
  let outputTokens: number | undefined;
  let inputTokens: number | undefined;

  // Pump events. We yield as messages arrive; the daemon HTTP handler
  // turns them into SSE frames for the browser.
  while (true) {
    while (stdoutQueue.length > 0) {
      const line = stdoutQueue.shift();
      if (!line) continue;
      const event = parseClaudeEvent(line);
      if (!event) continue;
      if (event.kind === 'text-delta' && event.text) {
        assistantText += event.text;
      }
      if (event.kind === 'usage') {
        if (typeof event.outputTokens === 'number') outputTokens = event.outputTokens;
        if (typeof event.inputTokens === 'number') inputTokens = event.inputTokens;
        // Don't forward 'usage' events to the UI yet — they're folded
        // into the final 'done' event so the UI gets one footer write.
        continue;
      }
      yield event;
    }
    if (stdoutDone && stdoutQueue.length === 0) break;
    await wait();
  }

  if (exitCode !== 0 && exitCode !== null) {
    yield {
      kind: 'error',
      detail: `claude exited with code ${exitCode}: ${stderrBuf.slice(0, 400)}`,
    };
  }

  // Persist the assistant message even if it's empty — the UI still
  // wants the placeholder so the user sees "(порожня відповідь)".
  const finishedAt = Date.now();
  const assistantMsg: ChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: assistantText,
    createdAt: new Date(finishedAt).toISOString(),
    elapsedMs: finishedAt - startedAt,
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(inputTokens != null ? { inputTokens } : {}),
  };
  conv.messages.push(assistantMsg);
  conv.updatedAt = assistantMsg.createdAt;
  await writeConversation(conv);

  const doneEvent: ChatStreamEvent = {
    kind: 'done',
    detail: assistantMsg.id,
  };
  if (assistantMsg.elapsedMs != null) doneEvent.elapsedMs = assistantMsg.elapsedMs;
  if (outputTokens != null) doneEvent.outputTokens = outputTokens;
  if (inputTokens != null) doneEvent.inputTokens = inputTokens;
  yield doneEvent;
}

// Parse one JSONL line from claude-code's stream-json output. We map
// the most useful event types to our slim ChatStreamEvent shape. The
// full claude-code event vocabulary is large; we ignore anything we
// don't recognise so future schema additions don't break us.
function parseClaudeEvent(line: string): ChatStreamEvent | null {
  let evt: unknown;
  try {
    evt = JSON.parse(line);
  } catch {
    return null;
  }
  if (evt === null || typeof evt !== 'object') return null;
  const e = evt as Record<string, unknown>;
  const type = typeof e.type === 'string' ? e.type : null;
  // Assistant text deltas. claude-code emits them as:
  //   { type: 'assistant', message: { content: [{ type: 'text', text: '...' }] } }
  // ... or as partial-message events when --include-partial-messages
  // is set. We accept both shapes.
  if (type === 'assistant' || type === 'assistant_message') {
    const content = extractAssistantContent(e);
    if (content !== null) return { kind: 'text-delta', text: content };
  }
  if (type === 'message_delta' || type === 'content_block_delta') {
    const delta = (e.delta ?? {}) as Record<string, unknown>;
    if (typeof delta.text === 'string') return { kind: 'text-delta', text: delta.text };
  }
  if (type === 'tool_use' || type === 'tool-use') {
    const name = typeof e.name === 'string' ? e.name : 'tool';
    return { kind: 'tool-use', toolName: name, toolInput: e.input };
  }
  if (type === 'tool_result' || type === 'tool-result') {
    return { kind: 'tool-result', toolResult: e.content };
  }
  // Claude Code's final result event: `{ type: 'result', usage: { input_tokens, output_tokens, ... } }`.
  // We also accept the per-message_delta usage shape claude-stream-json
  // emits during streaming for cumulative counts.
  if (type === 'result' || type === 'message_stop' || type === 'message_delta') {
    const usage = extractUsage(e);
    if (usage) {
      return {
        kind: 'usage',
        ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
        ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
      };
    }
  }
  return null;
}

function extractUsage(evt: Record<string, unknown>): { outputTokens?: number; inputTokens?: number } | null {
  const candidate = (evt.usage ?? (evt.message as Record<string, unknown> | undefined)?.usage) as
    | Record<string, unknown>
    | undefined;
  if (!candidate) return null;
  const out: { outputTokens?: number; inputTokens?: number } = {};
  const ot = candidate.output_tokens ?? candidate.outputTokens;
  const it = candidate.input_tokens ?? candidate.inputTokens;
  if (typeof ot === 'number') out.outputTokens = ot;
  if (typeof it === 'number') out.inputTokens = it;
  return Object.keys(out).length > 0 ? out : null;
}

function extractAssistantContent(evt: Record<string, unknown>): string | null {
  const msg = evt.message as Record<string, unknown> | undefined;
  if (!msg) return null;
  const content = msg.content;
  if (!Array.isArray(content)) return null;
  const chunks: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') chunks.push(b.text);
    }
  }
  if (chunks.length === 0) return null;
  return chunks.join('');
}
