import type { Express, Request, Response } from 'express';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TgWebConfig {
  repoPath: string;
  designPath: string;
  miniAppUrl: string;
  botToken: string;
  // SHA-256 hex of the sourceHtml that was successfully deployed. Used by
  // the chrome-bar quick-deploy badge to detect "dirty" — the design file
  // changed since the last green push. Set ONLY in the deploy 'close'
  // handler when exitCode === 0, so a failed/canceled deploy doesn't
  // falsely mark the file as up-to-date.
  lastDeployedHash?: string;
  lastDeployedAt?: number;
}

// Single JSON object keyed by `${projectId}::${fileName}`. Lives in
// `.od/tg-web/configs.json` relative to the daemon's cwd (which tools-dev
// pins to the workspace root). localStorage was the original storage but
// it's origin-bound and Electron-dev binds to an ephemeral port that
// changes on every restart, so the localStorage origin changes and the
// saved config "disappears" from the user's perspective on each restart.
const CONFIGS_FILENAME = path.join('.od', 'tg-web', 'configs.json');

function configKey(projectId: string, fileName: string): string {
  return `${projectId}::${fileName}`;
}

function configsAbsPath(): string {
  return path.resolve(process.cwd(), CONFIGS_FILENAME);
}

function readAllConfigs(): Record<string, TgWebConfig> {
  const fullPath = configsAbsPath();
  if (!existsSync(fullPath)) return {};
  try {
    const raw = readFileSync(fullPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, TgWebConfig> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Partial<TgWebConfig>;
      result[key] = {
        repoPath: typeof v.repoPath === 'string' ? v.repoPath : '',
        designPath: typeof v.designPath === 'string' ? v.designPath : 'webapp/index.html',
        miniAppUrl: typeof v.miniAppUrl === 'string' ? v.miniAppUrl : '',
        botToken: typeof v.botToken === 'string' ? v.botToken : '',
        ...(typeof v.lastDeployedHash === 'string' ? { lastDeployedHash: v.lastDeployedHash } : {}),
        ...(typeof v.lastDeployedAt === 'number' ? { lastDeployedAt: v.lastDeployedAt } : {}),
      };
    }
    return result;
  } catch {
    return {};
  }
}

function writeAllConfigs(configs: Record<string, TgWebConfig>): void {
  const fullPath = configsAbsPath();
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(configs, null, 2), 'utf-8');
}

export type TgWebDeployStatus = 'running' | 'success' | 'failed';

export interface TgWebDeployRecord {
  id: string;
  projectId: string;
  fileName: string;
  repoPath: string;
  designPath: string;
  startedAt: number;
  endedAt: number | null;
  status: TgWebDeployStatus;
  exitCode: number | null;
  logTail: string;
  child: ChildProcessWithoutNullStreams | null;
}

const MAX_LOG_BYTES = 16 * 1024;
const MAX_HISTORY_PER_PROJECT_FILE = 20;

function trimLogTail(buf: string): string {
  if (buf.length <= MAX_LOG_BYTES) return buf;
  return buf.slice(buf.length - MAX_LOG_BYTES);
}

function isSafeRelativeDesignPath(designPath: string): boolean {
  if (!designPath || designPath.length === 0) return false;
  if (path.isAbsolute(designPath)) return false;
  const normalized = path.normalize(designPath).replace(/\\/g, '/');
  if (normalized.startsWith('..') || normalized.includes('/../')) return false;
  if (normalized === '.' || normalized === '/') return false;
  return true;
}

