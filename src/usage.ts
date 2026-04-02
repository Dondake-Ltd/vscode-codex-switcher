import * as fscore from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';

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
  window_minutes?: number;
  resets_at?: number;
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

const MAX_CANDIDATE_FILES = 40;

export function getSessionsPath(codexHome: string): string {
  return path.join(codexHome, 'sessions');
}

export async function readLatestUsageSnapshot(codexHome: string): Promise<UsageSnapshot | undefined> {
  const sessionsPath = getSessionsPath(codexHome);
  const candidates = await collectCandidateFiles(sessionsPath);

  for (const candidate of candidates) {
    const snapshot = await readLatestSnapshotFromFile(candidate.filePath);
    if (snapshot) {
      return snapshot;
    }
  }

  return undefined;
}

async function collectCandidateFiles(rootPath: string): Promise<CandidateFile[]> {
  const candidates: CandidateFile[] = [];
  await walkSessions(rootPath, candidates);

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

  const lines = content.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as SessionEntry;
      const snapshot = toUsageSnapshot(entry, filePath);
      if (snapshot) {
        return snapshot;
      }
    } catch {
      // Ignore malformed lines; session files are append-only JSONL.
    }
  }

  return undefined;
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

function toUsageWindow(raw: RawUsageWindow | undefined): UsageWindow | undefined {
  if (!raw) {
    return undefined;
  }

  if (typeof raw.used_percent !== 'number' || typeof raw.window_minutes !== 'number' || typeof raw.resets_at !== 'number') {
    return undefined;
  }

  return {
    usedPercent: raw.used_percent,
    windowMinutes: raw.window_minutes,
    resetsAt: new Date(raw.resets_at * 1000).toISOString()
  };
}
