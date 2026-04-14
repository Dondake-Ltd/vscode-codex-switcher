import * as fscore from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import * as readline from 'readline';

export type UsageWindow = {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: string;
};

export type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type UsageSnapshot = {
  recordedAt: string;
  sourceFile: string;
  planType?: string;
  limitId?: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
  totalUsage?: TokenUsage;
  lastUsage?: TokenUsage;
};

type SessionEntry = {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    rate_limits?: {
      primary?: RawUsageWindow;
      secondary?: RawUsageWindow;
      limit_id?: string;
      plan_type?: string;
    };
    info?: {
      total_token_usage?: RawTokenUsage;
      last_token_usage?: RawTokenUsage;
    };
  };
};

type RawUsageWindow = {
  used_percent?: number;
  usedPercent?: number;
  window_minutes?: number;
  windowDurationMins?: number;
  resets_at?: number;
  resetsAt?: number;
};

type RawTokenUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
};

type CandidateFile = {
  filePath: string;
  mtimeMs: number;
};

type SessionTailState = {
  sessionsPath: string;
  filePath: string;
  size: number;
  snapshot?: UsageSnapshot;
};

type AppServerRateLimitWindow = {
  usedPercent?: number;
  used_percent?: number;
  windowDurationMins?: number;
  window_minutes?: number;
  resetsAt?: number | null;
  resets_at?: number | null;
};

type AppServerRateLimitSnapshot = {
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  primary?: AppServerRateLimitWindow | null;
  secondary?: AppServerRateLimitWindow | null;
};

type AppServerRateLimitsResult = {
  rateLimits?: AppServerRateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, AppServerRateLimitSnapshot> | null;
};

const MAX_CANDIDATE_FILES = 40;
const APP_SERVER_TIMEOUT_MS = 4000;
const APP_SERVER_INIT_REQUEST_ID = 1;
const APP_SERVER_RATE_LIMITS_REQUEST_ID = 2;
const RECENT_SESSION_WINDOW_MS = 60 * 60 * 1000;

let sessionTailState: SessionTailState | undefined;

export function getSessionsPath(codexHome: string): string {
  return path.join(codexHome, 'sessions');
}

export async function readCurrentUsageSnapshot(codexHome: string): Promise<UsageSnapshot | undefined> {
  const liveSnapshot = await readUsageSnapshotFromAppServer();
  if (liveSnapshot) {
    return liveSnapshot;
  }

  return readLatestUsageSnapshot(codexHome);
}

export async function readLatestUsageSnapshot(codexHome: string): Promise<UsageSnapshot | undefined> {
  const sessionsPath = getSessionsPath(codexHome);
  const tailedSnapshot = await readLatestSnapshotFromTailState(sessionsPath);
  if (tailedSnapshot) {
    return tailedSnapshot;
  }

  const candidates = await collectCandidateFiles(sessionsPath);

  for (const candidate of candidates) {
    const snapshot = await readLatestSnapshotFromFile(candidate.filePath);
    if (snapshot) {
      sessionTailState = {
        sessionsPath,
        filePath: candidate.filePath,
        size: await getFileSize(candidate.filePath),
        snapshot
      };
      return snapshot;
    }
  }

  return sessionTailState?.sessionsPath === sessionsPath ? sessionTailState.snapshot : undefined;
}

export function normalizeAppServerUsageSnapshot(result: AppServerRateLimitsResult, recordedAt = new Date().toISOString()): UsageSnapshot | undefined {
  const rateLimits = pickAppServerRateLimitSnapshot(result);
  if (!rateLimits) {
    return undefined;
  }

  const primary = toUsageWindow(rateLimits.primary);
  const secondary = toUsageWindow(rateLimits.secondary);
  if (!primary && !secondary) {
    return undefined;
  }

  return {
    recordedAt,
    sourceFile: 'codex app-server',
    planType: asNonEmptyString(rateLimits.planType ?? undefined),
    limitId: asNonEmptyString(rateLimits.limitId ?? undefined),
    primary,
    secondary
  };
}

async function collectCandidateFiles(rootPath: string): Promise<CandidateFile[]> {
  const prioritizedToday = await collectRecentTodayCandidateFiles(rootPath);
  if (prioritizedToday.length) {
    return prioritizedToday;
  }

  const candidates: CandidateFile[] = [];
  await walkSessions(rootPath, candidates);

  return candidates
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_CANDIDATE_FILES);
}

