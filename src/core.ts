import * as path from 'path';

export type AccountConfig = {
  name: string;
  authFile: string;
  enabled?: boolean;
};

export type ResolveContext = {
  configuredCodexHome?: string;
  envCodexHome?: string;
  homeDir: string;
  platform: NodeJS.Platform;
  envHome?: string;
  envUserProfile?: string;
};

export function normalizeAccounts(raw: unknown): AccountConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter(
    (item): item is AccountConfig =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).name === 'string' &&
      typeof (item as Record<string, unknown>).authFile === 'string'
  );
}

export function getEnabledAccounts(accounts: AccountConfig[]): AccountConfig[] {
  return accounts.filter((a) => a.enabled !== false);
}

export function resolveCodexHome(ctx: ResolveContext): string {
  const configured = (ctx.configuredCodexHome ?? '').trim();
  if (configured) {
    return expandPath(configured, {
      codexHome: configured,
      homeDir: ctx.homeDir,
      platform: ctx.platform,
      envHome: ctx.envHome,
      envUserProfile: ctx.envUserProfile
    });
  }

  const envCodexHome = (ctx.envCodexHome ?? '').trim();
  if (envCodexHome) {
    return envCodexHome;
  }

  return path.join(ctx.homeDir, '.codex');
}

export function expandPath(
  inputPath: string,
  options: {
    codexHome: string;
    homeDir: string;
    platform: NodeJS.Platform;
    envHome?: string;
    envUserProfile?: string;
  }
): string {
  let p = inputPath
    .replaceAll('${codexHome}', options.codexHome)
    .replaceAll('${HOME}', options.envHome ?? options.homeDir);

  if (options.platform === 'win32') {
    p = p.replaceAll('%USERPROFILE%', options.envUserProfile ?? options.homeDir);
  }

  if (p.startsWith('~')) {
    p = path.join(options.homeDir, p.slice(1));
  }

  if (!path.isAbsolute(p)) {
    p = path.resolve(options.codexHome, p);
  }

  return p;
}

export function coerceExpectedFilePath(resolvedPath: string, expectedFileName: string): string {
  const trimmed = resolvedPath.trim().replace(/^"(.*)"$/, '$1');
  const normalized = trimmed.replace(/[\\/]+$/, '');
  if (!normalized) {
    return expectedFileName;
  }

  if (path.basename(normalized).toLowerCase() === expectedFileName.toLowerCase()) {
    return normalized;
  }

  return path.join(normalized, expectedFileName);
}

export function getActiveAuthPath(codexHome: string): string {
  return path.join(codexHome, 'auth.json');
}

export function getBackupPath(codexHome: string, timestamp: string): string {
  return path.join(codexHome, `auth.backup.${timestamp}.json`);
}

export function getTimestamp(date: Date = new Date()): string {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

export function validateJsonObjectText(content: string): { valid: true } | { valid: false; reason: string } {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { valid: false, reason: 'JSON root must be an object.' };
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : 'Unknown parse error' };
  }
}
