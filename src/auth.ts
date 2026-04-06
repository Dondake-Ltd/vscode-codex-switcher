import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import { coerceExpectedFilePath, resolveCodexHome, validateJsonObjectText } from './core';

export type CodexCliLaunchSpec = {
  shellPath: string;
  shellArgs: string[];
  displayText: string;
  source: 'configured' | 'bundled' | 'path' | 'wsl-path' | 'wsl-bundled';
};

export type AuthData = {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId?: string;
  defaultOrganizationId?: string;
  defaultOrganizationTitle?: string;
  chatgptUserId?: string;
  userId?: string;
  subject?: string;
  email: string;
  planType: string;
  authJson: Record<string, unknown>;
  codexConfigText?: string;
};

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return {};
    }

    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function getDefaultOrganization(authPayload: Record<string, unknown>): { id?: string; title?: string } {
  const directId =
    asNonEmptyString(authPayload.selected_organization_id) ??
    asNonEmptyString(authPayload.default_organization_id);
  const organizations = Array.isArray(authPayload.organizations)
    ? authPayload.organizations.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    : [];

  if (directId) {
    const match = organizations.find((org) => asNonEmptyString(org.id) === directId);
    return {
      id: directId,
      title: asNonEmptyString(match?.title)
    };
  }

  if (organizations.length === 0) {
    return {};
  }

  const selected = organizations.find((org) => org.is_default === true) ?? organizations[0];
  return {
    id: asNonEmptyString(selected.id),
    title: asNonEmptyString(selected.title)
  };
}

export function shouldUseWslAuthPath(): boolean {
  if (process.platform !== 'win32') {
    return false;
  }

  return vscode.workspace
    .getConfiguration('chatgpt')
    .get<boolean>('runCodexInWindowsSubsystemForLinux', false);
}

function resolveWslCodexHomeWindowsPath(): string | undefined {
  try {
    const output = execFileSync(
      'wsl.exe',
      [
        'sh',
        '-lc',
        'p="${CODEX_HOME:-$HOME/.codex}"; wslpath -w "$p"'
      ],
      { encoding: 'utf8', windowsHide: true }
    );
    const resolved = String(output ?? '').trim();
    return resolved ? resolved.replace(/[\\/]+$/, '') : undefined;
  } catch {
    return undefined;
  }
}

function resolveWslCodexPath(relativePath: string): string | undefined {
  const wslHome = resolveWslCodexHomeWindowsPath();
  return wslHome ? path.join(wslHome, relativePath) : undefined;
}

export function getResolvedCodexHome(): string {
  return resolveCodexHome({
    configuredCodexHome: vscode.workspace.getConfiguration('codexAccountSwitcher').get<string>('codexHome', ''),
    envCodexHome: process.env.CODEX_HOME,
    homeDir: os.homedir(),
    platform: process.platform,
    envHome: process.env.HOME,
    envUserProfile: process.env.USERPROFILE
  });
}

export function getResolvedActiveAuthPath(): string {
  if (shouldUseWslAuthPath()) {
    const wslPath = resolveWslCodexPath('auth.json');
    if (wslPath) {
      return coerceExpectedFilePath(wslPath, 'auth.json');
    }
  }

  return coerceExpectedFilePath(path.join(getResolvedCodexHome(), 'auth.json'), 'auth.json');
}

export function getResolvedCodexConfigPath(): string {
  if (shouldUseWslAuthPath()) {
    const wslPath = resolveWslCodexPath('config.toml');
    if (wslPath) {
      return coerceExpectedFilePath(wslPath, 'config.toml');
    }
  }

  return coerceExpectedFilePath(path.join(getResolvedCodexHome(), 'config.toml'), 'config.toml');
}

export async function loadCodexConfigText(filePath = getResolvedCodexConfigPath()): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

export async function loadAuthDataFromFile(filePath: string): Promise<AuthData | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const validation = validateJsonObjectText(raw);
    if (!validation.valid) {
      return null;
    }

    const authJson = JSON.parse(raw) as Record<string, unknown>;
    const tokens = authJson.tokens;
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
      return null;
    }

    const tokenRecord = tokens as Record<string, unknown>;
    const idToken = asNonEmptyString(tokenRecord.id_token);
    const accessToken = asNonEmptyString(tokenRecord.access_token);
    const refreshToken = asNonEmptyString(tokenRecord.refresh_token);

    if (!idToken || !accessToken || !refreshToken) {
      return null;
    }

    const jwtPayload = parseJwtPayload(idToken);
    const authPayload = jwtPayload['https://api.openai.com/auth'];
    const authObject = authPayload && typeof authPayload === 'object' && !Array.isArray(authPayload)
      ? (authPayload as Record<string, unknown>)
      : {};
    const defaultOrganization = getDefaultOrganization(authObject);

    return {
      idToken,
      accessToken,
      refreshToken,
      accountId: asNonEmptyString(tokenRecord.account_id),
      defaultOrganizationId: defaultOrganization.id,
      defaultOrganizationTitle: defaultOrganization.title,
      chatgptUserId: asNonEmptyString(authObject.chatgpt_user_id),
      userId: asNonEmptyString(authObject.user_id),
      subject: asNonEmptyString(jwtPayload.sub),
      email: asNonEmptyString(jwtPayload.email) ?? 'Unknown',
      planType: asNonEmptyString(authObject.chatgpt_plan_type) ?? 'Unknown',
      authJson
    };
  } catch {
    return null;
  }
}