async function collectRecentTodayCandidateFiles(rootPath: string): Promise<CandidateFile[]> {
  const todayDir = path.join(
    rootPath,
    String(new Date().getFullYear()),
    String(new Date().getMonth() + 1).padStart(2, '0'),
    String(new Date().getDate()).padStart(2, '0')
  );

  let entries: fscore.Dirent[];
  try {
    entries = await fs.readdir(todayDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const now = Date.now();
  const candidates: CandidateFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }

    const filePath = path.join(todayDir, entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs >= now - RECENT_SESSION_WINDOW_MS) {
        candidates.push({ filePath, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // Ignore races while current sessions are rotating.
    }
  }

  return candidates
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_CANDIDATE_FILES);
}

async function walkSessions(dirPath: string, candidates: CandidateFile[]): Promise<void> {
  let entries: fscore.Dirent[];

  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      await walkSessions(fullPath, candidates);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }

    try {
      const stat = await fs.stat(fullPath);
      candidates.push({ filePath: fullPath, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore races while sessions are being rotated.
    }
  }
}

async function readLatestSnapshotFromFile(filePath: string): Promise<UsageSnapshot | undefined> {
  let content: string;

  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }

  return readLatestSnapshotFromContent(content, filePath);
}

async function readLatestSnapshotFromTailState(sessionsPath: string): Promise<UsageSnapshot | undefined> {
  if (!sessionTailState || sessionTailState.sessionsPath !== sessionsPath) {
    return undefined;
  }

  const filePath = sessionTailState.filePath;
  let stat: fscore.Stats;
  try {
    stat = await fs.stat(filePath);
  } catch {
    sessionTailState = undefined;
    return undefined;
  }

  if (stat.size < sessionTailState.size) {
    sessionTailState = undefined;
    return undefined;
  }

  if (stat.size === sessionTailState.size) {
    return sessionTailState.snapshot;
  }

  let delta: string;
  try {
    delta = await readFileSlice(filePath, sessionTailState.size, stat.size);
  } catch {
    sessionTailState = undefined;
    return undefined;
  }

  const appendedSnapshot = readLatestSnapshotFromContent(delta, filePath);
  sessionTailState = {
    sessionsPath,
    filePath,
    size: stat.size,
    snapshot: appendedSnapshot ?? sessionTailState.snapshot
  };

  return sessionTailState.snapshot;
}

function readLatestSnapshotFromContent(content: string, sourceFile: string): UsageSnapshot | undefined {
  const lines = content.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as SessionEntry;
      const snapshot = toUsageSnapshot(entry, sourceFile);
      if (snapshot) {
        return snapshot;
      }
    } catch {
      // Ignore malformed lines; session files are append-only JSONL.
    }
  }

  return undefined;
}

async function readFileSlice(filePath: string, start: number, end: number): Promise<string> {
  if (end <= start) {
    return '';
  }

  const handle = await fs.open(filePath, 'r');
  try {
    const length = end - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function getFileSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

async function readUsageSnapshotFromAppServer(): Promise<UsageSnapshot | undefined> {
  try {
    const { getCodexCliCommandSpec } = await import('./auth');
    const spec = await getCodexCliCommandSpec(['app-server', '--listen', 'stdio://'], 'codex app-server');
    const result = await readUsageFromAppServerProcess(spec.shellPath, spec.shellArgs);
    return normalizeAppServerUsageSnapshot(result);
  } catch {
    return undefined;
  }
}

function readUsageFromAppServerProcess(shellPath: string, shellArgs: string[]): Promise<AppServerRateLimitsResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(shellPath, shellArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    const lines = readline.createInterface({ input: child.stdout });

    let settled = false;
    let stderr = '';
    let timeout: NodeJS.Timeout | undefined;

    const finalizeResolve = (value: AppServerRateLimitsResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      lines.close();
      child.kill();
      resolve(value);
    };

    const finalizeReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      lines.close();
      child.kill();
      reject(error);
    };

    child.on('error', (error) => {
      finalizeReject(new Error(`Failed to start Codex app-server: ${error.message}`));
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) {
        stderr = stderr.slice(-4000);
      }
    });

    child.stdin.on('error', () => {
      // Ignore EPIPE if the process exits while requests are being written.
    });

    lines.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(trimmed) as { id?: number; result?: unknown; error?: { message?: string } };
      } catch {
        return;
      }

      if (message.id !== APP_SERVER_RATE_LIMITS_REQUEST_ID) {
        return;
      }

      if (message.error) {
        finalizeReject(new Error(`account/rateLimits/read failed: ${message.error.message ?? 'Unknown error'}`));
        return;
      }

      finalizeResolve((message.result ?? {}) as AppServerRateLimitsResult);
    });

    child.on('exit', (code, signal) => {
      if (settled) {
        return;
      }
      const detail = stderr.trim() ? ` stderr: ${stderr.trim()}` : '';
      finalizeReject(new Error(`Codex app-server exited before returning rate limits (code=${code}, signal=${signal}).${detail}`));
    });

    timeout = setTimeout(() => {
      finalizeReject(new Error('Codex app-server rate-limit request timed out'));
    }, APP_SERVER_TIMEOUT_MS);

    const send = (payload: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };

    send({
      jsonrpc: '2.0',
      id: APP_SERVER_INIT_REQUEST_ID,
      method: 'initialize',
      params: {
        clientInfo: { name: 'codex-account-switcher', version: '0.0.0' },
        capabilities: { experimentalApi: true }
      }
    });
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    send({ jsonrpc: '2.0', id: APP_SERVER_RATE_LIMITS_REQUEST_ID, method: 'account/rateLimits/read', params: null });
  });
}