function buildDeployPrompt(designPath: string, userMessage: string | null): string {
  const ts = new Date().toISOString();
  // Sanitize user-supplied commit subject: single line, max 100 chars,
  // strip backticks and quotes to keep the shell-quoted -m argument safe.
  const cleanedNote = userMessage
    ? userMessage.replace(/[`"\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
    : '';
  const subject = cleanedNote
    ? `design: ${cleanedNote} (Open Design ${ts})`
    : `design: update from Open Design — ${ts}`;
  return [
    `The file ${designPath} has been updated locally by Open Design and you need to push it to git.`,
    ``,
    `STRICT RULES:`,
    `- Only touch ${designPath}. Never \`git add .\` or \`git add -A\`. Use \`git add -- "${designPath}"\` explicitly.`,
    `- Never edit any file. Your only tool is Bash for git commands.`,
    `- If anything looks wrong (detached HEAD, dirty unrelated files, missing remote, auth prompt), STOP and report — do not try to "fix" it.`,
    ``,
    `STEPS:`,
    `1. \`git rev-parse --abbrev-ref HEAD\` — capture current branch name.`,
    `2. \`git status --short\` — verify ${designPath} appears modified.`,
    `3. \`git add -- "${designPath}"\``,
    `4. \`git commit -m "${subject}"\``,
    `5. \`git push origin <branch-from-step-1>\``,
    `6. If push rejected (non-fast-forward): \`git pull --rebase --strategy-option=ours origin <branch>\` then \`git push origin <branch>\` again.`,
    ``,
    `Report the resulting commit hash from \`git rev-parse HEAD\` and the final push output. Do not modify anything else.`,
  ].join('\n');
}

function openInFileManager(initial: string | null): { ok: true } | { error: string } {
  // Opens the user's OS file manager at the given start directory. Native
  // folder-picker dialogs (PowerShell FolderBrowserDialog, Shell.Application,
  // osascript "choose folder") refuse to surface a window when the daemon
  // runs in a non-interactive Windows session (session 0 isolation), which is
  // what happens when tools-dev is spawned from a service-like context. The
  // file manager itself is special-cased by every desktop OS to always open
  // in the user's interactive session, so it is the most reliable path. The
  // user copies the path from the address bar and pastes it into the field.
  const platform = os.platform();
  const startDir = initial && existsSync(initial) ? initial : os.homedir();
  try {
    if (platform === 'win32') {
      // start "" "<path>" via cmd because direct spawn of explorer.exe with
      // a path arg sometimes drops the arg when interpreted by the shell.
      // detached + unref so the daemon doesn't keep a handle on explorer.
      const child = spawn('cmd.exe', ['/c', 'start', '', '/d', startDir, 'explorer.exe', '.'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } else if (platform === 'darwin') {
      const child = spawn('open', [startDir], { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      const child = spawn('xdg-open', [startDir], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerTgWebRoutes(app: Express): void {
  const deploys = new Map<string, TgWebDeployRecord>();
  // Per-file lock: blocks a second concurrent deploy for the same design
  // file. Key is `${projectId}::${fileName}`. Value is the running deployId.
  // Released in the child 'close' handler.
  const activeByKey = new Map<string, string>();

  app.get('/api/tg-web/config', (req: Request, res: Response) => {
    const projectId = String(req.query.projectId ?? '');
    const fileName = String(req.query.fileName ?? '');
    if (!projectId || !fileName) {
      return res.status(400).json({ error: 'projectId and fileName query params are required' });
    }
    const configs = readAllConfigs();
    const config = configs[configKey(projectId, fileName)] ?? null;
    res.json({ config });
  });

  app.put('/api/tg-web/config', (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    const fileName = typeof body.fileName === 'string' ? body.fileName : '';
    const config = body.config as Partial<TgWebConfig> | undefined;
    if (!projectId || !fileName) {
      return res.status(400).json({ error: 'projectId and fileName are required' });
    }
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'config object is required' });
    }
    const sanitized: TgWebConfig = {
      repoPath: typeof config.repoPath === 'string' ? config.repoPath.trim() : '',
      designPath: typeof config.designPath === 'string' ? config.designPath.trim() : 'webapp/index.html',
      miniAppUrl: typeof config.miniAppUrl === 'string' ? config.miniAppUrl.trim() : '',
      botToken: typeof config.botToken === 'string' ? config.botToken.trim() : '',
    };
    try {
      const all = readAllConfigs();
      all[configKey(projectId, fileName)] = sanitized;
      writeAllConfigs(all);
      res.json({ ok: true, config: sanitized });
    } catch (err) {
      res.status(500).json({
        error: `failed to save config: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.post('/api/tg-web/open-explorer', (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const initial = typeof body.initial === 'string' && body.initial.trim() ? body.initial.trim() : null;
    const result = openInFileManager(initial);
    if ('error' in result) {
      return res.status(500).json({ error: result.error });
    }
    return res.json({ ok: true });
  });

  app.post('/api/tg-web/deploy', (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    const fileName = typeof body.fileName === 'string' ? body.fileName : '';
    const repoPath = typeof body.repoPath === 'string' ? body.repoPath.trim() : '';
    const designPath = typeof body.designPath === 'string' ? body.designPath.trim() : '';
    const sourceHtml = typeof body.sourceHtml === 'string' ? body.sourceHtml : '';
    const commitMessage =
      typeof body.commitMessage === 'string' && body.commitMessage.trim().length > 0
        ? body.commitMessage.trim()
        : null;

    if (!projectId || !fileName) {
      return res.status(400).json({ error: 'projectId and fileName are required' });
    }
    const lockKey = `${projectId}::${fileName}`;
    const existingDeployId = activeByKey.get(lockKey);
    if (existingDeployId) {
      return res.status(409).json({
        error: 'A deploy is already running for this file',
        activeDeployId: existingDeployId,
      });
    }
    if (!repoPath || !path.isAbsolute(repoPath)) {
      return res.status(400).json({ error: 'repoPath must be an absolute path' });
    }
    if (!isSafeRelativeDesignPath(designPath)) {
      return res.status(400).json({ error: 'designPath must be a safe relative path inside the repo' });
    }
    let repoStat;
    try {
      repoStat = statSync(repoPath);
    } catch {
      return res.status(400).json({ error: `repoPath does not exist: ${repoPath}` });
    }
    if (!repoStat.isDirectory()) {
      return res.status(400).json({ error: `repoPath is not a directory: ${repoPath}` });
    }

    const targetPath = path.resolve(repoPath, designPath);
    const repoPathResolved = path.resolve(repoPath);
    if (!targetPath.startsWith(repoPathResolved + path.sep) && targetPath !== repoPathResolved) {
      return res.status(400).json({ error: 'designPath escapes the repo root' });
    }

    try {
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, sourceHtml, 'utf-8');
    } catch (err) {
      return res.status(500).json({
        error: `failed to write design file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const id = randomUUID();
    const record: TgWebDeployRecord = {
      id,
      projectId,
      fileName,
      repoPath: repoPathResolved,
      designPath,
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
      exitCode: null,
      logTail: '',
      child: null,
    };
    deploys.set(id, record);
    activeByKey.set(lockKey, id);

    const prompt = buildDeployPrompt(designPath, commitMessage);
    let child: ChildProcessWithoutNullStreams;
    try {
      // --dangerously-skip-permissions: headless claude can't prompt for tool
      // approval, so without this every `git status` call hangs forever
      // waiting on a permission dialog that will never appear. The user
      // explicitly triggered this from inside their own design file, the
      // target dir is their own bot repo, and the prompt strictly bounds
      // claude to git commands on a single file — the bypass scope is the
      // user's own deploy intent.
      // --allowedTools is layered as belt-and-suspenders: even if the flag
      // above changes meaning in a future claude release, only git Bash
      // commands and basic shell introspection can run.
      // shell:true so we get .cmd resolution on Windows (claude is installed
      // as a npm shim claude.cmd, not a .exe).
      child = spawn(
        'claude',
        [
          '-p',
          '--dangerously-skip-permissions',
          '--allowedTools', 'Bash(git *) Bash(pwd) Bash(echo *)',
          prompt,
        ],
        {
          cwd: repoPathResolved,
          env: { ...process.env },
          shell: true,
        },
      ) as ChildProcessWithoutNullStreams;
    } catch (err) {
      record.status = 'failed';
      record.endedAt = Date.now();
      record.exitCode = -1;
      record.logTail = `failed to spawn claude: ${err instanceof Error ? err.message : String(err)}`;
      return res.status(500).json({ error: record.logTail, deployId: id });
    }
    record.child = child;

    const appendLog = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      record.logTail = trimLogTail(record.logTail + text);
    };
    child.stdout?.on('data', appendLog);
    child.stderr?.on('data', appendLog);
    child.on('error', (err) => {
      record.status = 'failed';
      record.endedAt = Date.now();
      record.exitCode = -1;
      appendLog(`\n[spawn error] ${err.message}`);
      // 'close' may not fire after 'error' (e.g. ENOENT — the binary never
      // launched), so release the lock here too. Map.delete is idempotent
      // so the 'close' handler below redundantly clearing it is harmless.
      activeByKey.delete(lockKey);
    });
    child.on('close', (code) => {
      record.endedAt = Date.now();
      record.exitCode = code;
      record.status = code === 0 ? 'success' : 'failed';
      record.child = null;
      activeByKey.delete(lockKey);
      // Stamp the successfully deployed source hash into the persisted
      // config so the chrome-bar quick-deploy badge can tell the user
      // "you've changed the design since the last green push". Read-modify-
      // write the configs file; if the user manually edited or deleted the
      // config concurrently we just no-op rather than resurrecting it.
      if (code === 0) {
        try {
          const all = readAllConfigs();
          const existing = all[lockKey];
          if (existing) {
            const hash = createHash('sha256').update(sourceHtml, 'utf-8').digest('hex');
            all[lockKey] = {
              ...existing,
              lastDeployedHash: hash,
              lastDeployedAt: Date.now(),
            };
            writeAllConfigs(all);
          }
        } catch {
          // best-effort — badge will just stay "dirty" until next deploy
        }
      }
      pruneHistory(deploys, record.projectId, record.fileName);
    });

    res.json({ deployId: id });
  });

  app.get('/api/tg-web/deploy/:deployId', (req: Request, res: Response) => {
    const deployId = req.params.deployId ?? '';
    const rec = deploys.get(deployId);
    if (!rec) {
      return res.status(404).json({ error: 'unknown deployId' });
    }
    res.json({
      deployId: rec.id,
      projectId: rec.projectId,
      fileName: rec.fileName,
      status: rec.status,
      exitCode: rec.exitCode,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      logTail: rec.logTail,
    });
  });

  app.get('/api/tg-web/deploys', (req: Request, res: Response) => {
    const projectId = String(req.query.projectId ?? '');
    const fileName = String(req.query.fileName ?? '');
    if (!projectId || !fileName) {
      return res.status(400).json({ error: 'projectId and fileName query params are required' });
    }
    const matched = [...deploys.values()]
      .filter((r) => r.projectId === projectId && r.fileName === fileName)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 10)
      .map((r) => ({
        deployId: r.id,
        status: r.status,
        exitCode: r.exitCode,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      }));
    res.json({ deploys: matched });
  });

  app.post('/api/tg-web/deploy/:deployId/cancel', (req: Request, res: Response) => {
    const deployId = req.params.deployId ?? '';
    const rec = deploys.get(deployId);
    if (!rec) {
      return res.status(404).json({ error: 'unknown deployId' });
    }
    if (rec.child && !rec.child.killed && rec.status === 'running') {
      try {
        rec.child.kill();
      } catch {
        // ignore — child may have already exited between check and kill
      }
    }
    res.json({ ok: true });
  });
}

function pruneHistory(
  deploys: Map<string, TgWebDeployRecord>,
  projectId: string,
  fileName: string,
): void {
  const matching = [...deploys.values()]
    .filter((r) => r.projectId === projectId && r.fileName === fileName)
    .sort((a, b) => b.startedAt - a.startedAt);
  for (const r of matching.slice(MAX_HISTORY_PER_PROJECT_FILE)) {
    if (r.status !== 'running') deploys.delete(r.id);
  }
}