export function buildAuthJsonText(authData: AuthData): string {
  const payload = JSON.parse(JSON.stringify(authData.authJson ?? {})) as Record<string, unknown>;
  const tokens = payload.tokens && typeof payload.tokens === 'object' && !Array.isArray(payload.tokens)
    ? (payload.tokens as Record<string, unknown>)
    : {};

  tokens.id_token = authData.idToken;
  tokens.access_token = authData.accessToken;
  tokens.refresh_token = authData.refreshToken;
  if (authData.accountId) {
    tokens.account_id = authData.accountId;
  }

  payload.tokens = tokens;
  return `${JSON.stringify(payload, null, 2)}\n`;
}

async function atomicWriteTextFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tempPath, contents, 'utf8');

  try {
    await fs.rename(tempPath, filePath);
  } catch {
    await fs.copyFile(tempPath, filePath);
    await fs.rm(tempPath, { force: true });
    return;
  }

  await fs.rm(tempPath, { force: true });
}

export async function syncAuthFile(filePath: string, authData: AuthData): Promise<void> {
  await atomicWriteTextFile(filePath, buildAuthJsonText(authData));
}

export async function syncCodexConfigFile(filePath: string, configText: string): Promise<void> {
  await atomicWriteTextFile(filePath, configText.endsWith('\n') ? configText : `${configText}\n`);
}

function getBundledCliRelativeDir(platform: NodeJS.Platform, arch: string): string | undefined {
  const platformPart = platform === 'win32'
    ? 'windows'
    : platform === 'darwin'
      ? 'macos'
      : platform === 'linux'
        ? 'linux'
        : undefined;
  const archPart = arch === 'x64'
    ? 'x86_64'
    : arch === 'arm64'
      ? 'aarch64'
      : undefined;

  if (!platformPart || !archPart) {
    return undefined;
  }

  return path.join('bin', `${platformPart}-${archPart}`);
}

function getConfiguredCliExecutable(): string | undefined {
  const configured = vscode.workspace.getConfiguration('chatgpt').get<string | null>('cliExecutable', null);
  const trimmed = configured?.trim();
  return trimmed ? trimmed : undefined;
}

function getBundledCliExecutableForHost(platform: NodeJS.Platform, arch: string): string | undefined {
  const extension = vscode.extensions.getExtension('openai.chatgpt');
  if (!extension) {
    return undefined;
  }

  const relativeDir = getBundledCliRelativeDir(platform, arch);
  if (!relativeDir) {
    return undefined;
  }

  const executableName = platform === 'win32' ? 'codex.exe' : 'codex';
  const candidate = path.join(extension.extensionPath, relativeDir, executableName);
  return fsSync.existsSync(candidate) ? candidate : undefined;
}

function tryResolveWslCommand(command: string): string | undefined {
  try {
    const output = execFileSync('wsl.exe', ['sh', '-lc', `command -v ${command}`], {
      encoding: 'utf8',
      windowsHide: true
    });
    const resolved = String(output ?? '').trim();
    return resolved || undefined;
  } catch {
    return undefined;
  }
}

function toWslPath(windowsPath: string): string | undefined {
  try {
    const output = execFileSync('wsl.exe', ['wslpath', '-a', windowsPath], {
      encoding: 'utf8',
      windowsHide: true
    });
    const resolved = String(output ?? '').trim();
    return resolved || undefined;
  } catch {
    return undefined;
  }
}

export function getCodexLoginHintText(): string {
  return 'Login via Codex CLI...';
}

export function getCodexLoginCommandText(): string {
  return shouldUseWslAuthPath() ? 'wsl codex login' : 'codex login';
}

export async function getCodexCliLaunchSpec(): Promise<CodexCliLaunchSpec> {
  const configuredCli = getConfiguredCliExecutable();

  if (shouldUseWslAuthPath()) {
    const wslCodex = tryResolveWslCommand('codex');
    if (wslCodex) {
      return {
        shellPath: 'wsl.exe',
        shellArgs: ['--', wslCodex, 'login'],
        displayText: 'wsl codex login',
        source: 'wsl-path'
      };
    }

    const bundledLinuxCli = getBundledCliExecutableForHost('linux', process.arch);
    const bundledLinuxCliWslPath = bundledLinuxCli ? toWslPath(bundledLinuxCli) : undefined;
    if (bundledLinuxCliWslPath) {
      return {
        shellPath: 'wsl.exe',
        shellArgs: ['--', bundledLinuxCliWslPath, 'login'],
        displayText: 'bundled Codex CLI login (WSL)',
        source: 'wsl-bundled'
      };
    }
  }

  if (configuredCli) {
    return {
      shellPath: configuredCli,
      shellArgs: ['login'],
      displayText: `${configuredCli} login`,
      source: 'configured'
    };
  }

  const bundledCli = getBundledCliExecutableForHost(process.platform, process.arch);
  if (bundledCli) {
    return {
      shellPath: bundledCli,
      shellArgs: ['login'],
      displayText: 'bundled Codex CLI login',
      source: 'bundled'
    };
  }

  return {
    shellPath: shouldUseWslAuthPath() ? 'wsl.exe' : 'codex',
    shellArgs: shouldUseWslAuthPath() ? ['--', 'codex', 'login'] : ['login'],
    displayText: getCodexLoginCommandText(),
    source: 'path'
  };
}