function pickAppServerRateLimitSnapshot(result: AppServerRateLimitsResult): AppServerRateLimitSnapshot | undefined {
  const byLimitId = result.rateLimitsByLimitId;
  if (byLimitId && typeof byLimitId === 'object') {
    if (byLimitId.codex) {
      return byLimitId.codex;
    }

    for (const [key, snapshot] of Object.entries(byLimitId)) {
      if (key.toLowerCase().includes('codex')) {
        return snapshot;
      }
      const identity = `${snapshot.limitId ?? ''} ${snapshot.limitName ?? ''}`.toLowerCase();
      if (identity.includes('codex')) {
        return snapshot;
      }
    }

    const first = Object.values(byLimitId)[0];
    if (first) {
      return first;
    }
  }

  return result.rateLimits ?? undefined;
}

function toUsageSnapshot(entry: SessionEntry, sourceFile: string): UsageSnapshot | undefined {
  if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') {
    return undefined;
  }

  const rateLimits = entry.payload.rate_limits;
  if (!rateLimits) {
    return undefined;
  }

  const primary = toUsageWindow(rateLimits.primary);
  const secondary = toUsageWindow(rateLimits.secondary);

  if (!primary && !secondary) {
    return undefined;
  }

  return {
    recordedAt: entry.timestamp ?? new Date().toISOString(),
    sourceFile,
    planType: rateLimits.plan_type,
    limitId: rateLimits.limit_id,
    primary,
    secondary,
    totalUsage: toTokenUsage(entry.payload.info?.total_token_usage),
    lastUsage: toTokenUsage(entry.payload.info?.last_token_usage)
  };
}

function toTokenUsage(raw: RawTokenUsage | undefined): TokenUsage | undefined {
  if (!raw) {
    return undefined;
  }

  if (
    typeof raw.input_tokens !== 'number' ||
    typeof raw.cached_input_tokens !== 'number' ||
    typeof raw.output_tokens !== 'number' ||
    typeof raw.reasoning_output_tokens !== 'number' ||
    typeof raw.total_tokens !== 'number'
  ) {
    return undefined;
  }

  return {
    inputTokens: raw.input_tokens,
    cachedInputTokens: raw.cached_input_tokens,
    outputTokens: raw.output_tokens,
    reasoningOutputTokens: raw.reasoning_output_tokens,
    totalTokens: raw.total_tokens
  };
}

function toUsageWindow(raw: RawUsageWindow | AppServerRateLimitWindow | null | undefined): UsageWindow | undefined {
  if (!raw) {
    return undefined;
  }

  const usedPercent = typeof raw.used_percent === 'number'
    ? raw.used_percent
    : typeof raw.usedPercent === 'number'
      ? raw.usedPercent
      : undefined;
  const windowMinutes = typeof raw.window_minutes === 'number'
    ? raw.window_minutes
    : typeof raw.windowDurationMins === 'number'
      ? raw.windowDurationMins
      : undefined;
  const resetsAt = typeof raw.resets_at === 'number'
    ? raw.resets_at
    : typeof raw.resetsAt === 'number'
      ? raw.resetsAt
      : undefined;

  if (typeof usedPercent !== 'number' || typeof windowMinutes !== 'number' || typeof resetsAt !== 'number') {
    return undefined;
  }

  return {
    usedPercent,
    windowMinutes,
    resetsAt: new Date(resetsAt * 1000).toISOString()
  };
}

function asNonEmptyString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
