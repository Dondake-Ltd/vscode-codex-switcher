import * as fscore from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import {
  getCodexCliLaunchSpec,
  getCodexCliCommandSpec,
  getCodexLoginCommandText,
  getCodexLoginHintText,
  getResolvedActiveAuthPath,
  getResolvedCapSidPath,
  getResolvedCodexHome,
  getResolvedCodexConfigPath,
  loadAuthDataFromFile,
  loadCodexConfigText,
  shouldUseWslAuthPath
} from './auth';
import {
  decryptTransferPayload,
  encryptTransferPayload,
  isEncryptedTransferEnvelope
} from './transferCrypto';
import {
  AccountConfig,
  expandPath,
  getImportProfileActivationDecision,
  getBackupPath,
  getEnabledAccounts,
  getMinimumRemainingPercentForWindows,
  getWorkspaceProfileSwitchPromptDecision,
  pickLowUsageCandidate,
  getTimestamp,
  normalizeAccounts,
  shouldOfferRememberWorkspaceProfile
} from './core';
import { ProfileStore, ProfileSummary } from './profileStore';
import { getSessionsPath, readCurrentUsageSnapshot, TokenUsage, UsageSnapshot, UsageSourceMode, UsageWindow } from './usage';

const EXT_NS = 'codexAccountSwitcher';
const CMD_SWITCH = 'codexAccountSwitcher.switchAccount';
const CMD_ADD = 'codexAccountSwitcher.addAccount';
const CMD_DELETE = 'codexAccountSwitcher.deleteAccount';
const CMD_EDIT = 'codexAccountSwitcher.editAccounts';
const CMD_RELOAD = 'codexAccountSwitcher.reloadWindow';
const CMD_EXPORT = 'codexAccountSwitcher.exportActiveAuth';
const CMD_RENAME = 'codexAccountSwitcher.renameProfile';
const CMD_REAUTH = 'codexAccountSwitcher.reauthenticateProfile';
const CMD_UPDATE_PROFILE_AUTH = 'codexAccountSwitcher.updateProfileFromCurrentAuth';
const CMD_IMPORT_PROFILES = 'codexAccountSwitcher.importProfiles';
const CMD_EXPORT_PROFILES = 'codexAccountSwitcher.exportProfiles';
const CMD_REPAIR_PROFILES = 'codexAccountSwitcher.repairProfiles';
const CMD_SHOW_DIAGNOSTICS = 'codexAccountSwitcher.showDiagnostics';
const CMD_LOGIN = 'codexAccountSwitcher.loginWithCodexCli';
const CMD_MANAGE = 'codexAccountSwitcher.manageProfiles';
const CMD_SHOW_USAGE_DETAILS = 'codexAccountSwitcher.showUsageDetails';
const CMD_OPEN_OPENAI_USAGE = 'codexAccountSwitcher.openOpenAiUsage';
const CMD_REFRESH_USAGE = 'codexAccountSwitcher.refreshUsage';
const STATUS_SIDE_SETTING = 'statusBarSide';
const RELOAD_TARGET_SETTING = 'reloadTarget';
const STORAGE_MODE_SETTING = 'storageMode';
const SHOW_STATUS_BAR_USAGE_SETTING = 'showUsageInStatusBar';
const SHOW_SWITCHER_USAGE_SETTING = 'showUsageInSwitcher';
const MASK_PROFILE_NAMES_SETTING = 'maskProfileNames';
const MASK_PROFILE_EMAILS_SETTING = 'maskProfileEmails';
const PROCESS_SAFETY_CHECKS_ENABLED_SETTING = 'processSafetyChecksEnabled';
const EXPERIMENTAL_WEB_USAGE_PROBE_ENABLED_SETTING = 'experimentalWebUsageProbeEnabled';
const WORKSPACE_PROFILE_PROMPTS_ENABLED_SETTING = 'workspaceProfilePromptsEnabled';
const USAGE_REFRESH_INTERVAL_SETTING = 'usageRefreshIntervalSeconds';
const USAGE_SOURCE_MODE_SETTING = 'usageSourceMode';
const USAGE_COLORS_ENABLED_SETTING = 'usageColorsEnabled';
const USAGE_WARNING_THRESHOLD_SETTING = 'usageWarningThreshold';
const USAGE_WARNING_COLOR_SETTING = 'usageWarningColor';
const USAGE_CRITICAL_THRESHOLD_SETTING = 'usageCriticalThreshold';
const USAGE_CRITICAL_COLOR_SETTING = 'usageCriticalColor';
const USAGE_PERCENT_DISPLAY_SETTING = 'usagePercentDisplay';
const IMPORT_SWITCH_BEHAVIOR_SETTING = 'importProfileSwitchBehavior';
const LOW_USAGE_SWITCH_BEHAVIOR_SETTING = 'lowUsageProfileSwitchBehavior';
const LOW_USAGE_SWITCH_THRESHOLD_SETTING = 'lowUsageSwitchThresholdPercent';
const LOW_USAGE_CANDIDATE_FRESHNESS_SETTING = 'lowUsageCandidateFreshnessSeconds';
const LOW_USAGE_AUTO_SWITCH_COUNTDOWN_SETTING = 'lowUsageAutoSwitchCountdownSeconds';
const CMD_RESTART_EXTENSION_HOST = 'workbench.action.restartExtensionHost';
const USAGE_CACHE_KEY = 'usageByProfile';
const USAGE_HISTORY_KEY = 'usageHistoryByProfile';
const LAST_SWITCH_AT_KEY = 'lastSwitchAtByProfile';
const PENDING_SWITCH_APPLY_KEY = 'pendingSwitchApply';
const EXPERIMENTAL_WEB_USAGE_OOBE_KEY = 'experimentalWebUsageProbeOobeCompleted';
const EXPERIMENTAL_WEB_USAGE_PROMPT_STATE_KEY = 'experimentalWebUsageProbePromptState';
const WORKSPACE_PROFILE_PREFERENCES_KEY = 'workspaceProfilePreferences';
const WORKSPACE_PROFILE_SUPPRESSIONS_KEY = 'workspaceProfileSuppressions';
const execFileAsync = promisify(execFile);

let statusBar: vscode.StatusBarItem;
let usageStatusBar: vscode.StatusBarItem;
let usageRefreshStatusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let profileStore: ProfileStore;
let usageRefreshTimer: NodeJS.Timeout | undefined;
let usageWatcher: fscore.FSWatcher | undefined;
let usageRefreshDebounce: NodeJS.Timeout | undefined;
let lowUsageSuggestionKey: string | undefined;
let lowUsageAutoSwitchTimer: NodeJS.Timeout | undefined;
let lowUsageHandlingInProgress = false;
let lastUsageRefreshDiagnostic: UsageRefreshDiagnostic | undefined;
const sessionWorkspacePromptedKeys = new Set<string>();

type CachedUsageEntry = {
  snapshot: UsageSnapshot;
  cachedAt: string;
};

type UsageCache = Record<string, CachedUsageEntry>;
type UsageHistorySample = {
  recordedAt: string;
  primaryUsedPercent?: number;
  secondaryUsedPercent?: number;
  totalUsage?: TokenUsage;
  lastUsage?: TokenUsage;
  sourceFile?: string;
};
type UsageHistoryStore = Record<string, UsageHistorySample[]>;
type LastSwitchMap = Record<string, string>;
type PendingSwitchState = {
  profileId: string;
  profileName: string;
  requestedAt: string;
  reloadTarget: 'extensionHost' | 'window';
};
type ExperimentalWebUsagePromptState = 'enabled' | 'dismissed';
type CodexProcessInfo = {
  pid: number;
  label: string;
  commandLine: string;
};
type WorkspaceProfilePreference = {
  workspaceKey: string;
  workspaceLabel: string;
  rootPath: string;
  remoteUrl?: string;
  profileId: string;
  updatedAt: string;
};
type WorkspaceProfilePreferences = Record<string, WorkspaceProfilePreference>;
type WorkspacePromptSuppressions = Record<string, boolean>;
type WorkspaceContextInfo = {
  workspaceKey: string;
  workspaceLabel: string;
  rootPath: string;
  remoteUrl?: string;
};

type ProfileQuickPickItem = vscode.QuickPickItem & {
  itemType: 'profile';
  profileId: string;
};

type ActionQuickPickItem = vscode.QuickPickItem & {
  itemType: 'action';
  actionId:
    | 'addCurrent'
    | 'importFile'
    | 'login'
    | 'refreshUsage'
    | 'reauthenticate'
    | 'refreshCurrent'
    | 'repairProfiles'
    | 'diagnostics'
    | 'rename'
    | 'delete'
    | 'settings'
    | 'exportProfiles'
    | 'importProfiles';
};

type SwitcherQuickPickItem = ProfileQuickPickItem | ActionQuickPickItem | vscode.QuickPickItem;

type ProfileUsageView = {
  entry?: CachedUsageEntry;
  history: UsageHistorySample[];
  isStaleForActiveProfile: boolean;
  refreshDiagnostic?: UsageRefreshDiagnostic;
};

type UsageRefreshDiagnostic = {
  attemptedAt: string;
  outcome: 'updated' | 'unchanged' | 'noData' | 'ignoredOlder' | 'noActiveProfile';
  sourceMode: UsageSourceMode;
  source?: string;
  recordedAt?: string;
};

type DiagnosticsHealthItem = {
  severity: 'healthy' | 'warning' | 'broken';
  title: string;
  detail: string;
  action?: string;
};

type SeverityColors = {
  warning: string;
  critical: string;
};

type UsageWindowDescriptor = {
  key: 'fiveHour' | 'weekly' | 'other';
  shortLabel: string;
  longLabel: string;
  icon: string;
  window: UsageWindow;
};

const FIVE_HOUR_WINDOW_MINUTES = 300;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Codex Account Switcher');
  context.subscriptions.push(output);

  profileStore = new ProfileStore(context, output);

  createStatusBarItems();
  context.subscriptions.push({
    dispose: () => {
      statusBar.dispose();
      usageStatusBar.dispose();
      usageRefreshStatusBar.dispose();
    }
  });
  context.subscriptions.push({
    dispose: () => {
      if (usageRefreshTimer) {
        clearInterval(usageRefreshTimer);
      }
      if (usageRefreshDebounce) {
        clearTimeout(usageRefreshDebounce);
      }
      usageWatcher?.close();
    }
  });

  context.subscriptions.push(vscode.commands.registerCommand(CMD_SWITCH, () => switchProfileViaPicker(context)));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_ADD, () => addProfileFromCurrentAuth(context)));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_DELETE, () => deleteProfile(context)));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_EDIT, () => editSettings()));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_RELOAD, () => vscode.commands.executeCommand('workbench.action.reloadWindow')));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_EXPORT, () => exportActiveAuth()));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_RENAME, () => renameProfile(context)));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_REAUTH, () => reauthenticateProfile(context)));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_UPDATE_PROFILE_AUTH, () => updateProfileFromCurrentAuth(context)));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_IMPORT_PROFILES, () => importProfiles()));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_EXPORT_PROFILES, () => exportProfiles()));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_REPAIR_PROFILES, () => repairProfiles(context)));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_SHOW_DIAGNOSTICS, () => showDiagnosticsPanel(context)));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_LOGIN, () => loginViaCodexCli(context)));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_MANAGE, () => manageProfiles(context)));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_SHOW_USAGE_DETAILS, () => showUsageDetailsPanel(context)));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_OPEN_OPENAI_USAGE, () => vscode.env.openExternal(vscode.Uri.parse('https://platform.openai.com/usage'))));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_REFRESH_USAGE, async () => {
    await refreshUsageAndStatus(context);
  }));

  context.subscriptions.push(
    ...profileStore.createWatchers(() => {
      void refreshUsageAndStatus(context);
    })
  );

  context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(() => {
    void refreshUsageAndStatus(context);
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void maybePromptForPreferredWorkspaceProfile(context);
  }));

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    void maybePromptForPreferredWorkspaceProfile(context);
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration(EXT_NS) && !e.affectsConfiguration('chatgpt.runCodexInWindowsSubsystemForLinux')) {
      return;
    }

    if (e.affectsConfiguration(`${EXT_NS}.${STATUS_SIDE_SETTING}`)) {
      recreateStatusBarItem();
    }

    if (e.affectsConfiguration(`${EXT_NS}.${USAGE_REFRESH_INTERVAL_SETTING}`)) {
      recreateUsageRefreshTimer(context);
    }

    if (
      e.affectsConfiguration(`${EXT_NS}.codexHome`) ||
      e.affectsConfiguration(`${EXT_NS}.${USAGE_REFRESH_INTERVAL_SETTING}`) ||
      e.affectsConfiguration(`${EXT_NS}.${STORAGE_MODE_SETTING}`) ||
      e.affectsConfiguration('chatgpt.runCodexInWindowsSubsystemForLinux')
    ) {
      recreateUsageWatcher(context);
    }

    void refreshUsageAndStatus(context);
    if (e.affectsConfiguration(`${EXT_NS}.${WORKSPACE_PROFILE_PROMPTS_ENABLED_SETTING}`)) {
      void maybePromptForPreferredWorkspaceProfile(context);
    }
  }));

  recreateUsageRefreshTimer(context);
  recreateUsageWatcher(context);
  void initializeProfiles(context);
}

export function deactivate(): void {}

async function initializeProfiles(context: vscode.ExtensionContext): Promise<void> {
  await maybeWarnEnsureFileBasedCreds(context);
  await maybeOfferExperimentalWebUsageProbe(context);
  await migrateLegacyAccounts(context);
  await profileStore.syncActiveProfileToAuthFile();
  await resolvePendingSwitchState(context);
  await refreshUsageAndStatus(context);
  await maybePromptForPreferredWorkspaceProfile(context);
}

function getStatusBarAlignment(): vscode.StatusBarAlignment {
  const side = getConfig().get<string>(STATUS_SIDE_SETTING, 'right').toLowerCase();
  return side === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
}

function createStatusBarItems(): void {
  statusBar = vscode.window.createStatusBarItem(getStatusBarAlignment(), 1000);
  statusBar.command = CMD_SWITCH;

  usageStatusBar = vscode.window.createStatusBarItem(getStatusBarAlignment(), 999);
  usageStatusBar.command = CMD_SHOW_USAGE_DETAILS;

  usageRefreshStatusBar = vscode.window.createStatusBarItem(getStatusBarAlignment(), 998);
  usageRefreshStatusBar.command = CMD_REFRESH_USAGE;
}

function recreateStatusBarItem(): void {
  statusBar.dispose();
  usageStatusBar.dispose();
  usageRefreshStatusBar.dispose();
  createStatusBarItems();
}

function recreateUsageRefreshTimer(context: vscode.ExtensionContext): void {
  if (usageRefreshTimer) {
    clearInterval(usageRefreshTimer);
  }

  const seconds = Math.max(15, getConfig().get<number>(USAGE_REFRESH_INTERVAL_SETTING, 30));
  usageRefreshTimer = setInterval(() => {
    void refreshUsageAndStatus(context);
  }, seconds * 1000);
}

function recreateUsageWatcher(context: vscode.ExtensionContext): void {
  usageWatcher?.close();
  usageWatcher = undefined;

  const sessionsPath = getSessionsPath(getResolvedCodexHome());
  const recursive = process.platform === 'win32' || process.platform === 'darwin';

  try {
    usageWatcher = fscore.watch(sessionsPath, { recursive }, () => {
      scheduleUsageRefresh(context);
    });
  } catch {
    output.appendLine(`Usage watcher unavailable for ${sessionsPath}; falling back to timed refresh.`);
  }
}

function scheduleUsageRefresh(context: vscode.ExtensionContext): void {
  if (usageRefreshDebounce) {
    clearTimeout(usageRefreshDebounce);
  }

  usageRefreshDebounce = setTimeout(() => {
    usageRefreshDebounce = undefined;
    void refreshUsageAndStatus(context);
  }, 250);
}

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(EXT_NS);
}

function shouldMaskProfileNames(): boolean {
  return getConfig().get<boolean>(MASK_PROFILE_NAMES_SETTING, false);
}

function shouldMaskProfileEmails(): boolean {
  return getConfig().get<boolean>(MASK_PROFILE_EMAILS_SETTING, false);
}

function getMaskedProfileLabel(profileId: string): string {
  return `Profile ${profileId.slice(0, 4)}`;
}

function getProfileDisplayName(profile: Pick<ProfileSummary, 'id' | 'name'>): string {
  return shouldMaskProfileNames() ? getMaskedProfileLabel(profile.id) : profile.name;
}

function maskEmailAddress(email: string): string {
  const trimmed = email.trim();
  const [localPart, domainPart] = trimmed.split('@');

  if (!localPart || !domainPart) {
    return `${trimmed.charAt(0) || '*'}***`;
  }

  const domainSegments = domainPart.split('.');
  const host = domainSegments[0] ?? '';
  const suffix = domainSegments.length > 1 ? `.${domainSegments.slice(1).join('.')}` : '';

  const maskSegment = (segment: string): string => {
    if (!segment) {
      return '***';
    }
    return `${segment.charAt(0)}***`;
  };

  return `${maskSegment(localPart)}@${maskSegment(host)}${suffix}`;
}

function getProfileDisplayEmail(email: string | undefined): string {
  const normalized = email?.trim() || 'Unknown';
  if (normalized === 'Unknown') {
    return normalized;
  }

  return shouldMaskProfileEmails() ? maskEmailAddress(normalized) : normalized;
}

function areProcessSafetyChecksEnabled(): boolean {
  return getConfig().get<boolean>(PROCESS_SAFETY_CHECKS_ENABLED_SETTING, true);
}

function areWorkspaceProfilePromptsEnabled(): boolean {
  return getConfig().get<boolean>(WORKSPACE_PROFILE_PROMPTS_ENABLED_SETTING, true);
}

function isExperimentalWebUsageProbeEnabled(): boolean {
  return getConfig().get<boolean>(EXPERIMENTAL_WEB_USAGE_PROBE_ENABLED_SETTING, false);
}

function getExperimentalWebUsagePromptState(context: vscode.ExtensionContext): ExperimentalWebUsagePromptState | undefined {
  const state = context.globalState.get<ExperimentalWebUsagePromptState | undefined>(EXPERIMENTAL_WEB_USAGE_PROMPT_STATE_KEY);
  if (state) {
    return state;
  }

  return context.globalState.get<boolean>(EXPERIMENTAL_WEB_USAGE_OOBE_KEY, false) ? 'dismissed' : undefined;
}

async function maybeOfferExperimentalWebUsageProbe(context: vscode.ExtensionContext): Promise<void> {
  if (isExperimentalWebUsageProbeEnabled()) {
    if (getExperimentalWebUsagePromptState(context) !== 'enabled') {
      await context.globalState.update(EXPERIMENTAL_WEB_USAGE_PROMPT_STATE_KEY, 'enabled');
    }
    return;
  }

  if (getExperimentalWebUsagePromptState(context)) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    'Try the experimental web usage probe? It uses undocumented ChatGPT web endpoints that may break, and the extension falls back to the supported app-server and local session sources when that happens. You can change this later in Settings.',
    'Enable experimental probe',
    'Not now'
  );

  if (choice === 'Enable experimental probe') {
    await getConfig().update(EXPERIMENTAL_WEB_USAGE_PROBE_ENABLED_SETTING, true, vscode.ConfigurationTarget.Global);
    await context.globalState.update(EXPERIMENTAL_WEB_USAGE_PROMPT_STATE_KEY, 'enabled');
    await context.globalState.update(EXPERIMENTAL_WEB_USAGE_OOBE_KEY, true);
    return;
  }

  await context.globalState.update(EXPERIMENTAL_WEB_USAGE_PROMPT_STATE_KEY, 'dismissed');
  await context.globalState.update(EXPERIMENTAL_WEB_USAGE_OOBE_KEY, true);
}

function getWorkspaceProfilePreferences(context: vscode.ExtensionContext): WorkspaceProfilePreferences {
  return context.globalState.get<WorkspaceProfilePreferences>(WORKSPACE_PROFILE_PREFERENCES_KEY, {});
}

async function updateWorkspaceProfilePreferences(
  context: vscode.ExtensionContext,
  preferences: WorkspaceProfilePreferences
): Promise<void> {
  await context.globalState.update(WORKSPACE_PROFILE_PREFERENCES_KEY, preferences);
}

function getWorkspacePromptSuppressions(context: vscode.ExtensionContext): WorkspacePromptSuppressions {
  return context.globalState.get<WorkspacePromptSuppressions>(WORKSPACE_PROFILE_SUPPRESSIONS_KEY, {});
}

async function updateWorkspacePromptSuppressions(
  context: vscode.ExtensionContext,
  suppressions: WorkspacePromptSuppressions
): Promise<void> {
  await context.globalState.update(WORKSPACE_PROFILE_SUPPRESSIONS_KEY, suppressions);
}

async function execGit(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, timeout: 4000 });
    const value = String(stdout ?? '').trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function getPrimaryWorkspaceContext(): Promise<WorkspaceContextInfo | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return undefined;
  }

  const activeFolder = vscode.window.activeTextEditor
    ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
    : undefined;
  const folder = activeFolder ?? folders[0];
  const folderPath = folder.uri.fsPath;
  const gitRoot = await execGit(['rev-parse', '--show-toplevel'], folderPath);
  const rootPath = gitRoot ?? folderPath;
  const remoteUrl = await execGit(['config', '--get', 'remote.origin.url'], rootPath);
  const workspaceLabel = path.basename(rootPath) || folder.name;
  const workspaceKey = remoteUrl
    ? `git:${remoteUrl}`
    : `path:${rootPath.replaceAll('\\', '/')}`;

  return {
    workspaceKey,
    workspaceLabel,
    rootPath,
    remoteUrl
  };
}

async function maybePromptForPreferredWorkspaceProfile(context: vscode.ExtensionContext): Promise<void> {
  if (!areWorkspaceProfilePromptsEnabled()) {
    return;
  }

  const workspace = await getPrimaryWorkspaceContext();
  if (!workspace) {
    return;
  }

  const preference = getWorkspaceProfilePreferences(context)[workspace.workspaceKey];
  const activeProfileId = await profileStore.getActiveProfileId();
  const suppressions = getWorkspacePromptSuppressions(context);
  const decision = getWorkspaceProfileSwitchPromptDecision({
    promptsEnabled: true,
    workspaceKey: workspace.workspaceKey,
    preferredProfileId: preference?.profileId,
    activeProfileId,
    suppressedForWorkspace: suppressions[workspace.workspaceKey] === true,
    alreadyPromptedThisSession: sessionWorkspacePromptedKeys.has(workspace.workspaceKey)
  });

  if (decision !== 'prompt' || !preference) {
    return;
  }

  const preferredProfile = await profileStore.getProfile(preference.profileId);
  if (!preferredProfile) {
    return;
  }

  sessionWorkspacePromptedKeys.add(workspace.workspaceKey);
  const preferredName = getProfileDisplayName(preferredProfile);
  const choice = await vscode.window.showInformationMessage(
    `Workspace '${workspace.workspaceLabel}' usually uses '${preferredName}'. Switch to that profile now?`,
    'Switch',
    'Not now',
    'Don’t ask again for this repo'
  );

  if (choice === 'Switch') {
    await switchToProfile(preference.profileId, context);
    return;
  }

  if (choice === 'Don’t ask again for this repo') {
    const nextSuppressions = getWorkspacePromptSuppressions(context);
    nextSuppressions[workspace.workspaceKey] = true;
    await updateWorkspacePromptSuppressions(context, nextSuppressions);
  }
}

async function maybeOfferRememberWorkspaceProfile(
  context: vscode.ExtensionContext,
  profile: Pick<ProfileSummary, 'id' | 'name'>
): Promise<void> {
  if (!areWorkspaceProfilePromptsEnabled()) {
    return;
  }

  const workspace = await getPrimaryWorkspaceContext();
  if (!workspace) {
    return;
  }

  const preferences = getWorkspaceProfilePreferences(context);
  const suppressions = getWorkspacePromptSuppressions(context);
  if (!shouldOfferRememberWorkspaceProfile({
    promptsEnabled: true,
    workspaceKey: workspace.workspaceKey,
    activeProfileId: profile.id,
    preferredProfileId: preferences[workspace.workspaceKey]?.profileId,
    suppressedForWorkspace: suppressions[workspace.workspaceKey] === true,
    alreadyPromptedThisSession: sessionWorkspacePromptedKeys.has(`remember:${workspace.workspaceKey}`)
  })) {
    return;
  }

  sessionWorkspacePromptedKeys.add(`remember:${workspace.workspaceKey}`);
  const profileName = getProfileDisplayName(profile);
  const choice = await vscode.window.showInformationMessage(
    `Use '${profileName}' as the preferred profile for workspace '${workspace.workspaceLabel}'?`,
    'Remember',
    'Not now',
    'Don’t ask again for this repo'
  );

  if (choice === 'Remember') {
    preferences[workspace.workspaceKey] = {
      workspaceKey: workspace.workspaceKey,
      workspaceLabel: workspace.workspaceLabel,
      rootPath: workspace.rootPath,
      remoteUrl: workspace.remoteUrl,
      profileId: profile.id,
      updatedAt: new Date().toISOString()
    };
    if (suppressions[workspace.workspaceKey]) {
      delete suppressions[workspace.workspaceKey];
      await updateWorkspacePromptSuppressions(context, suppressions);
    }
    await updateWorkspaceProfilePreferences(context, preferences);
    return;
  }

  if (choice === 'Don’t ask again for this repo') {
    suppressions[workspace.workspaceKey] = true;
    await updateWorkspacePromptSuppressions(context, suppressions);
  }
}

function parseWindowsProcessRows(raw: string): CodexProcessInfo[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const parsed = JSON.parse(trimmed) as Record<string, unknown> | Array<Record<string, unknown>>;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    const pid = Number(row.ProcessId);
    const label = String(row.Name ?? '').trim();
    const commandLine = String(row.CommandLine ?? '').trim();
    if (!Number.isFinite(pid) || !label) {
      return [];
    }
    return [{ pid, label, commandLine }];
  });
}

function parsePosixProcessRows(raw: string): CodexProcessInfo[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        return [];
      }

      const pid = Number(match[1]);
      const commandLine = match[2].trim();
      const label = path.basename(commandLine.split(/\s+/)[0] ?? commandLine);
      if (!Number.isFinite(pid) || !commandLine) {
        return [];
      }

      return [{ pid, label, commandLine }];
    });
}

function isLikelyCodexProcess(processInfo: CodexProcessInfo): boolean {
  const haystack = `${processInfo.label} ${processInfo.commandLine}`.toLowerCase();
  return haystack.includes('codex') && !haystack.includes('codex-account-switcher');
}

async function listRunningCodexProcesses(): Promise<CodexProcessInfo[]> {
  try {
    const rows = process.platform === 'win32'
      ? parseWindowsProcessRows((await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-Command',
          "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"
        ], { timeout: 4000, maxBuffer: 1024 * 1024 * 8 })).stdout)
      : parsePosixProcessRows((await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], { timeout: 4000, maxBuffer: 1024 * 1024 * 4 })).stdout);

    return rows
      .filter((processInfo) => processInfo.pid !== process.pid)
      .filter(isLikelyCodexProcess);
  } catch (error) {
    output.appendLine(`Codex process detection failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function summarizeCodexProcesses(processes: CodexProcessInfo[]): string {
  const labels = [...new Set(processes.map((processInfo) => processInfo.label || 'codex'))].slice(0, 3);
  const names = labels.join(', ');
  const suffix = processes.length > labels.length ? ` +${processes.length - labels.length} more` : '';
  return `${names}${suffix}`;
}

async function confirmNoBusyCodexBeforeSwitch(
  targetProfileName: string,
  reason: 'switch' | 'activate import' | 'activate reauthentication'
): Promise<boolean> {
  if (!areProcessSafetyChecksEnabled()) {
    return true;
  }

  const runningProcesses = await listRunningCodexProcesses();
  if (!runningProcesses.length) {
    return true;
  }

  const actionLabel = reason === 'switch'
    ? 'switch profiles'
    : reason === 'activate import'
      ? 'activate the imported profile'
      : 'activate the reauthenticated profile';
  const choice = await vscode.window.showWarningMessage(
    `Codex appears to be active (${summarizeCodexProcesses(runningProcesses)}). Switching now can interrupt live tasks or leave state half-applied. Do you still want to ${actionLabel} to '${targetProfileName}'?`,
    { modal: true },
    'Switch anyway',
    'Cancel',
    'Open settings'
  );

  if (choice === 'Open settings') {
    await editSettings();
    return false;
  }

  return choice === 'Switch anyway';
}

function getThemeAwareSeverityDefaults(): SeverityColors {
  const kind = vscode.window.activeColorTheme.kind;
  const isLight = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
  return isLight
    ? { warning: '#8a6a00', critical: '#b42318' }
    : { warning: '#f3d898', critical: '#eca7a7' };
}

function getConfiguredStringOverride(setting: string): string | undefined {
  const inspected = getConfig().inspect<string>(setting);
  const configured = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  if (typeof configured !== 'string') {
    return undefined;
  }

  const trimmed = configured.trim();
  return trimmed || undefined;
}

function getSeverityColors(): SeverityColors {
  const defaults = getThemeAwareSeverityDefaults();
  return {
    warning: getConfiguredStringOverride(USAGE_WARNING_COLOR_SETTING) ?? defaults.warning,
    critical: getConfiguredStringOverride(USAGE_CRITICAL_COLOR_SETTING) ?? defaults.critical
  };
}

function getLegacyAccounts(): AccountConfig[] {
  return normalizeAccounts(getConfig().get<unknown>('accounts', []));
}

function resolveLegacyAccountAuthPath(account: AccountConfig): string {
  return expandPath(account.authFile, {
    codexHome: getResolvedCodexHome(),
    homeDir: os.homedir(),
    platform: process.platform,
    envHome: process.env.HOME,
    envUserProfile: process.env.USERPROFILE
  });
}

async function migrateLegacyAccounts(context: vscode.ExtensionContext): Promise<void> {
  const accounts = getEnabledAccounts(getLegacyAccounts());
  const activeAccount = getConfig().get<string>('activeAccount', '').trim();
  await profileStore.importLegacyAccounts(accounts, activeAccount, resolveLegacyAccountAuthPath);
  await context.globalState.update('warnedEnsureFileBasedCredsSession', false);
}

function getUsageCache(context: vscode.ExtensionContext): UsageCache {
  return context.globalState.get<UsageCache>(USAGE_CACHE_KEY, {});
}

type LowUsageCandidate = {
  profile: ProfileSummary;
  snapshot: UsageSnapshot;
  remainingPercent: number;
};

async function updateUsageCache(context: vscode.ExtensionContext, cache: UsageCache): Promise<void> {
  await context.globalState.update(USAGE_CACHE_KEY, cache);
}

function getUsageHistory(context: vscode.ExtensionContext): UsageHistoryStore {
  return context.globalState.get<UsageHistoryStore>(USAGE_HISTORY_KEY, {});
}

async function updateUsageHistory(context: vscode.ExtensionContext, history: UsageHistoryStore): Promise<void> {
  await context.globalState.update(USAGE_HISTORY_KEY, history);
}

async function appendUsageHistorySample(context: vscode.ExtensionContext, profileId: string, snapshot: UsageSnapshot): Promise<void> {
  const history = getUsageHistory(context);
  const current = history[profileId] ?? [];
  if (current[current.length - 1]?.recordedAt === snapshot.recordedAt) {
    return;
  }

  const fiveHourWindow = getFiveHourUsageWindow(snapshot);
  const weeklyWindow = getWeeklyUsageWindow(snapshot);

  const sample: UsageHistorySample = {
    recordedAt: snapshot.recordedAt,
    primaryUsedPercent: fiveHourWindow?.usedPercent,
    secondaryUsedPercent: weeklyWindow?.usedPercent,
    totalUsage: snapshot.totalUsage,
    lastUsage: snapshot.lastUsage,
    sourceFile: snapshot.sourceFile
  };

  const oneYearAgo = Date.now() - (366 * 24 * 60 * 60 * 1000);
  const next = [...current, sample]
    .filter((entry) => parseIsoMs(entry.recordedAt) >= oneYearAgo)
    .slice(-5000);
  history[profileId] = next;
  await updateUsageHistory(context, history);
}

function getLastSwitchMap(context: vscode.ExtensionContext): LastSwitchMap {
  return context.globalState.get<LastSwitchMap>(LAST_SWITCH_AT_KEY, {});
}

async function setLastSwitchAt(context: vscode.ExtensionContext, profileId: string, iso: string): Promise<void> {
  const current = getLastSwitchMap(context);
  current[profileId] = iso;
  await context.globalState.update(LAST_SWITCH_AT_KEY, current);
}

function getPendingSwitchState(context: vscode.ExtensionContext): PendingSwitchState | undefined {
  return context.globalState.get<PendingSwitchState | undefined>(PENDING_SWITCH_APPLY_KEY);
}

async function setPendingSwitchState(context: vscode.ExtensionContext, state: PendingSwitchState | undefined): Promise<void> {
  await context.globalState.update(PENDING_SWITCH_APPLY_KEY, state);
}

async function markPendingSwitchApply(
  context: vscode.ExtensionContext,
  profile: Pick<ProfileSummary, 'id' | 'name'>
): Promise<void> {
  const reloadTarget = getConfig().get<string>(RELOAD_TARGET_SETTING, 'extensionHost') === 'window' ? 'window' : 'extensionHost';
  await setPendingSwitchState(context, {
    profileId: profile.id,
    profileName: getProfileDisplayName(profile),
    requestedAt: new Date().toISOString(),
    reloadTarget
  });
}

async function resolvePendingSwitchState(context: vscode.ExtensionContext): Promise<void> {
  const pending = getPendingSwitchState(context);
  if (!pending) {
    return;
  }

  const activeProfileId = await profileStore.getActiveProfileId();
  await setPendingSwitchState(context, undefined);

  if (activeProfileId !== pending.profileId) {
    output.appendLine(`Cleared stale pending switch marker for '${pending.profileName}'.`);
    return;
  }

  output.appendLine(`Profile switch to '${pending.profileName}' is now applied after reload.`);
  void vscode.window.showInformationMessage(`Codex account/profile '${pending.profileName}' is now applied after reload.`);
}

async function safeExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function maybeWarnEnsureFileBasedCreds(context: vscode.ExtensionContext): Promise<void> {
  const enabled = getConfig().get<boolean>('ensureFileBasedCreds', false);
  if (!enabled) {
    return;
  }

  const key = 'warnedEnsureFileBasedCredsSession';
  if (context.globalState.get<boolean>(key, false)) {
    return;
  }

  await context.globalState.update(key, true);
  void vscode.window.showWarningMessage(
    'Codex Account Switcher relies on the Codex auth file. If Codex uses OS keychain storage instead, switching may not take effect.'
  );
}

async function refreshUsageAndStatus(context: vscode.ExtensionContext): Promise<void> {
  await refreshActiveUsageCache(context);
  await refreshStatusBar(context);
  await maybeHandleLowUsageProfileSwitch(context);
}

async function refreshActiveUsageCache(context: vscode.ExtensionContext): Promise<void> {
  const activeProfileId = await profileStore.getActiveProfileId();
  const sourceMode = getUsageSourceMode();
  const attemptedAt = new Date().toISOString();
  if (!activeProfileId) {
    lastUsageRefreshDiagnostic = {
      attemptedAt,
      outcome: 'noActiveProfile',
      sourceMode
    };
    return;
  }

  const authData = isExperimentalWebUsageProbeEnabled()
    ? await loadAuthDataFromFile(getResolvedActiveAuthPath())
    : null;
  const snapshot = await readCurrentUsageSnapshot(getResolvedCodexHome(), sourceMode, {
    experimentalWebProbeEnabled: isExperimentalWebUsageProbeEnabled(),
    webAccessToken: authData?.accessToken,
    webAccountId: authData?.accountId
  });
  if (!snapshot) {
    lastUsageRefreshDiagnostic = {
      attemptedAt,
      outcome: 'noData',
      sourceMode
    };
    return;
  }

  const lastSwitchAt = getLastSwitchMap(context)[activeProfileId];
  if (lastSwitchAt && parseIsoMs(snapshot.recordedAt) < parseIsoMs(lastSwitchAt)) {
    lastUsageRefreshDiagnostic = {
      attemptedAt,
      outcome: 'ignoredOlder',
      sourceMode,
      source: snapshot.sourceFile,
      recordedAt: snapshot.recordedAt
    };
    return;
  }

  const cache = getUsageCache(context);
  const existing = cache[activeProfileId];
  if (existing && parseIsoMs(existing.snapshot.recordedAt) >= parseIsoMs(snapshot.recordedAt)) {
    lastUsageRefreshDiagnostic = {
      attemptedAt,
      outcome: 'unchanged',
      sourceMode,
      source: existing.snapshot.sourceFile,
      recordedAt: existing.snapshot.recordedAt
    };
    return;
  }

  cache[activeProfileId] = {
    snapshot,
    cachedAt: new Date().toISOString()
  };
  await updateUsageCache(context, cache);
  await appendUsageHistorySample(context, activeProfileId, snapshot);
  lastUsageRefreshDiagnostic = {
    attemptedAt,
    outcome: 'updated',
    sourceMode,
    source: snapshot.sourceFile,
    recordedAt: snapshot.recordedAt
  };
}

async function refreshStatusBar(context: vscode.ExtensionContext): Promise<void> {
  const profiles = await profileStore.listProfiles();
  const activeProfileId = await profileStore.getActiveProfileId();
  const activeProfile = activeProfileId ? await profileStore.getProfile(activeProfileId) : undefined;

  if (!profiles.length || !activeProfileId || !activeProfile) {
    statusBar.text = '$(tools) Setup';
    statusBar.tooltip = 'Configure Codex account and profile switching';
    statusBar.show();
    usageStatusBar.hide();
    usageRefreshStatusBar.hide();
    return;
  }

  const usageView = getProfileUsageView(context, activeProfileId, activeProfileId);
  const pendingSwitch = getPendingSwitchState(context);
  const reloadPending = pendingSwitch?.profileId === activeProfileId ? pendingSwitch : undefined;
  statusBar.text = `${reloadPending ? '$(sync~spin)' : '$(account)'} ${getProfileDisplayName(activeProfile)}`;
  statusBar.tooltip = createActiveProfileTooltip(activeProfile, usageView.isStaleForActiveProfile, reloadPending);
  statusBar.show();

  if (getConfig().get<boolean>(SHOW_STATUS_BAR_USAGE_SETTING, true)) {
    const snapshot = usageView.entry?.snapshot;
    usageStatusBar.text = buildUsageStatusText(snapshot, activeProfile.planType);
    usageStatusBar.tooltip = createUsageTooltip(activeProfile, usageView);
    usageStatusBar.color = snapshot
      ? getUsageStatusBarColor(getMaxUsedPercent(snapshot))
      : new vscode.ThemeColor('statusBarItem.foreground');
    usageStatusBar.show();
    usageRefreshStatusBar.text = '$(refresh)';
    usageRefreshStatusBar.tooltip = createUsageRefreshTooltip(snapshot);
    usageRefreshStatusBar.color = new vscode.ThemeColor('statusBarItem.foreground');
    usageRefreshStatusBar.show();
  } else {
    usageStatusBar.hide();
    usageRefreshStatusBar.hide();
  }
}

function getLowUsageSwitchBehavior(): 'off' | 'ask' | 'auto' {
  const behavior = getConfig().get<string>(LOW_USAGE_SWITCH_BEHAVIOR_SETTING, 'ask').toLowerCase();
  if (behavior === 'off' || behavior === 'auto') {
    return behavior;
  }

  return 'ask';
}

function getLowUsageSwitchThresholdPercent(): number {
  return Math.max(0, Math.min(100, getConfig().get<number>(LOW_USAGE_SWITCH_THRESHOLD_SETTING, 5)));
}

function getLowUsageCandidateFreshnessMs(): number {
  const seconds = Math.max(30, getConfig().get<number>(LOW_USAGE_CANDIDATE_FRESHNESS_SETTING, 600));
  return seconds * 1000;
}

function getLowUsageAutoSwitchCountdownSeconds(): number {
  return Math.max(3, getConfig().get<number>(LOW_USAGE_AUTO_SWITCH_COUNTDOWN_SETTING, 10));
}

function getUsageSourceMode(): UsageSourceMode {
  const mode = getConfig().get<string>(USAGE_SOURCE_MODE_SETTING, 'auto');
  if (mode === 'appServerOnly' || mode === 'localOnly') {
    return mode;
  }

  return 'auto';
}

function getMinimumRemainingPercent(snapshot?: UsageSnapshot): number | undefined {
  return getMinimumRemainingPercentForWindows(getAllUsageWindows(snapshot));
}

async function findLowUsageSwitchCandidate(
  context: vscode.ExtensionContext,
  activeProfileId: string,
  thresholdPercent: number,
  freshnessMs: number
): Promise<LowUsageCandidate | undefined> {
  const profiles = await profileStore.listProfiles();
  const cache = getUsageCache(context);

  const candidateInputs = profiles
    .filter((profile) => profile.id !== activeProfileId)
    .flatMap((profile) => {
      const snapshot = cache[profile.id]?.snapshot;
      if (!snapshot) {
        return [];
      }

      const remainingPercent = getMinimumRemainingPercent(snapshot);
      if (remainingPercent === undefined) {
        return [];
      }

      const item: LowUsageCandidate = {
        profile,
        snapshot,
        remainingPercent
      };

      return [{
        item,
        recordedAt: snapshot.recordedAt,
        remainingPercent
      }];
    });

  const candidate = pickLowUsageCandidate(
    candidateInputs,
    thresholdPercent,
    freshnessMs
  );

  return candidate?.item;
}

async function maybeHandleLowUsageProfileSwitch(context: vscode.ExtensionContext): Promise<void> {
  if (lowUsageHandlingInProgress) {
    return;
  }

  const behavior = getLowUsageSwitchBehavior();
  if (behavior === 'off') {
    lowUsageSuggestionKey = undefined;
    if (lowUsageAutoSwitchTimer) {
      clearTimeout(lowUsageAutoSwitchTimer);
      lowUsageAutoSwitchTimer = undefined;
    }
    return;
  }

  const activeProfileId = await profileStore.getActiveProfileId();
  if (!activeProfileId) {
    return;
  }

  const activeProfile = await profileStore.getProfile(activeProfileId);
  const activeSnapshot = getUsageCache(context)[activeProfileId]?.snapshot;
  if (!activeProfile || !activeSnapshot) {
    return;
  }

  const thresholdPercent = getLowUsageSwitchThresholdPercent();
  const activeRemainingPercent = getMinimumRemainingPercent(activeSnapshot);
  if (activeRemainingPercent === undefined || activeRemainingPercent > thresholdPercent) {
    lowUsageSuggestionKey = undefined;
    if (lowUsageAutoSwitchTimer) {
      clearTimeout(lowUsageAutoSwitchTimer);
      lowUsageAutoSwitchTimer = undefined;
    }
    return;
  }

  const candidate = await findLowUsageSwitchCandidate(
    context,
    activeProfileId,
    thresholdPercent,
    getLowUsageCandidateFreshnessMs()
  );

  if (!candidate) {
    return;
  }

  const suggestionKey = [
    activeProfileId,
    candidate.profile.id,
    candidate.snapshot.recordedAt,
    Math.round(activeRemainingPercent)
  ].join(':');

  if (areProcessSafetyChecksEnabled()) {
    const runningProcesses = await listRunningCodexProcesses();
    if (runningProcesses.length) {
      const busyKey = `${suggestionKey}:busy`;
      if (lowUsageSuggestionKey !== busyKey) {
        output.appendLine(
          `Skipped low-usage profile switch while Codex appears active (${summarizeCodexProcesses(runningProcesses)}).`
        );
      }
      lowUsageSuggestionKey = busyKey;
      if (lowUsageAutoSwitchTimer) {
        clearTimeout(lowUsageAutoSwitchTimer);
        lowUsageAutoSwitchTimer = undefined;
      }
      return;
    }
  }

  if (lowUsageSuggestionKey === suggestionKey) {
    return;
  }
  lowUsageSuggestionKey = suggestionKey;

  lowUsageHandlingInProgress = true;
  try {
    const activeSummary = `${Math.round(activeRemainingPercent)}% left`;
    const candidateSummary = `${Math.round(candidate.remainingPercent)}% left`;
    const freshnessSummary = formatTimestamp(candidate.snapshot.recordedAt);

    if (behavior === 'ask') {
      const choice = await vscode.window.showWarningMessage(
        `Profile '${getProfileDisplayName(activeProfile)}' is running low on usage (${activeSummary}). Switch to '${getProfileDisplayName(candidate.profile)}'? Last known usage for that profile: ${candidateSummary}, updated ${freshnessSummary}.`,
        'Switch now',
        'Not now'
      );

      if (choice === 'Switch now') {
        await switchToProfile(candidate.profile.id, context);
      }
      return;
    }

    const countdownSeconds = getLowUsageAutoSwitchCountdownSeconds();
    const switchAction = 'Switch now';
    const cancelAction = 'Cancel';

    const prompt = vscode.window.showWarningMessage(
      `Profile '${getProfileDisplayName(activeProfile)}' is running low on usage (${activeSummary}). Switching to '${getProfileDisplayName(candidate.profile)}' in ${countdownSeconds}s unless canceled. Last known usage for that profile: ${candidateSummary}, updated ${freshnessSummary}.`,
      switchAction,
      cancelAction
    );

    const timer = setTimeout(() => {
      lowUsageAutoSwitchTimer = undefined;
      void switchToProfile(candidate.profile.id, context);
    }, countdownSeconds * 1000);
    lowUsageAutoSwitchTimer = timer;

    const choice = await prompt;
    if (lowUsageAutoSwitchTimer === timer) {
      clearTimeout(timer);
      lowUsageAutoSwitchTimer = undefined;
    }

    if (choice === switchAction) {
      await switchToProfile(candidate.profile.id, context);
    }
  } finally {
    lowUsageHandlingInProgress = false;
  }
}

function createUsageTooltip(profile: ProfileSummary, usageView: ProfileUsageView): vscode.MarkdownString {
  const snapshot = usageView.entry?.snapshot;
  const diagnostic = lastUsageRefreshDiagnostic;
  const tooltip = new vscode.MarkdownString();
  tooltip.isTrusted = true;
  tooltip.supportHtml = true;
  tooltip.supportThemeIcons = true;

  tooltip.appendMarkdown('<div align="center">\n\n');
  tooltip.appendMarkdown('## $(pulse) Codex Usage\n\n');
  tooltip.appendMarkdown('</div>\n\n');
  appendCompactProfileSummaryMarkdown(tooltip, profile, { includeProfileName: true, includeLinks: false });

  if (!snapshot) {
    tooltip.appendMarkdown('No live usage data is available yet.\n\n');
    tooltip.appendMarkdown(`**Usage status:** ${escapeMarkdown(buildUnknownUsageSummary(profile.planType))}\n\n`);
    tooltip.appendMarkdown('Prompt Codex on this profile or use refresh to pick up the next token_count update.');
    if (diagnostic) {
      tooltip.appendMarkdown(`\n\n---\n\n$(history) Refresh: ${escapeMarkdown(formatRefreshDiagnostic(diagnostic))}`);
    }
    return tooltip;
  }

  for (const descriptor of getUsageWindowDescriptors(snapshot)) {
    appendUsageSection(tooltip, `${descriptor.icon} ${descriptor.longLabel}`, descriptor.window);
  }

  if (snapshot.totalUsage || snapshot.lastUsage) {
    tooltip.appendMarkdown('---\n\n');
    tooltip.appendMarkdown('### $(graph) Token Usage\n\n');
    if (snapshot.totalUsage) {
      tooltip.appendMarkdown(`**Total:** ${formatTokenUsage(snapshot.totalUsage)}\n\n`);
    }
    if (snapshot.lastUsage) {
      tooltip.appendMarkdown(`**Last:** ${formatTokenUsage(snapshot.lastUsage)}\n\n`);
    }
  }

  tooltip.appendMarkdown('---\n\n');
  tooltip.appendMarkdown(`$(clock) Updated: ${escapeMarkdown(formatTimestamp(snapshot.recordedAt))}`);
  tooltip.appendMarkdown(`\n\n$(debug) Source: ${escapeMarkdown(formatUsageSource(snapshot.sourceFile))}`);
  if (diagnostic) {
    tooltip.appendMarkdown(`\n\n$(history) Refresh: ${escapeMarkdown(formatRefreshDiagnostic(diagnostic))}`);
  }
  tooltip.appendMarkdown(` • [Refresh](${buildCommandUri(CMD_REFRESH_USAGE)})`);
  tooltip.appendMarkdown(` • [Open OpenAI Usage](${buildCommandUri(CMD_OPEN_OPENAI_USAGE)})`);
  tooltip.appendMarkdown(' • [Show Details](command:codexAccountSwitcher.showUsageDetails)');
  tooltip.appendMarkdown(' • [Settings](command:codexAccountSwitcher.editAccounts)');

  if (usageView.isStaleForActiveProfile) {
    tooltip.appendMarkdown('\n\n$(warning) Last-known data only. Use Codex once after switching to refresh it.');
  }

  return tooltip;
}
function createUsageRefreshTooltip(snapshot?: UsageSnapshot): string {
  const diagnostic = lastUsageRefreshDiagnostic;
  const lines = ['Refresh Codex usage now.'];
  if (snapshot) {
    lines.push(`Last live update: ${formatTimestamp(snapshot.recordedAt)}.`);
  } else {
    lines.push('No live usage data has been captured yet.');
  }
  if (diagnostic) {
    lines.push(`Last refresh: ${formatRefreshDiagnostic(diagnostic)}.`);
  }
  return lines.join(' ');
}

function formatRefreshDiagnostic(diagnostic: UsageRefreshDiagnostic): string {
  const parts = [`${formatTimestamp(diagnostic.attemptedAt)}`];

  switch (diagnostic.outcome) {
    case 'updated':
      parts.push('fetched newer usage');
      break;
    case 'unchanged':
      parts.push('no newer usage data');
      break;
    case 'noData':
      parts.push('no usage data returned');
      break;
    case 'ignoredOlder':
      parts.push('ignored older pre-switch usage data');
      break;
    case 'noActiveProfile':
      parts.push('skipped because no active profile is set');
      break;
  }

  parts.push(`mode ${formatUsageSourceMode(diagnostic.sourceMode)}`);

  if (diagnostic.source) {
    parts.push(`source ${formatUsageSource(diagnostic.source)}`);
  }
  if (diagnostic.recordedAt) {
    parts.push(`snapshot ${formatTimestamp(diagnostic.recordedAt)}`);
  }

  return parts.join(' • ');
}

function formatRefreshOutcomeShort(diagnostic: UsageRefreshDiagnostic): string {
  switch (diagnostic.outcome) {
    case 'updated':
      return 'Fetched newer usage';
    case 'unchanged':
      return 'No newer usage available';
    case 'noData':
      return 'No usage data returned';
    case 'ignoredOlder':
      return 'Ignored older pre-switch snapshot';
    case 'noActiveProfile':
      return 'Skipped because no active profile is set';
  }
}

function formatUsageSource(sourceFile: string): string {
  if (sourceFile === 'experimental web usage') {
    return 'experimental web';
  }

  if (sourceFile === 'codex app-server') {
    return 'app-server';
  }

  if (!sourceFile) {
    return 'unknown';
  }

  return `session file (${path.basename(sourceFile)})`;
}

function formatUsageSourceMode(mode: UsageSourceMode): string {
  if (mode === 'appServerOnly') {
    return 'app-server only';
  }
  if (mode === 'localOnly') {
    return 'local only';
  }
  return 'auto';
}

function createActiveProfileTooltip(
  profile: ProfileSummary,
  isStaleForActiveProfile: boolean,
  pendingSwitch?: PendingSwitchState
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.isTrusted = true;
  tooltip.supportThemeIcons = true;
  tooltip.appendMarkdown(`## $(account) ${escapeMarkdown(getProfileDisplayName(profile))}\n\n`);
  appendCompactProfileSummaryMarkdown(tooltip, profile, { includeProfileName: false, includeLinks: true });

  if (pendingSwitch) {
    const reloadCommand = pendingSwitch.reloadTarget === 'window' ? CMD_RELOAD : CMD_RESTART_EXTENSION_HOST;
    tooltip.appendMarkdown(`$(sync~spin) Switch requested ${escapeMarkdown(formatTimestamp(pendingSwitch.requestedAt))}. Reload ${escapeMarkdown(pendingSwitch.reloadTarget === 'window' ? 'the window' : 'the extension host')} to fully apply it.`);
    tooltip.appendMarkdown(` • [Reload Now](${buildCommandUri(reloadCommand)})\n\n`);
  }

  tooltip.appendMarkdown(`[Switch Profiles](${buildCommandUri(CMD_SWITCH)})`);
  tooltip.appendMarkdown(' • Use the status bar item to switch Codex account/profile.');

  if (isStaleForActiveProfile) {
    tooltip.appendMarkdown('\n\n$(warning) Last-known usage for this profile is stale. Use Codex once after switching to refresh it.');
  }

  return tooltip;
}

function appendCompactProfileSummaryMarkdown(
  tooltip: vscode.MarkdownString,
  profile: ProfileSummary,
  options: { includeProfileName: boolean; includeLinks: boolean }
): void {
  const summaryParts = [
    `$(mail) ${escapeMarkdown(getProfileDisplayEmail(profile.email))}`,
    `$(account) ${escapeMarkdown(profile.planType || 'Unknown')}`
  ];

  if (options.includeProfileName) {
    summaryParts.unshift(`$(person) ${escapeMarkdown(getProfileDisplayName(profile))}`);
  }

  tooltip.appendMarkdown(`${summaryParts.join('  •  ')}\n\n`);

  if (profile.defaultOrganizationTitle) {
    tooltip.appendMarkdown(`$(organization) ${escapeMarkdown(profile.defaultOrganizationTitle)}\n\n`);
  }

  if (options.includeLinks) {
    tooltip.appendMarkdown(`[Open OpenAI Usage](${buildCommandUri(CMD_OPEN_OPENAI_USAGE)})`);
    tooltip.appendMarkdown(' • ');
    tooltip.appendMarkdown('[Manage Profiles](command:codexAccountSwitcher.manageProfiles)\n\n');
  }
}

function buildCommandUri(command: string): string {
  return `command:${command}`;
}

function appendUsageSection(tooltip: vscode.MarkdownString, title: string, window: UsageWindow): void {
  const usedPercent = window.usedPercent;
  const displayPercent = getDisplayPercentValue(window);
  const timePercent = getTimeProgressPercent(window);
  const outdated = isUsageOutdated(window);
  const usageText = outdated ? 'N/A' : `${formatDisplayPercent(window)} ${getPercentDisplaySuffixLong()}`;
  const timeText = outdated ? 'N/A' : `${timePercent.toFixed(1)}% elapsed`;
  const resetText = `${formatResetLong(window.resetsAt)}${outdated ? ' [OUTDATED]' : ''}`;

  tooltip.appendMarkdown(`<div align="center">\n\n### ${title}\n\n</div>\n\n`);
  tooltip.appendMarkdown('<table style="width:100%; border-collapse: collapse; table-layout: fixed;">\n');
  tooltip.appendMarkdown('<colgroup><col style="width:90px;"><col style="width:auto;"><col style="width:90px;"></colgroup>\n');
  tooltip.appendMarkdown(`<tr><td><strong>Usage:</strong></td><td>${createProgressBar(displayPercent, 'usage', outdated, usedPercent)}</td><td style="text-align:right;">${escapeHtml(usageText)}</td></tr>\n`);
  tooltip.appendMarkdown(`<tr><td><strong>Time:</strong></td><td>${createProgressBar(timePercent, 'time', outdated)}</td><td style="text-align:right;">${escapeHtml(timeText)}</td></tr>\n`);
  tooltip.appendMarkdown(`<tr><td colspan="3" style="padding-top:5px;"><strong>Reset:</strong> ${escapeHtml(resetText)}</td></tr>\n`);
  tooltip.appendMarkdown('</table>\n\n');
}

async function switchProfileViaPicker(context: vscode.ExtensionContext): Promise<void> {
  await maybeWarnEnsureFileBasedCreds(context);

  const profiles = await profileStore.listProfiles();
  if (!profiles.length) {
    await manageProfiles(context, 'No saved profiles yet.');
    return;
  }

  const activeProfileId = await profileStore.getActiveProfileId();
  const quickPick = vscode.window.createQuickPick<SwitcherQuickPickItem>();
  quickPick.placeholder = 'Select a Codex account/profile or action';
  quickPick.items = buildSwitcherItems(context, profiles, activeProfileId);
  quickPick.busy = true;
  quickPick.show();

  let closed = false;

  void (async () => {
    await refreshUsageAndStatus(context);
    const refreshedProfiles = await profileStore.listProfiles();
    const refreshedActiveProfileId = await profileStore.getActiveProfileId();
    if (!closed) {
      quickPick.items = buildSwitcherItems(context, refreshedProfiles, refreshedActiveProfileId);
      quickPick.busy = false;
    }
  })().catch((error) => {
    output.appendLine(`Background switcher refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!closed) {
      quickPick.busy = false;
    }
  });

  await new Promise<void>((resolve) => {
    let settled = false;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      closed = true;
      acceptDisposable.dispose();
      hideDisposable.dispose();
      quickPick.dispose();
      resolve();
    };

    const acceptDisposable = quickPick.onDidAccept(() => {
      const chosen = quickPick.selectedItems[0];
      if (!chosen || !('itemType' in chosen)) {
        return;
      }

      void (async () => {
        quickPick.hide();
        finish();
        await handleSwitcherChoice(chosen, context);
      })();
    });

    const hideDisposable = quickPick.onDidHide(() => {
      finish();
    });
  });
}

function buildSwitcherItems(
  context: vscode.ExtensionContext,
  profiles: ProfileSummary[],
  activeProfileId?: string
): SwitcherQuickPickItem[] {
  const picks: SwitcherQuickPickItem[] = profiles.map((profile) => buildProfilePick(context, profile, activeProfileId));
  picks.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  picks.push({ itemType: 'action', actionId: 'addCurrent', label: '$(add) Import current auth.json', detail: 'Create or update a profile from the currently active Codex auth file and then follow your import switch behavior setting.' });
  picks.push({ itemType: 'action', actionId: 'importFile', label: '$(folder-opened) Import auth file...', detail: 'Import a profile from an auth.json file and then follow your import switch behavior setting.' });
  picks.push({ itemType: 'action', actionId: 'login', label: '$(terminal) Login via Codex CLI...', detail: 'Run codex login in the right runtime and import it as a profile.' });
  picks.push({ itemType: 'action', actionId: 'refreshUsage', label: '$(refresh) Refresh active profile usage', detail: 'Refresh usage for the currently active profile using your configured usage source mode.' });
  picks.push({ itemType: 'action', actionId: 'reauthenticate', label: '$(sync) Reauthenticate profile...', detail: 'Run codex login and save refreshed auth back into an existing profile.' });
  picks.push({ itemType: 'action', actionId: 'refreshCurrent', label: '$(history) Update profile from current auth.json', detail: 'Persist the current auth.json into an existing saved profile without deleting it.' });
  picks.push({ itemType: 'action', actionId: 'repairProfiles', label: '$(wrench) Repair saved profiles', detail: 'Rebuild profile metadata validity from the stored profile secrets and fix broken active/last-profile references.' });
  picks.push({ itemType: 'action', actionId: 'diagnostics', label: '$(pulse) Open diagnostics', detail: 'Show resolved Codex paths, storage mode, usage source mode, watcher state, and last refresh result.' });
  picks.push({ itemType: 'action', actionId: 'rename', label: '$(edit) Rename profile...', detail: 'Rename an existing profile.' });
  picks.push({ itemType: 'action', actionId: 'delete', label: '$(trash) Delete profile...', detail: 'Delete a saved profile.' });
  picks.push({ itemType: 'action', actionId: 'exportProfiles', label: '$(export) Export profiles...', detail: 'Export saved profiles for transfer or backup.' });
  picks.push({ itemType: 'action', actionId: 'importProfiles', label: '$(cloud-upload) Import profiles...', detail: 'Import profiles from a previous export.' });
  picks.push({ itemType: 'action', actionId: 'settings', label: '$(gear) Open settings', detail: 'Edit Codex Account Switcher settings.' });
  return picks;
}

async function handleSwitcherChoice(
  chosen: ProfileQuickPickItem | ActionQuickPickItem,
  context: vscode.ExtensionContext
): Promise<void> {
  if (chosen.itemType === 'action') {
    switch (chosen.actionId) {
      case 'addCurrent':
        await addProfileFromCurrentAuth(context);
        return;
      case 'importFile':
        await importProfileFromFile(context);
        return;
      case 'login':
        await loginViaCodexCli(context);
        return;
      case 'refreshUsage':
        await refreshUsageAndStatus(context);
        return;
      case 'reauthenticate':
        await reauthenticateProfile(context);
        return;
      case 'refreshCurrent':
        await updateProfileFromCurrentAuth(context);
        return;
      case 'repairProfiles':
        await repairProfiles(context);
        return;
      case 'diagnostics':
        await showDiagnosticsPanel(context);
        return;
      case 'rename':
        await renameProfile(context);
        return;
      case 'delete':
        await deleteProfile(context);
        return;
      case 'exportProfiles':
        await exportProfiles();
        return;
      case 'importProfiles':
        await importProfiles();
        await refreshUsageAndStatus(context);
        return;
      case 'settings':
        await editSettings();
        return;
    }
  }

  await switchToProfile(chosen.profileId, context);
}

function buildProfilePick(context: vscode.ExtensionContext, profile: ProfileSummary, activeProfileId?: string): ProfileQuickPickItem {
  const usageView = getProfileUsageView(context, profile.id, activeProfileId);
  const showUsageInSwitcher = getConfig().get<boolean>(SHOW_SWITCHER_USAGE_SETTING, true);
  const summaryParts: string[] = [];

  if (profile.id === activeProfileId) {
    summaryParts.push('active');
  }
  if (profile.email && profile.email !== 'Unknown') {
    summaryParts.push(getProfileDisplayEmail(profile.email));
  }
  if (profile.planType && profile.planType !== 'Unknown') {
    summaryParts.push(profile.planType);
  }

  const detailLines: string[] = [];
  if (showUsageInSwitcher && usageView.entry?.snapshot) {
    for (const descriptor of getUsageWindowDescriptors(usageView.entry.snapshot)) {
      detailLines.push(buildPickerUsageDetailLine(`${descriptor.icon} ${descriptor.shortLabel}`, descriptor.window));
    }
  }
  if (showUsageInSwitcher && !usageView.entry) {
    detailLines.push(buildUnknownPickerDetailLine(profile.planType));
  }
  if (showUsageInSwitcher && usageView.entry?.snapshot) {
    detailLines.push(`$(debug) ${formatUsageSource(usageView.entry.snapshot.sourceFile)}`);
  }
  if (usageView.refreshDiagnostic) {
    detailLines.push(`$(history) ${formatRefreshOutcomeShort(usageView.refreshDiagnostic)}`);
  }
  if (usageView.isStaleForActiveProfile) {
    detailLines.push('$(warning) Cached snapshot is from before the current profile switch');
  }

  const description = summaryParts.join(' • ');

  return {
    itemType: 'profile',
    profileId: profile.id,
    label: getProfileDisplayName(profile),
    description,
    detail: detailLines.join('  •  ')
  };
}

function getProfileUsageView(context: vscode.ExtensionContext, profileId: string, activeProfileId?: string): ProfileUsageView {
  const entry = getUsageCache(context)[profileId];
  const history = getUsageHistory(context)[profileId] ?? [];
  const lastSwitchAt = getLastSwitchMap(context)[profileId];
  const isStaleForActiveProfile =
    !!entry &&
    !!activeProfileId &&
    profileId === activeProfileId &&
    !!lastSwitchAt &&
    parseIsoMs(entry.snapshot.recordedAt) < parseIsoMs(lastSwitchAt);

  const refreshDiagnostic = profileId === activeProfileId ? lastUsageRefreshDiagnostic : undefined;
  return { entry, history, isStaleForActiveProfile, refreshDiagnostic };
}

async function switchToProfile(profileId: string, context: vscode.ExtensionContext): Promise<void> {
  const profile = await profileStore.getProfile(profileId);
  if (!profile) {
    void vscode.window.showErrorMessage('Selected profile no longer exists.');
    return;
  }

  if (getConfig().get<boolean>('confirmBeforeSwitch', false)) {
    const choice = await vscode.window.showWarningMessage(
      `Switch Codex account/profile to '${getProfileDisplayName(profile)}'?`,
      { modal: true },
      'Switch'
    );
    if (choice !== 'Switch') {
      return;
    }
  }

  if (!(await confirmNoBusyCodexBeforeSwitch(getProfileDisplayName(profile), 'switch'))) {
    return;
  }

  await backupActiveAuthIfNeeded();

  const switched = await profileStore.setActiveProfileId(profileId);
  if (!switched) {
    void vscode.window.showErrorMessage(`Could not activate profile '${getProfileDisplayName(profile)}'.`);
    return;
  }

  await markPendingSwitchApply(context, profile);
  await setLastSwitchAt(context, profileId, new Date().toISOString());
  await refreshStatusBar(context);
  output.appendLine(`Requested profile switch to '${getProfileDisplayName(profile)}'; reload pending.`);
  await maybeOfferRememberWorkspaceProfile(context, profile);
  await maybeReloadAfterSwitch(context, getProfileDisplayName(profile));
}

async function backupActiveAuthIfNeeded(): Promise<void> {
  if (!getConfig().get<boolean>('backupActiveAuth', true)) {
    return;
  }

  const activeAuthPath = getResolvedActiveAuthPath();
  if (!(await safeExists(activeAuthPath))) {
    return;
  }

  const codexHome = path.dirname(activeAuthPath);
  const backupPath = getBackupPath(codexHome, getTimestamp());
  await fs.copyFile(activeAuthPath, backupPath);
  output.appendLine(`Backed up active auth to ${backupPath}`);
}

function hasDirtyEditors(): boolean {
  return vscode.workspace.textDocuments.some((doc) => doc.isDirty);
}

async function maybeReloadAfterSwitch(context: vscode.ExtensionContext, profileName: string): Promise<void> {
  const reloadTarget = getConfig().get<string>(RELOAD_TARGET_SETTING, 'extensionHost');

  const triggerReload = (): void => {
    setTimeout(() => {
      const command = reloadTarget === 'extensionHost' ? CMD_RESTART_EXTENSION_HOST : 'workbench.action.reloadWindow';
      void vscode.commands.executeCommand(command).then(undefined, async () => {
        if (reloadTarget !== 'extensionHost') {
          return;
        }
        output.appendLine('Restart Extension Host failed; falling back to full window reload.');
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
    }, 25);
  };

  if (hasDirtyEditors()) {
    const choice = await vscode.window.showWarningMessage(
      `Requested Codex account/profile switch to: ${profileName}. Reload is still needed to fully apply it. You have unsaved editors. Reload now?`,
      { modal: true },
      'Reload now',
      'Cancel'
    );
    if (choice === 'Reload now') {
      triggerReload();
    } else {
      void vscode.window.showInformationMessage(
        `Switch requested for Codex account/profile: ${profileName}. Reload when ready to fully apply it to running tools.`
      );
    }
    return;
  }

  void vscode.window.showInformationMessage(`Switch requested for Codex account/profile: ${profileName}. Reloading to apply it...`);
  triggerReload();
}

async function confirmDuplicateImport(duplicate: ProfileSummary, sourceLabel: string): Promise<boolean> {
  const descriptorParts = [getProfileDisplayName(duplicate)];
  if (duplicate.email && duplicate.email !== 'Unknown') {
    descriptorParts.push(getProfileDisplayEmail(duplicate.email));
  }
  if (duplicate.planType && duplicate.planType !== 'Unknown') {
    descriptorParts.push(duplicate.planType);
  }

  const choice = await vscode.window.showWarningMessage(
    `${sourceLabel} already matches saved profile '${descriptorParts.join(' • ')}'. Update that existing profile instead of creating a duplicate?`,
    { modal: true },
    'Update existing profile',
    'Cancel'
  );

  return choice === 'Update existing profile';
}

async function addProfileFromCurrentAuth(context: vscode.ExtensionContext): Promise<void> {
  const activeProfileId = await profileStore.getActiveProfileId();
  const authData = await loadAuthDataFromFile(getResolvedActiveAuthPath());
  if (!authData) {
    void vscode.window.showErrorMessage(`Could not read auth from ${getResolvedActiveAuthPath()}. Use '${getCodexLoginHintText()}' first.`);
    return;
  }
  authData.codexConfigText = await loadCodexConfigText();

  const duplicate = await profileStore.findDuplicateProfile(authData);
  let profile: ProfileSummary;

  if (duplicate) {
    const confirmed = await confirmDuplicateImport(duplicate, 'The currently active auth');
    if (!confirmed) {
      return;
    }

    await profileStore.replaceProfileAuth(duplicate.id, authData);
    profile = (await profileStore.getProfile(duplicate.id)) ?? duplicate;
  } else {
    const defaultName = inferDefaultProfileName(authData.email);
    const name = (await vscode.window.showInputBox({
      prompt: 'New profile/account name',
      value: defaultName,
      validateInput: (value) => value.trim() ? undefined : 'Name is required.'
    }))?.trim();

    if (!name) {
      return;
    }

    profile = await profileStore.createProfile(name, authData);
  }

  await finalizeImportedProfile(context, activeProfileId, profile, `${duplicate ? 'Updated' : 'Imported'} current auth as profile '${getProfileDisplayName(profile)}'.`);
}

async function importProfileFromFile(context: vscode.ExtensionContext): Promise<void> {
  const activeProfileId = await profileStore.getActiveProfileId();
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: false,
    canSelectFolders: false,
    openLabel: 'Import auth.json',
    filters: { JSON: ['json'] }
  });

  if (!selected || !selected.length) {
    return;
  }

  const authData = await loadAuthDataFromFile(selected[0].fsPath);
  if (!authData) {
    void vscode.window.showErrorMessage('Selected file is not a valid auth.json.');
    return;
  }

  const duplicate = await profileStore.findDuplicateProfile(authData);
  let profile: ProfileSummary;

  if (duplicate) {
    const confirmed = await confirmDuplicateImport(duplicate, 'The selected auth file');
    if (!confirmed) {
      return;
    }

    await profileStore.replaceProfileAuth(duplicate.id, authData);
    profile = (await profileStore.getProfile(duplicate.id)) ?? duplicate;
  } else {
    const defaultName = inferDefaultProfileName(authData.email);
    const name = (await vscode.window.showInputBox({
      prompt: 'New profile/account name',
      value: defaultName,
      validateInput: (value) => value.trim() ? undefined : 'Name is required.'
    }))?.trim();

    if (!name) {
      return;
    }

    profile = await profileStore.createProfile(name, authData);
  }

  await finalizeImportedProfile(context, activeProfileId, profile, `${duplicate ? 'Updated' : 'Imported'} auth file as profile '${getProfileDisplayName(profile)}'.`);
}

async function finalizeImportedProfile(
  context: vscode.ExtensionContext,
  activeProfileId: string | undefined,
  profile: ProfileSummary,
  baseMessage: string
): Promise<void> {
  const activationDecision = await decideImportedProfileActivation(activeProfileId, profile);

  if (!activationDecision.activate) {
    await refreshUsageAndStatus(context);
    void vscode.window.showInformationMessage(`${baseMessage} Active profile unchanged.`);
    return;
  }

  if (activeProfileId !== profile.id) {
    if (!(await confirmNoBusyCodexBeforeSwitch(getProfileDisplayName(profile), 'activate import'))) {
      return;
    }
    await profileStore.setActiveProfileId(profile.id);
    await markPendingSwitchApply(context, profile);
    await setLastSwitchAt(context, profile.id, new Date().toISOString());
    await refreshUsageAndStatus(context);
    void vscode.window.showInformationMessage(baseMessage);
    await maybeOfferRememberWorkspaceProfile(context, profile);
    await maybeReloadAfterSwitch(context, getProfileDisplayName(profile));
    return;
  }

  await refreshUsageAndStatus(context);
  void vscode.window.showInformationMessage(`${baseMessage} Active profile unchanged.`);
}

function getImportProfileSwitchBehavior(): 'ask' | 'always' | 'never' {
  const behavior = getConfig().get<string>(IMPORT_SWITCH_BEHAVIOR_SETTING, 'ask').toLowerCase();
  if (behavior === 'always' || behavior === 'never') {
    return behavior;
  }

  return 'ask';
}

async function decideImportedProfileActivation(
  activeProfileId: string | undefined,
  profile: ProfileSummary
): Promise<{ activate: boolean }> {
  const decision = getImportProfileActivationDecision(activeProfileId, profile.id, getImportProfileSwitchBehavior());
  if (decision === 'activate') {
    return { activate: true };
  }

  if (decision === 'keep') {
    return { activate: false };
  }

  const choice = await vscode.window.showInformationMessage(
    `Imported profile '${getProfileDisplayName(profile)}'. Switch to it now?`,
    'Switch now',
    'Keep current profile'
  );

  return { activate: choice === 'Switch now' };
}

async function deleteProfile(context: vscode.ExtensionContext): Promise<void> {
  const profiles = await profileStore.listProfiles();
  if (!profiles.length) {
    void vscode.window.showInformationMessage('No profiles configured.');
    return;
  }

  const pick = await vscode.window.showQuickPick(
    profiles.map((profile) => ({ label: getProfileDisplayName(profile), description: profile.email !== 'Unknown' ? getProfileDisplayEmail(profile.email) : undefined, profileId: profile.id })),
    { placeHolder: 'Select profile to delete' }
  );

  if (!pick) {
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Delete profile '${pick.label}'?`,
    { modal: true },
    'Delete'
  );

  if (confirmed !== 'Delete') {
    return;
  }

  const deleted = await profileStore.deleteProfile((pick as { profileId: string }).profileId);
  if (!deleted) {
    void vscode.window.showErrorMessage(`Could not delete profile '${pick.label}'.`);
    return;
  }

  const cache = getUsageCache(context);
  delete cache[(pick as { profileId: string }).profileId];
  await updateUsageCache(context, cache);

  const history = getUsageHistory(context);
  delete history[(pick as { profileId: string }).profileId];
  await updateUsageHistory(context, history);

  const switchMap = getLastSwitchMap(context);
  delete switchMap[(pick as { profileId: string }).profileId];
  await context.globalState.update(LAST_SWITCH_AT_KEY, switchMap);

  await refreshUsageAndStatus(context);
  void vscode.window.showInformationMessage(`Deleted profile '${pick.label}'.`);
}

async function pickProfile(placeHolder: string): Promise<ProfileSummary | undefined> {
  const profiles = await profileStore.listProfiles();
  if (!profiles.length) {
    void vscode.window.showInformationMessage('No profiles configured.');
    return undefined;
  }

  const pick = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: getProfileDisplayName(profile),
      description: profile.email !== 'Unknown' ? getProfileDisplayEmail(profile.email) : undefined,
      detail: profile.planType && profile.planType !== 'Unknown' ? profile.planType : undefined,
      profileId: profile.id
    })),
    { placeHolder }
  );

  if (!pick) {
    return undefined;
  }

  return profileStore.getProfile((pick as { profileId: string }).profileId);
}

async function updateStoredProfileFromCurrentAuth(targetProfile: ProfileSummary): Promise<{ authData: import('./auth').AuthData; duplicateProfile?: ProfileSummary }> {
  const authData = await loadAuthDataFromFile(getResolvedActiveAuthPath());
  if (!authData) {
    throw new Error(`Could not read auth from ${getResolvedActiveAuthPath()}. Use '${getCodexLoginHintText()}' first.`);
  }
  authData.codexConfigText = await loadCodexConfigText();

  const duplicate = await profileStore.findDuplicateProfile(authData);
  if (duplicate && duplicate.id !== targetProfile.id) {
    const duplicateLabel = duplicate.email && duplicate.email !== 'Unknown'
      ? `${getProfileDisplayName(duplicate)} (${getProfileDisplayEmail(duplicate.email)})`
      : getProfileDisplayName(duplicate);
    throw new Error(`Current auth already matches saved profile '${duplicateLabel}'. Log into the intended account/profile first or update that matching profile instead.`);
  }

  if (targetProfile.email !== 'Unknown' && authData.email !== 'Unknown' && targetProfile.email.toLowerCase() !== authData.email.toLowerCase()) {
    throw new Error(`Current auth belongs to '${getProfileDisplayEmail(authData.email)}', but target profile '${getProfileDisplayName(targetProfile)}' expects '${getProfileDisplayEmail(targetProfile.email)}'. Reauthenticate the correct account and try again.`);
  }

  const replaced = await profileStore.replaceProfileAuth(targetProfile.id, authData);
  if (!replaced) {
    throw new Error(`Could not update profile '${getProfileDisplayName(targetProfile)}'.`);
  }

  return { authData, duplicateProfile: duplicate ?? undefined };
}

async function updateProfileFromCurrentAuth(context: vscode.ExtensionContext): Promise<void> {
  const targetProfile = await pickProfile('Select profile to update from the current auth.json');
  if (!targetProfile) {
    return;
  }

  try {
    await updateStoredProfileFromCurrentAuth(targetProfile);
    await refreshUsageAndStatus(context);
    void vscode.window.showInformationMessage(`Updated profile '${getProfileDisplayName(targetProfile)}' from the current auth.json.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown update error.';
    void vscode.window.showErrorMessage(message);
  }
}

async function reauthenticateProfile(context: vscode.ExtensionContext): Promise<void> {
  const targetProfile = await pickProfile('Select profile to reauthenticate');
  if (!targetProfile) {
    return;
  }

  const loginSpec = await getCodexCliLaunchSpec();
  const proceed = await vscode.window.showInformationMessage(
    `Reauthenticate '${getProfileDisplayName(targetProfile)}' using ${loginSpec.displayText}. When login finishes, the refreshed auth will be saved back into this profile and it will become the active profile.`,
    'Continue',
    'Cancel'
  );

  if (proceed !== 'Continue') {
    return;
  }

  const authPath = getResolvedActiveAuthPath();

  const terminal = vscode.window.createTerminal({
    name: 'Codex Login',
    shellPath: loginSpec.shellPath,
    shellArgs: loginSpec.shellArgs
  });
  terminal.show();

  let watcher: fscore.FSWatcher | undefined;
  let handled = false;
  const cleanup = (): void => {
    try {
      watcher?.close();
    } catch {
      // ignore
    }
  };

  const finalize = async (): Promise<void> => {
    if (handled) {
      return;
    }
    handled = true;
    cleanup();

    try {
      await updateStoredProfileFromCurrentAuth(targetProfile);
      if (!(await confirmNoBusyCodexBeforeSwitch(getProfileDisplayName(targetProfile), 'activate reauthentication'))) {
        return;
      }
      await profileStore.setActiveProfileId(targetProfile.id);
      await markPendingSwitchApply(context, targetProfile);
      await setLastSwitchAt(context, targetProfile.id, new Date().toISOString());
      await refreshUsageAndStatus(context);
      output.appendLine(`Reauthenticated profile '${getProfileDisplayName(targetProfile)}'`);
      await maybeOfferRememberWorkspaceProfile(context, targetProfile);
      await maybeReloadAfterSwitch(context, getProfileDisplayName(targetProfile));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown reauthentication error.';
      void vscode.window.showErrorMessage(message);
    }
  };

  try {
    watcher = fscore.watch(path.dirname(authPath), async (_event, filename) => {
      if (!filename || String(filename).toLowerCase() !== path.basename(authPath).toLowerCase()) {
        return;
      }
      if (await safeExists(authPath)) {
        await finalize();
      }
    });
  } catch {
    output.appendLine(`Could not watch ${authPath} for reauthentication completion.`);
  }

  const selection = await vscode.window.showInformationMessage(
    `After completing ${loginSpec.displayText}, save the refreshed auth back into '${getProfileDisplayName(targetProfile)}'.`,
    'Save refreshed auth',
    'Manage profiles'
  );

  if (selection === 'Save refreshed auth') {
    await finalize();
  } else if (selection === 'Manage profiles') {
    cleanup();
    await manageProfiles(context);
  } else {
    setTimeout(() => cleanup(), 10 * 60 * 1000);
  }
}

async function renameProfile(context: vscode.ExtensionContext): Promise<void> {
  const profiles = await profileStore.listProfiles();
  if (!profiles.length) {
    void vscode.window.showInformationMessage('No profiles configured.');
    return;
  }

  const pick = await vscode.window.showQuickPick(
    profiles.map((profile) => ({ label: getProfileDisplayName(profile), description: profile.email !== 'Unknown' ? getProfileDisplayEmail(profile.email) : undefined, profileId: profile.id })),
    { placeHolder: 'Select profile to rename' }
  );

  if (!pick) {
    return;
  }

  const nextName = (await vscode.window.showInputBox({
    prompt: 'New profile/account name',
    value: shouldMaskProfileNames() ? '' : pick.label,
    validateInput: (value) => value.trim() ? undefined : 'Name is required.'
  }))?.trim();

  if (!nextName) {
    return;
  }

  await profileStore.renameProfile((pick as { profileId: string }).profileId, nextName);
  await refreshUsageAndStatus(context);
  void vscode.window.showInformationMessage(`Renamed profile to '${nextName}'.`);
}

async function editSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', 'codexAccountSwitcher');
  const openJson = await vscode.window.showQuickPick(['Open settings.json', 'Done'], {
    placeHolder: 'Optional: open raw JSON settings file'
  });

  if (openJson === 'Open settings.json') {
    await vscode.commands.executeCommand('workbench.action.openSettingsJson');
  }
}

async function manageProfiles(context: vscode.ExtensionContext, placeholder = 'Manage Codex account and profile switching'): Promise<void> {
  const action = await vscode.window.showQuickPick(
    [
      { label: 'Login via Codex CLI...', actionId: 'login' },
      { label: 'Import current auth.json', description: 'Follows your import switch behavior setting', actionId: 'addCurrent' },
      { label: 'Import auth file...', description: 'Follows your import switch behavior setting', actionId: 'importFile' },
      { label: 'Switch profile', actionId: 'switch' },
      { label: 'Refresh active profile usage', actionId: 'refreshUsage' },
      { label: 'Reauthenticate profile', actionId: 'reauthenticate' },
      { label: 'Update profile from current auth.json', actionId: 'refreshCurrent' },
      { label: 'Repair saved profiles', actionId: 'repairProfiles' },
      { label: 'Open diagnostics', actionId: 'diagnostics' },
      { label: 'Rename profile', actionId: 'rename' },
      { label: 'Delete profile', actionId: 'delete' },
      { label: 'Export profiles...', actionId: 'exportProfiles' },
      { label: 'Import profiles...', actionId: 'importProfiles' },
      { label: 'Open settings', actionId: 'settings' }
    ],
    { placeHolder: placeholder }
  );

  if (!action) {
    return;
  }

  switch (action.actionId) {
    case 'login':
      await loginViaCodexCli(context);
      return;
    case 'addCurrent':
      await addProfileFromCurrentAuth(context);
      return;
    case 'importFile':
      await importProfileFromFile(context);
      return;
    case 'switch':
      await switchProfileViaPicker(context);
      return;
    case 'refreshUsage':
      await refreshUsageAndStatus(context);
      return;
    case 'reauthenticate':
      await reauthenticateProfile(context);
      return;
    case 'refreshCurrent':
      await updateProfileFromCurrentAuth(context);
      return;
    case 'repairProfiles':
      await repairProfiles(context);
      return;
    case 'diagnostics':
      await showDiagnosticsPanel(context);
      return;
    case 'rename':
      await renameProfile(context);
      return;
    case 'delete':
      await deleteProfile(context);
      return;
    case 'exportProfiles':
      await exportProfiles();
      return;
    case 'importProfiles':
      await importProfiles();
      return;
    case 'settings':
      await editSettings();
      return;
  }
}

async function loginViaCodexCli(context: vscode.ExtensionContext): Promise<void> {
  const authPath = getResolvedActiveAuthPath();
  const loginSpec = await getCodexCliLaunchSpec();

  const terminal = vscode.window.createTerminal({
    name: 'Codex Login',
    shellPath: loginSpec.shellPath,
    shellArgs: loginSpec.shellArgs
  });
  terminal.show();

  let watcher: fscore.FSWatcher | undefined;
  const cleanup = (): void => {
    try {
      watcher?.close();
    } catch {
      // ignore
    }
  };

  const promptImport = async (): Promise<void> => {
    cleanup();
    const choice = await vscode.window.showInformationMessage(
      `Codex auth file detected at ${authPath}. Import it as a profile now?`,
      'Import now'
    );
    if (choice === 'Import now') {
      await addProfileFromCurrentAuth(context);
    }
  };

  try {
    watcher = fscore.watch(path.dirname(authPath), async (_event, filename) => {
      if (!filename || String(filename).toLowerCase() !== path.basename(authPath).toLowerCase()) {
        return;
      }
      if (await safeExists(authPath)) {
        await promptImport();
      }
    });
  } catch {
    output.appendLine(`Could not watch ${authPath} for login completion.`);
  }

  const selection = await vscode.window.showInformationMessage(
    `After completing ${loginSpec.displayText}, import the current environment auth.json from ${authPath}.`,
    'Import now',
    'Manage profiles'
  );

  if (selection === 'Import now') {
    cleanup();
    await addProfileFromCurrentAuth(context);
  } else if (selection === 'Manage profiles') {
    cleanup();
    await manageProfiles(context);
  } else {
    setTimeout(() => cleanup(), 10 * 60 * 1000);
  }
}

type UsagePanelProfile = {
  id: string;
  name: string;
  email: string;
  planType?: string;
  snapshot?: UsageSnapshot;
  history: UsageHistorySample[];
  isStale: boolean;
  isActive: boolean;
  sourceLabel: string;
  refreshStatus?: string;
  updatedLabel: string;
};

function sanitizeTokenUsageForPanel(usage: TokenUsage | undefined): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const values = [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
    usage.totalTokens
  ];
  if (values.some((value) => !Number.isFinite(value))) {
    return undefined;
  }

  return usage;
}

function sanitizeUsageWindowForPanel(window: UsageWindow | undefined): UsageWindow | undefined {
  if (!window) {
    return undefined;
  }

  if (
    !Number.isFinite(window.usedPercent) ||
    !Number.isFinite(window.windowMinutes) ||
    !Number.isFinite(parseIsoMs(window.resetsAt))
  ) {
    return undefined;
  }

  return window;
}

function sanitizeUsageSnapshotForPanel(snapshot: UsageSnapshot | undefined): UsageSnapshot | undefined {
  if (!snapshot || !Number.isFinite(parseIsoMs(snapshot.recordedAt))) {
    return undefined;
  }

  const primary = sanitizeUsageWindowForPanel(snapshot.primary);
  const secondary = sanitizeUsageWindowForPanel(snapshot.secondary);
  if (!primary && !secondary) {
    return undefined;
  }

  return {
    ...snapshot,
    primary,
    secondary,
    totalUsage: sanitizeTokenUsageForPanel(snapshot.totalUsage),
    lastUsage: sanitizeTokenUsageForPanel(snapshot.lastUsage)
  };
}

function sanitizeUsageHistorySamplesForPanel(history: UsageHistorySample[]): UsageHistorySample[] {
  return history.filter((sample) => {
    if (!Number.isFinite(parseIsoMs(sample.recordedAt))) {
      return false;
    }

    const numericValues = [sample.primaryUsedPercent, sample.secondaryUsedPercent]
      .filter((value): value is number => value !== undefined);
    if (numericValues.some((value) => !Number.isFinite(value))) {
      return false;
    }

    return true;
  }).map((sample) => ({
    ...sample,
    totalUsage: sanitizeTokenUsageForPanel(sample.totalUsage),
    lastUsage: sanitizeTokenUsageForPanel(sample.lastUsage)
  }));
}

async function buildUsagePanelProfiles(context: vscode.ExtensionContext, activeProfileId: string): Promise<UsagePanelProfile[]> {
  const profiles = await profileStore.listProfiles();
  return profiles.map((profile) => {
    const usageView = getProfileUsageView(context, profile.id, activeProfileId);
    const sanitizedSnapshot = sanitizeUsageSnapshotForPanel(usageView.entry?.snapshot);
    const sanitizedHistory = sanitizeUsageHistorySamplesForPanel(usageView.history);
    return {
      id: profile.id,
      name: getProfileDisplayName(profile),
      email: getProfileDisplayEmail(profile.email),
      planType: profile.planType,
      snapshot: sanitizedSnapshot,
      history: sanitizedHistory,
      isStale: usageView.isStaleForActiveProfile,
      isActive: profile.id === activeProfileId,
      sourceLabel: sanitizedSnapshot ? formatUsageSource(sanitizedSnapshot.sourceFile) : 'unknown',
      refreshStatus: usageView.refreshDiagnostic ? formatRefreshOutcomeShort(usageView.refreshDiagnostic) : undefined,
      updatedLabel: sanitizedSnapshot ? formatTimestamp(sanitizedSnapshot.recordedAt) : 'No cached usage'
    };
  });
}

async function showUsageDetailsPanel(context: vscode.ExtensionContext): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'codexAccountSwitcherUsage',
    'Codex Usage Details',
    vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
    { enableScripts: true }
  );

  let selectedCompareProfileId = '';
  let selectedHistoryRange: UsageHistoryRange = 'week';

  const renderPanel = async (): Promise<void> => {
    const activeProfileId = await profileStore.getActiveProfileId();
    const activeProfile = activeProfileId ? await profileStore.getProfile(activeProfileId) : undefined;
    if (!activeProfileId || !activeProfile) {
      panel.webview.html = buildUsageDetailsEmptyHtml('No profile selected', 'Save or switch to a Codex profile first.');
      return;
    }

    const panelProfiles = await buildUsagePanelProfiles(context, activeProfileId);
    const activePanelProfile = panelProfiles.find((profile) => profile.id === activeProfileId);
    if (!activePanelProfile) {
      panel.webview.html = buildUsageDetailsEmptyHtml('No profile selected', 'Save or switch to a Codex profile first.');
      return;
    }

    selectedCompareProfileId = resolveUsageDetailsCompareProfileId(panelProfiles, activePanelProfile.id, selectedCompareProfileId);
    panel.webview.html = buildUsageDetailsHtml(panel.webview, activePanelProfile, panelProfiles, {
      compareProfileId: selectedCompareProfileId,
      historyRange: selectedHistoryRange
    });
  };

  await renderPanel();

  panel.webview.onDidReceiveMessage(async (message) => {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'switchProfile' && typeof message.profileId === 'string') {
      await switchToProfile(message.profileId, context);
      panel.dispose();
      return;
    }

    if (message.type === 'setCompareProfile' && typeof message.profileId === 'string') {
      selectedCompareProfileId = message.profileId;
      await renderPanel();
      return;
    }

    if (message.type === 'setHistoryRange') {
      selectedHistoryRange = coerceUsageHistoryRange(message.historyRange);
      await renderPanel();
      return;
    }

    if (message.type === 'refreshUsage') {
      await refreshUsageAndStatus(context);
      await renderPanel();
    }
  });
}

type UsageHistoryRange = 'day' | 'week' | 'month' | 'year';
type UsageDetailsPanelState = {
  compareProfileId: string;
  historyRange: UsageHistoryRange;
};

function createWebviewNonce(): string {
  return randomBytes(16).toString('base64');
}

function coerceUsageHistoryRange(value: unknown): UsageHistoryRange {
  if (value === 'day' || value === 'month' || value === 'year') {
    return value;
  }

  return 'week';
}

function resolveUsageDetailsCompareProfileId(
  profiles: UsagePanelProfile[],
  activeProfileId: string,
  preferredProfileId?: string
): string {
  const compareCandidates = profiles.filter((profile) => profile.id !== activeProfileId);
  if (!compareCandidates.length) {
    return activeProfileId;
  }

  if (preferredProfileId && compareCandidates.some((profile) => profile.id === preferredProfileId)) {
    return preferredProfileId;
  }

  return compareCandidates[0]?.id ?? activeProfileId;
}

function buildUsageDetailsEmptyHtml(title: string, message: string): string {
  return `<!DOCTYPE html>
  <html>
    <body style="font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background);">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
    </body>
  </html>`;
}

function buildUsageDetailsHtml(
  webview: vscode.Webview,
  activeProfile: UsagePanelProfile,
  profiles: UsagePanelProfile[],
  panelState: UsageDetailsPanelState
): string {
  const { warning: warningColor, critical: criticalColor } = getSeverityColors();
  const nonce = createWebviewNonce();
  const compareProfileId = resolveUsageDetailsCompareProfileId(profiles, activeProfile.id, panelState.compareProfileId);
  const compareProfile = profiles.find((profile) => profile.id === compareProfileId) ?? activeProfile;
  const historyRange = coerceUsageHistoryRange(panelState.historyRange);
  const compareCandidates = profiles.filter((profile) => profile.id !== activeProfile.id);

  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8" />
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
      <style>
        body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); margin: 0; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: end; gap: 16px; border: 1px solid var(--vscode-panel-border); border-radius: 12px; padding: 18px 20px; margin-bottom: 20px; background: linear-gradient(135deg, rgba(72, 110, 192, 0.12), rgba(16, 16, 16, 0)); }
        .brand { display: grid; gap: 6px; }
        .eyebrow { color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; }
        .brand-title { font-size: 30px; font-weight: 800; line-height: 1; }
        .brand-copy { color: var(--vscode-descriptionForeground); max-width: 760px; line-height: 1.4; }
        .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-left: auto; justify-content: flex-end; }
        .toolbar label, .compare-select-wrap label { font-weight: 600; font-size: 12px; color: var(--vscode-descriptionForeground); }
        select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 6px; padding: 6px 8px; min-width: 160px; }
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 6px; padding: 7px 12px; cursor: pointer; }
        button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        button:disabled { opacity: 0.55; cursor: default; }
        .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
        .card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 16px; background: var(--vscode-panel-background); }
        .card-header { display: flex; justify-content: space-between; align-items: start; gap: 12px; margin-bottom: 14px; }
        .card-header-inline { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
        .card-title { margin: 0; font-size: 18px; }
        .card-subtitle { margin: 4px 0 0 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
        .pill { display: inline-flex; align-items: center; border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 3px 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
        .pill.active { background: rgba(76, 175, 80, 0.15); }
        .pill.compare { background: rgba(156, 39, 176, 0.15); }
        .section { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 14px; margin-bottom: 14px; background: rgba(128,128,128,0.04); }
        .section-title { font-weight: 700; margin-bottom: 12px; }
        .row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
        .label { width: 70px; font-weight: 600; }
        .track { flex: 1; height: 18px; background: rgba(128,128,128,0.2); border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
        .fill { height: 100%; background: #4CAF50; }
        .fill.medium { background: ${warningColor}; }
        .fill.high { background: ${criticalColor}; }
        .fill.time { background: #9C27B0; }
        .fill.outdated { background: #666; }
        .value { width: 84px; text-align: right; font-weight: 700; }
        .details { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 8px; }
        .tokens { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 14px; background: rgba(128,128,128,0.04); }
        .history { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 14px; margin-bottom: 14px; background: rgba(128,128,128,0.04); }
        .history-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
        .stat { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; }
        .stat-label { color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
        .stat-value { font-weight: 700; }
        .history-detail-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
        .history-detail { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; background: rgba(255,255,255,0.03); }
        .chart-wrap { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; background: rgba(0,0,0,0.08); }
        .chart-footer { display: flex; justify-content: space-between; gap: 10px; color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 10px; }
        .chart-legend { display: flex; gap: 14px; flex-wrap: wrap; color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 10px; }
        .legend-chip { display: inline-flex; align-items: center; gap: 6px; }
        .legend-line { width: 18px; height: 3px; border-radius: 999px; }
        .samples { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-top: 12px; overflow: hidden; }
        .samples-header, .samples-row { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(72px, 0.8fr) minmax(72px, 0.8fr) minmax(0, 1fr); gap: 10px; padding: 8px 10px; font-size: 12px; }
        .samples-header { background: rgba(255,255,255,0.04); color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.04em; font-size: 11px; }
        .samples-row { border-top: 1px solid var(--vscode-panel-border); }
        .samples-row strong { font-weight: 700; }
        .warning { margin-top: 12px; color: var(--vscode-editorWarning-foreground); font-weight: 600; }
        .empty { border: 1px dashed var(--vscode-panel-border); border-radius: 8px; padding: 16px; color: var(--vscode-descriptionForeground); }
        .provenance { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; background: rgba(128,128,128,0.04); }
        .provenance-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
        .provenance-label { color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
        .provenance-value { font-weight: 600; font-size: 12px; line-height: 1.4; }
        .compare-select-wrap { display: grid; gap: 6px; }
        .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
        @media (max-width: 980px) { .columns { grid-template-columns: 1fr; } .header { justify-content: flex-start; flex-direction: column; align-items: stretch; } .toolbar { margin-left: 0; justify-content: flex-start; } .provenance-grid, .history-detail-grid { grid-template-columns: 1fr; } .samples-header, .samples-row { grid-template-columns: minmax(0, 1.4fr) minmax(64px, 0.7fr) minmax(64px, 0.7fr); } .samples-header > :last-child, .samples-row > :last-child { display: none; } }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="brand">
            <div class="eyebrow">Usage Details</div>
            <div class="brand-title">Codex Usage Dashboard</div>
            <div class="brand-copy">Live limits, reset timing, token context, and side-by-side history views with the extra chart detail requested in issue #12.</div>
          </div>
          <div class="toolbar">
            <label for="historyRange">History</label>
            <select id="historyRange">
              ${renderUsageHistoryRangeOption('day', historyRange, 'Daily')}
              ${renderUsageHistoryRangeOption('week', historyRange, 'Weekly')}
              ${renderUsageHistoryRangeOption('month', historyRange, 'Monthly')}
              ${renderUsageHistoryRangeOption('year', historyRange, 'Yearly')}
            </select>
          </div>
        </div>
        <div class="columns">
          ${renderUsageDetailsCard(activeProfile, {
            roleLabel: 'Current',
            roleClass: 'active',
            isCompareColumn: false,
            compareCandidates,
            selectedCompareProfileId: compareProfileId,
            historyRange,
            warningColor,
            criticalColor
          })}
          ${renderUsageDetailsCard(compareProfile, {
            roleLabel: compareProfile.id === activeProfile.id ? 'Same Profile' : 'Compare',
            roleClass: 'compare',
            isCompareColumn: true,
            compareCandidates,
            selectedCompareProfileId: compareProfileId,
            historyRange,
            warningColor,
            criticalColor,
            activeProfileId: activeProfile.id
          })}
        </div>
      </div>
      <script nonce="${nonce}">
        try {
          const vscode = acquireVsCodeApi();
          const historyRangeSelect = document.getElementById('historyRange');
          const compareProfileInline = document.getElementById('compareProfileInline');
          const switchProfileInline = document.getElementById('switchProfileInline');
          const refreshProfileInline = document.getElementById('refreshProfileInline');

          if (historyRangeSelect) {
            historyRangeSelect.addEventListener('change', (event) => {
              vscode.postMessage({ type: 'setHistoryRange', historyRange: event.target.value });
            });
          }
          if (compareProfileInline) {
            compareProfileInline.addEventListener('change', (event) => {
              vscode.postMessage({ type: 'setCompareProfile', profileId: event.target.value });
            });
          }
          if (switchProfileInline) {
            switchProfileInline.addEventListener('click', () => {
              const profileId = switchProfileInline.dataset.profileId;
              if (profileId) {
                vscode.postMessage({ type: 'switchProfile', profileId });
              }
            });
          }
          if (refreshProfileInline) {
            refreshProfileInline.addEventListener('click', () => {
              vscode.postMessage({ type: 'refreshUsage' });
            });
          }
        } catch (error) {
          console.error('Codex usage details render failed', error);
        }
      </script>
    </body>
  </html>`;
}

function renderUsageHistoryRangeOption(value: UsageHistoryRange, selected: UsageHistoryRange, label: string): string {
  return `<option value="${escapeHtml(value)}"${selected === value ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

function getUsageHistoryRangeWindowMs(range: UsageHistoryRange): number {
  switch (range) {
    case 'day':
      return 24 * 60 * 60 * 1000;
    case 'month':
      return 31 * 24 * 60 * 60 * 1000;
    case 'year':
      return 366 * 24 * 60 * 60 * 1000;
    default:
      return 7 * 24 * 60 * 60 * 1000;
  }
}

function formatUsageHistoryRangeLabel(range: UsageHistoryRange): string {
  switch (range) {
    case 'day':
      return 'Daily';
    case 'month':
      return 'Monthly';
    case 'year':
      return 'Yearly';
    default:
      return 'Weekly';
  }
}

function getUsageHistorySamplesForRange(history: UsageHistorySample[], range: UsageHistoryRange): UsageHistorySample[] {
  const threshold = Date.now() - getUsageHistoryRangeWindowMs(range);
  return history.filter((sample) => {
    const recordedAtMs = parseIsoMs(sample.recordedAt);
    return Number.isFinite(recordedAtMs) && recordedAtMs >= threshold;
  });
}

function formatPercentValue(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}%` : `${rounded.toFixed(1)}%`;
}

function getUsageHistorySourceLabel(sourceFile?: string): string {
  if (!sourceFile) {
    return 'unknown';
  }
  if (sourceFile === 'codex app-server') {
    return 'app-server';
  }
  if (sourceFile === 'experimental web usage') {
    return 'experimental web';
  }
  return 'session file';
}

function buildUsageHistoryPointList(
  samples: UsageHistorySample[],
  key: 'primaryUsedPercent' | 'secondaryUsedPercent'
): Array<{ sample: UsageHistorySample; value: number; recordedAtMs: number }> {
  return samples.flatMap((sample) => {
    const value = sample[key];
    const recordedAtMs = parseIsoMs(sample.recordedAt);
    return typeof value === 'number' && Number.isFinite(recordedAtMs)
      ? [{ sample, value, recordedAtMs }]
      : [];
  });
}

function formatUsageHistoryTooltip(sample: UsageHistorySample, label: string, value: number): string {
  const lines = [
    `${label}: ${formatPercentValue(value)} used`,
    `Recorded: ${formatTimestamp(sample.recordedAt)}`
  ];

  if (typeof sample.primaryUsedPercent === 'number') {
    lines.push(`5H: ${formatPercentValue(sample.primaryUsedPercent)} used`);
  }
  if (typeof sample.secondaryUsedPercent === 'number') {
    lines.push(`Weekly: ${formatPercentValue(sample.secondaryUsedPercent)} used`);
  }
  if (sample.lastUsage) {
    lines.push(`Last tokens: ${formatTokenUsage(sample.lastUsage)}`);
  }
  if (sample.totalUsage) {
    lines.push(`Total tokens: ${formatTokenUsage(sample.totalUsage)}`);
  }
  if (sample.sourceFile) {
    lines.push(`Source: ${getUsageHistorySourceLabel(sample.sourceFile)}`);
    const contextLabel = getUsageHistoryContextLabel(sample.sourceFile);
    if (contextLabel) {
      lines.push(`Context: ${contextLabel}`);
    }
  }

  return lines.join('\n');
}

function getUsageHistoryContextLabel(sourceFile?: string): string | undefined {
  if (!sourceFile) {
    return undefined;
  }

  if (sourceFile === 'codex app-server') {
    return 'Live app-server snapshot';
  }
  if (sourceFile === 'experimental web usage') {
    return 'Experimental web snapshot';
  }

  const fileName = path.basename(sourceFile);
  return fileName ? `Session file ${fileName}` : 'Local session file';
}

function formatCompactTokenCount(value: number): string {
  if (!Number.isFinite(value)) {
    return 'Unknown';
  }

  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}K`;
  }

  return Math.round(value).toLocaleString('en-US');
}

function getUsageHistoryPointX(recordedAtMs: number, startMs: number, endMs: number, width: number): number {
  if (!Number.isFinite(recordedAtMs)) {
    return 0;
  }

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 0;
  }

  return Math.round((((recordedAtMs - startMs) / (endMs - startMs)) * width) * 100) / 100;
}

function buildUsageHistorySparklinePath(
  points: Array<{ sample: UsageHistorySample; value: number; recordedAtMs: number }>,
  width: number,
  height: number,
  startMs: number,
  endMs: number
): string {
  if (!points.length) {
    return '';
  }

  return points.map((point, index) => {
    const x = getUsageHistoryPointX(point.recordedAtMs, startMs, endMs, width);
    const y = Math.round((height - ((Math.max(0, Math.min(100, point.value)) / 100) * height)) * 100) / 100;
    return `${index === 0 ? 'M' : 'L'}${x} ${y}`;
  }).join(' ');
}

function renderUsageHistoryPoints(
  points: Array<{ sample: UsageHistorySample; value: number; recordedAtMs: number }>,
  width: number,
  height: number,
  color: string,
  label: string,
  startMs: number,
  endMs: number
): string {
  if (!points.length) {
    return '';
  }

  return points.map((point) => {
    const x = getUsageHistoryPointX(point.recordedAtMs, startMs, endMs, width);
    const y = Math.round((height - ((Math.max(0, Math.min(100, point.value)) / 100) * height)) * 100) / 100;
    return `<circle cx="${x}" cy="${y}" r="4" fill="${escapeHtml(color)}"><title>${escapeHtml(formatUsageHistoryTooltip(point.sample, label, point.value))}</title></circle>`;
  }).join('');
}

function renderUsageRecentSamples(samples: UsageHistorySample[]): string {
  const recentSamples = [...samples].slice(-5).reverse();
  const rows = recentSamples.map((sample) => {
    const primary = typeof sample.primaryUsedPercent === 'number' ? formatPercentValue(sample.primaryUsedPercent) : '—';
    const secondary = typeof sample.secondaryUsedPercent === 'number' ? formatPercentValue(sample.secondaryUsedPercent) : '—';
    const title = escapeHtmlAttribute(formatUsageHistoryTooltip(
      sample,
      typeof sample.primaryUsedPercent === 'number' ? '5H' : typeof sample.secondaryUsedPercent === 'number' ? 'Weekly' : 'Usage',
      typeof sample.primaryUsedPercent === 'number' ? sample.primaryUsedPercent : sample.secondaryUsedPercent ?? 0
    ));
    return `<div class="samples-row" title="${title}">
      <div><strong>${escapeHtml(formatTimestamp(sample.recordedAt))}</strong></div>
      <div>${escapeHtml(primary)}</div>
      <div>${escapeHtml(secondary)}</div>
      <div>${escapeHtml(getUsageHistorySourceLabel(sample.sourceFile))}</div>
    </div>`;
  }).join('');

  return `<div class="samples">
    <div class="samples-header"><div>Recorded</div><div>5H</div><div>Week</div><div>Source</div></div>
    ${rows}
  </div>`;
}

function renderUsageHistoryLatestSampleDetails(sample: UsageHistorySample): string {
  const details = [
    {
      label: 'Recorded',
      value: formatTimestamp(sample.recordedAt)
    },
    {
      label: 'Source',
      value: getUsageHistorySourceLabel(sample.sourceFile)
    },
    {
      label: 'Context',
      value: getUsageHistoryContextLabel(sample.sourceFile) ?? 'No extra context'
    },
    {
      label: '5H Used',
      value: typeof sample.primaryUsedPercent === 'number' ? formatPercentValue(sample.primaryUsedPercent) : 'Unknown'
    },
    {
      label: 'Weekly Used',
      value: typeof sample.secondaryUsedPercent === 'number' ? formatPercentValue(sample.secondaryUsedPercent) : 'Unknown'
    },
    {
      label: 'Last Tokens',
      value: sample.lastUsage ? formatCompactTokenCount(sample.lastUsage.totalTokens) : 'Unknown'
    },
    {
      label: 'Total Tokens',
      value: sample.totalUsage ? formatCompactTokenCount(sample.totalUsage.totalTokens) : 'Unknown'
    }
  ];

  return `<div class="history-detail-grid">
    ${details.map((detail) => `<div class="history-detail"><div class="stat-label">${escapeHtml(detail.label)}</div><div class="stat-value">${escapeHtml(detail.value)}</div></div>`).join('')}
  </div>`;
}

function renderUsageHistorySection(profile: UsagePanelProfile, historyRange: UsageHistoryRange): string {
  const samples = getUsageHistorySamplesForRange(profile.history, historyRange);
  if (!samples.length) {
    return '<section class="history"><div class="section-title">Usage History</div><div class="empty">No historical samples yet. Remaining usage is unknown until Codex emits fresh usage data.</div></section>';
  }

  const fiveHourPoints = buildUsageHistoryPointList(samples, 'primaryUsedPercent');
  const weeklyPoints = buildUsageHistoryPointList(samples, 'secondaryUsedPercent');
  const latestSample = samples[samples.length - 1];
  const startMs = parseIsoMs(samples[0]?.recordedAt);
  const endMs = parseIsoMs(samples[samples.length - 1]?.recordedAt);
  const chartWidth = 500;
  const chartHeight = 180;
  const chartOffsetLeft = 36;
  const chartOffsetBottom = 26;
  const svgWidth = chartWidth + chartOffsetLeft;
  const svgHeight = chartHeight + chartOffsetBottom;
  const axisLevels = [100, 75, 50, 25, 0];
  const historySeries = [
    fiveHourPoints.length
        ? {
          label: '5H',
          statLabel: 'Peak 5H Used',
          color: '#4CAF50',
          peak: Math.max(...fiveHourPoints.map((point) => point.value)),
          path: buildUsageHistorySparklinePath(fiveHourPoints, chartWidth, chartHeight, startMs, endMs),
          points: fiveHourPoints
        }
      : undefined,
    weeklyPoints.length
        ? {
          label: 'Weekly',
          statLabel: 'Peak Weekly Used',
          color: '#2196F3',
          peak: Math.max(...weeklyPoints.map((point) => point.value)),
          path: buildUsageHistorySparklinePath(weeklyPoints, chartWidth, chartHeight, startMs, endMs),
          points: weeklyPoints
        }
      : undefined
  ].filter((series): series is {
    label: string;
    statLabel: string;
    color: string;
    peak: number;
    path: string;
    points: Array<{ sample: UsageHistorySample; value: number; recordedAtMs: number }>;
  } => !!series);

  const statCards = [
    `<div class="stat"><div class="stat-label">Range</div><div class="stat-value">${escapeHtml(formatUsageHistoryRangeLabel(historyRange))}</div></div>`,
    `<div class="stat"><div class="stat-label">Samples</div><div class="stat-value">${escapeHtml(String(samples.length))}</div></div>`,
    `<div class="stat"><div class="stat-label">Latest Source</div><div class="stat-value">${escapeHtml(getUsageHistorySourceLabel(latestSample?.sourceFile))}</div></div>`,
    ...historySeries.map((series) => `<div class="stat"><div class="stat-label">${escapeHtml(series.statLabel)}</div><div class="stat-value">${escapeHtml(formatPercentValue(series.peak))}</div></div>`)
  ].join('');

  const gridLines = axisLevels.map((level) => {
    const y = Math.round((chartHeight - ((level / 100) * chartHeight)) * 100) / 100;
    return `<line x1="0" y1="${y}" x2="${chartWidth}" y2="${y}" stroke="rgba(255,255,255,0.12)" stroke-width="1"></line>`;
  }).join('');

  const axisLabels = axisLevels.map((level) => {
    const y = Math.round((chartHeight - ((level / 100) * chartHeight)) * 100) / 100;
    return `<text x="${chartOffsetLeft - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="currentColor" opacity="0.75">${level}%</text>`;
  }).join('');

  const paths = historySeries.map((series) => (
    `${series.path ? `<path d="${series.path}" fill="none" stroke="${escapeHtml(series.color)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>` : ''}`
    + renderUsageHistoryPoints(series.points, chartWidth, chartHeight, series.color, series.label, startMs, endMs)
  )).join('');

  const legend = historySeries.map((series) => (
    `<span class="legend-chip"><span class="legend-line" style="background:${escapeHtml(series.color)}"></span>${escapeHtml(series.label)} used %</span>`
  )).join('');

  return `<section class="history">
    <div class="section-title">Usage History</div>
    <div class="history-stats">${statCards}</div>
    ${renderUsageHistoryLatestSampleDetails(latestSample)}
    <div class="chart-wrap">
      <svg viewBox="0 0 ${svgWidth} ${svgHeight}" width="100%" height="198" role="img" aria-label="Usage history chart">
        <g transform="translate(${chartOffsetLeft},0)">
          <rect x="0" y="0" width="${chartWidth}" height="${Math.round(chartHeight * 0.25)}" fill="rgba(244, 67, 54, 0.07)"></rect>
          <rect x="0" y="${Math.round(chartHeight * 0.25)}" width="${chartWidth}" height="${Math.round(chartHeight * 0.25)}" fill="rgba(255, 193, 7, 0.06)"></rect>
          <rect x="0" y="${Math.round(chartHeight * 0.5)}" width="${chartWidth}" height="${Math.round(chartHeight * 0.5)}" fill="rgba(76, 175, 80, 0.04)"></rect>
          ${gridLines}
          <line x1="0" y1="0" x2="0" y2="${chartHeight}" stroke="rgba(255,255,255,0.18)" stroke-width="1"></line>
          <line x1="0" y1="${chartHeight}" x2="${chartWidth}" y2="${chartHeight}" stroke="rgba(255,255,255,0.18)" stroke-width="1"></line>
          ${paths}
        </g>
        ${axisLabels}
        <text x="12" y="${Math.round(chartHeight / 2)}" transform="rotate(-90 12 ${Math.round(chartHeight / 2)})" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.75">Used %</text>
        <text x="${chartOffsetLeft + chartWidth / 2}" y="${chartHeight + 22}" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.75">Recorded time</text>
      </svg>
      <div class="chart-footer"><span>${escapeHtml(formatTimestamp(samples[0]?.recordedAt ?? ''))}</span><span>${escapeHtml(formatTimestamp(samples[samples.length - 1]?.recordedAt ?? ''))}</span></div>
      <div class="chart-legend">${legend}<span class="legend-chip">Hover points for usage, tokens, and source</span><span class="legend-chip">Latest sample: ${escapeHtml(formatTimestamp(latestSample.recordedAt))}</span></div>
      ${renderUsageRecentSamples(samples)}
    </div>
  </section>`;
}

function renderUsageWindowSection(title: string, window: UsageWindow, warningColor: string, criticalColor: string): string {
  const outdated = isUsageOutdated(window);
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
  const displayPercent = getDisplayPercentValue(window);
  const timePercent = getTimeProgressPercent(window);
  const warningThreshold = getConfig().get<number>(USAGE_WARNING_THRESHOLD_SETTING, 70);
  const criticalThreshold = getConfig().get<number>(USAGE_CRITICAL_THRESHOLD_SETTING, 90);
  const usageColor = outdated
    ? '#666'
    : usedPercent >= criticalThreshold
      ? criticalColor
      : usedPercent >= warningThreshold
        ? warningColor
        : '#4CAF50';

  return `<section class="section">
    <div class="section-title">${escapeHtml(title)}</div>
    <div class="row">
      <div class="label">Usage</div>
      <div class="track"><div class="fill" style="width:${displayPercent}%; background:${escapeHtml(usageColor)}"></div></div>
      <div class="value">${outdated ? 'N/A' : escapeHtml(`${formatDisplayPercent(window)} ${getPercentDisplaySuffixLong()}`)}</div>
    </div>
    <div class="row">
      <div class="label">Time</div>
      <div class="track"><div class="fill" style="width:${timePercent}%; background:${outdated ? '#666' : '#9C27B0'}"></div></div>
      <div class="value">${outdated ? 'N/A' : escapeHtml(formatPercentValue(timePercent))}</div>
    </div>
    <div class="details">Reset: ${escapeHtml(formatResetLong(window.resetsAt))}${outdated ? ' [OUTDATED]' : ''}</div>
  </section>`;
}

function renderUsageProvenanceSection(profile: UsagePanelProfile): string {
  const refreshStatus = profile.refreshStatus || 'No recent refresh recorded';
  const sourceLabel = profile.isStale ? `${profile.sourceLabel} (pre-switch cached)` : profile.sourceLabel;
  return `<section class="provenance">
    <div class="provenance-grid">
      <div><div class="provenance-label">Source</div><div class="provenance-value">${escapeHtml(sourceLabel)}</div></div>
      <div><div class="provenance-label">Updated</div><div class="provenance-value">${escapeHtml(profile.updatedLabel)}</div></div>
      <div><div class="provenance-label">Refresh</div><div class="provenance-value">${escapeHtml(refreshStatus)}</div></div>
    </div>
  </section>`;
}

function renderUsageTokenSection(profile: UsagePanelProfile): string {
  if (!profile.snapshot?.totalUsage && !profile.snapshot?.lastUsage) {
    return '<section class="tokens"><h3>Token Usage</h3><div class="details">No live token usage data yet. Prompt Codex on this profile to populate it.</div></section>';
  }

  return `<section class="tokens">
    <h3>Token Usage</h3>
    ${profile.snapshot?.totalUsage ? `<div><strong>Total:</strong> ${escapeHtml(formatTokenUsage(profile.snapshot.totalUsage))}</div>` : ''}
    ${profile.snapshot?.lastUsage ? `<div><strong>Last:</strong> ${escapeHtml(formatTokenUsage(profile.snapshot.lastUsage))}</div>` : ''}
    ${profile.snapshot ? `<div class="details">Updated: ${escapeHtml(formatTimestamp(profile.snapshot.recordedAt))}</div>` : ''}
    ${profile.isStale ? '<div class="warning">Last-known data only. Use Codex once after switching to refresh it.</div>' : ''}
  </section>`;
}

function renderUsageCompareSelect(
  compareCandidates: UsagePanelProfile[],
  selectedCompareProfileId: string,
  activeProfileId: string
): string {
  if (!compareCandidates.length) {
    return `<div class="compare-select-wrap">
      <label for="compareProfileInline">Compare</label>
      <select id="compareProfileInline" disabled>
        <option value="${escapeHtml(activeProfileId)}">No other saved profiles</option>
      </select>
    </div>`;
  }

  const options = compareCandidates.map((profile) => {
    const subtitle = [
      profile.email && profile.email !== 'Unknown' ? profile.email : undefined,
      profile.planType && profile.planType !== 'Unknown' ? profile.planType : undefined
    ].filter((value): value is string => !!value).join(' • ');
    const label = subtitle ? `${profile.name} • ${subtitle}` : profile.name;
    return `<option value="${escapeHtml(profile.id)}"${profile.id === selectedCompareProfileId ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');

  return `<div class="compare-select-wrap">
    <label for="compareProfileInline">Compare</label>
    <select id="compareProfileInline">${options}</select>
  </div>`;
}

function renderUsageDetailsCard(
  profile: UsagePanelProfile,
  options: {
    roleLabel: string;
    roleClass: 'active' | 'compare';
    isCompareColumn: boolean;
    compareCandidates: UsagePanelProfile[];
    selectedCompareProfileId: string;
    historyRange: UsageHistoryRange;
    warningColor: string;
    criticalColor: string;
    activeProfileId?: string;
  }
): string {
  const subtitleParts = [];
  if (profile.email && profile.email !== 'Unknown') {
    subtitleParts.push(profile.email);
  }
  if (profile.planType && profile.planType !== 'Unknown') {
    subtitleParts.push(profile.planType);
  }
  const noData = !profile.snapshot?.primary && !profile.snapshot?.secondary;
  const actionsHtml = options.isCompareColumn
    ? `<div class="card-header-inline">
        <span class="pill ${options.roleClass}">${escapeHtml(options.roleLabel)}</span>
        ${renderUsageCompareSelect(options.compareCandidates, options.selectedCompareProfileId, options.activeProfileId ?? profile.id)}
        <button id="switchProfileInline" class="secondary" type="button" data-profile-id="${escapeHtml(profile.id)}"${profile.id === (options.activeProfileId ?? profile.id) ? ' disabled' : ''}>Switch Now</button>
      </div>`
    : `<div class="card-header-inline">
        <span class="pill ${options.roleClass}">${escapeHtml(options.roleLabel)}</span>
        <button id="refreshProfileInline" class="secondary" type="button">Refresh Now</button>
      </div>`;

  return `<article class="card">
    <div class="card-header">
      <div>
        <h3 class="card-title">${escapeHtml(profile.name)}</h3>
        <div class="card-subtitle">${escapeHtml(subtitleParts.join(' • ') || 'No profile metadata')}</div>
      </div>
      ${actionsHtml}
    </div>
    ${renderUsageProvenanceSection(profile)}
    ${noData ? '<div class="empty">Remaining usage is unknown until Codex emits live usage data for this profile. Check the refresh/source details above to see whether the last refresh found nothing newer, returned no data, or is still showing a pre-switch snapshot.</div>' : ''}
    ${getUsageWindowDescriptors(profile.snapshot).map((descriptor) => renderUsageWindowSection(descriptor.longLabel, descriptor.window, options.warningColor, options.criticalColor)).join('')}
    ${renderUsageHistorySection(profile, options.historyRange)}
    ${renderUsageTokenSection(profile)}
  </article>`;
}

async function exportProfiles(): Promise<void> {
  const exportMode = await vscode.window.showQuickPick(
    [
      {
        label: 'Encrypted (Recommended)',
        description: 'Protect the export with a passphrase',
        mode: 'encrypted' as const
      },
      {
        label: 'Plain JSON',
        description: 'No passphrase; easier to inspect but less safe to store or share',
        mode: 'plain' as const
      }
    ],
    { placeHolder: 'Choose export format' }
  );

  if (!exportMode) {
    return;
  }

  const target = await vscode.window.showSaveDialog({
    saveLabel: 'Export profiles',
    defaultUri: vscode.Uri.file(path.join(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
      exportMode.mode === 'encrypted'
        ? 'codex-account-switcher-profiles.enc.json'
        : 'codex-account-switcher-profiles.json'
    )),
    filters: { JSON: ['json'] }
  });

  if (!target) {
    return;
  }

  const payload = await profileStore.exportProfiles();
  if (exportMode.mode === 'encrypted') {
    const passphrase = await promptForTransferPassphrase('Export passphrase', 'Create a passphrase to encrypt this profile export.');
    if (!passphrase) {
      return;
    }

    const encryptedPayload = encryptTransferPayload(payload, passphrase);
    await fs.writeFile(target.fsPath, JSON.stringify(encryptedPayload, null, 2), 'utf8');
    void vscode.window.showInformationMessage(`Exported ${payload.profiles.length} encrypted profiles.`);
    return;
  }

  await fs.writeFile(target.fsPath, JSON.stringify(payload, null, 2), 'utf8');
  void vscode.window.showWarningMessage(`Exported ${payload.profiles.length} plain-text profiles. Treat this file like a password.`);
}

async function importProfiles(): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: false,
    canSelectFolders: false,
    openLabel: 'Import profiles',
    filters: { JSON: ['json'] }
  });

  if (!selected || !selected.length) {
    return;
  }

  try {
    const raw = await fs.readFile(selected[0].fsPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const importPayload = await resolveImportedProfilesPayload(parsed);
    if (!importPayload) {
      return;
    }
    const result = await profileStore.importProfiles(importPayload);
    void vscode.window.showInformationMessage(`Imported profiles: created ${result.created}, updated ${result.updated}, skipped ${result.skipped}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown import error.';
    void vscode.window.showErrorMessage(`Failed to import profiles: ${message}`);
  }
}

async function promptForTransferPassphrase(title: string, prompt: string): Promise<string | undefined> {
  const passphrase = await vscode.window.showInputBox({
    title,
    prompt,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim().length >= 8 ? undefined : 'Passphrase must be at least 8 characters.'
  });
  if (!passphrase) {
    return undefined;
  }

  const confirmation = await vscode.window.showInputBox({
    title,
    prompt: 'Confirm the passphrase.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value === passphrase ? undefined : 'Passphrases do not match.'
  });

  return confirmation === passphrase ? passphrase : undefined;
}

async function promptForImportPassphrase(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Import encrypted profiles',
    prompt: 'Enter the passphrase for this encrypted profile export.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : 'Passphrase is required.'
  });
}

async function resolveImportedProfilesPayload(parsed: unknown): Promise<unknown | undefined> {
  if (!isEncryptedTransferEnvelope(parsed)) {
    return parsed;
  }

  const passphrase = await promptForImportPassphrase();
  if (!passphrase) {
    return undefined;
  }

  return decryptTransferPayload(parsed, passphrase);
}

async function repairProfiles(context: vscode.ExtensionContext): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    'Repair saved profiles by removing broken metadata entries that no longer have valid stored profile secrets?',
    { modal: true },
    'Repair profiles'
  );

  if (confirm !== 'Repair profiles') {
    return;
  }

  const result = await profileStore.repairProfiles();
  await refreshUsageAndStatus(context);

  const summary = [
    `Kept ${result.kept} profile${result.kept === 1 ? '' : 's'}`,
    `removed ${result.removed} broken entr${result.removed === 1 ? 'y' : 'ies'}`
  ];
  if (result.repairedActiveProfile) {
    summary.push('repaired active profile');
  }
  if (result.repairedLastProfile) {
    summary.push('cleared broken last-profile reference');
  }

  void vscode.window.showInformationMessage(`Profile repair complete: ${summary.join(', ')}.`);
}

async function showDiagnosticsPanel(context: vscode.ExtensionContext): Promise<void> {
  const activeProfileId = await profileStore.getActiveProfileId();
  const activeProfile = activeProfileId ? await profileStore.getProfile(activeProfileId) : undefined;
  const activeSnapshot = activeProfileId ? getUsageCache(context)[activeProfileId]?.snapshot : undefined;
  const activeSecret = activeProfileId ? await profileStore.loadAuthData(activeProfileId) : undefined;
  const codexHome = getResolvedCodexHome();
  const authPath = getResolvedActiveAuthPath();
  const configPath = getResolvedCodexConfigPath();
  const capSidPath = getResolvedCapSidPath();
  const sessionsPath = getSessionsPath(codexHome);
  const cliSpec = await getCodexCliCommandSpec(['login'], getCodexLoginCommandText());

  const diagnostics = {
    codexHome,
    authPath,
    configPath,
    capSidPath,
    sessionsPath,
    storageModeConfigured: getConfig().get<string>(STORAGE_MODE_SETTING, 'auto'),
    storageModeEffective: profileStore.getEffectiveStorageMode(),
    storageRoot: profileStore.getStorageRootPath(),
    profilesFilePath: profileStore.getProfilesFilePath(),
    usageSourceMode: getUsageSourceMode(),
    usageRefreshIntervalSeconds: Math.max(15, getConfig().get<number>(USAGE_REFRESH_INTERVAL_SETTING, 30)),
    watcherActive: Boolean(usageWatcher),
    wslAuthPathMode: shouldUseWslAuthPath(),
    cliSource: cliSpec.source,
    cliCommand: [cliSpec.shellPath, ...cliSpec.shellArgs].join(' '),
    lastRefresh: lastUsageRefreshDiagnostic ? formatRefreshDiagnostic(lastUsageRefreshDiagnostic) : 'No refresh recorded yet',
    activeProfileName: activeProfile ? getProfileDisplayName(activeProfile) : 'None',
    activeProfileEmail: activeProfile ? getProfileDisplayEmail(activeProfile.email) : 'Unknown',
    activeProfilePlan: activeProfile?.planType ?? 'Unknown',
    activeProfileSecretExists: Boolean(activeSecret),
    activeUsageUpdatedAt: activeSnapshot ? formatTimestamp(activeSnapshot.recordedAt) : 'No cached usage',
    activeUsageSource: activeSnapshot ? formatUsageSource(activeSnapshot.sourceFile) : 'Unknown',
    authExists: await safeExists(authPath),
    configExists: await safeExists(configPath),
    capSidExists: await safeExists(capSidPath),
    sessionsPathExists: await safeExists(sessionsPath),
    codexHomeExists: await safeExists(codexHome),
    profilesFileExists: await safeExists(profileStore.getProfilesFilePath()),
    remoteName: vscode.env.remoteName ?? 'local'
  };

  const health = buildDiagnosticsHealth(diagnostics);

  const panel = vscode.window.createWebviewPanel(
    'codexAccountSwitcherDiagnostics',
    'Codex Switcher Diagnostics',
    vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
    { enableScripts: false }
  );

  panel.webview.html = buildDiagnosticsHtml(diagnostics, health);
}

function buildDiagnosticsHtml(diagnostics: {
  codexHome: string;
  authPath: string;
  configPath: string;
  capSidPath: string;
  sessionsPath: string;
  storageModeConfigured: string;
  storageModeEffective: string;
  storageRoot: string;
  profilesFilePath: string;
  usageSourceMode: UsageSourceMode;
  usageRefreshIntervalSeconds: number;
  watcherActive: boolean;
  wslAuthPathMode: boolean;
  cliSource: string;
  cliCommand: string;
  lastRefresh: string;
  activeProfileName: string;
  activeProfileEmail: string;
  activeProfilePlan: string;
  activeProfileSecretExists: boolean;
  activeUsageUpdatedAt: string;
  activeUsageSource: string;
  authExists: boolean;
  configExists: boolean;
  capSidExists: boolean;
  sessionsPathExists: boolean;
  codexHomeExists: boolean;
  profilesFileExists: boolean;
  remoteName: string;
}, health: DiagnosticsHealthItem[]): string {
  const bool = (value: boolean): string => value ? 'Yes' : 'No';
  const item = (label: string, value: string): string =>
    `<tr><td class="label">${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`;
  const healthHtml = health.length
    ? `<section class="card" style="grid-column: 1 / -1;">
        <h2>Health</h2>
        ${health.map((entry) => `
          <div class="health-item ${entry.severity}">
            <div class="health-head">
              <span class="health-badge ${entry.severity}">${escapeHtml(entry.severity.toUpperCase())}</span>
              <strong>${escapeHtml(entry.title)}</strong>
            </div>
            <div class="health-detail">${escapeHtml(entry.detail)}</div>
            ${entry.action ? `<div class="health-action">Next step: ${escapeHtml(entry.action)}</div>` : ''}
          </div>
        `).join('')}
      </section>`
    : '';

  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8" />
      <style>
        body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 0; padding: 20px; }
        .container { max-width: 1100px; margin: 0 auto; }
        h1 { margin: 0 0 16px 0; font-size: 28px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 16px; background: var(--vscode-panel-background); }
        h2 { margin: 0 0 12px 0; font-size: 16px; }
        table { width: 100%; border-collapse: collapse; }
        td { vertical-align: top; padding: 6px 0; }
        .label { width: 220px; color: var(--vscode-descriptionForeground); font-weight: 600; padding-right: 12px; }
        .mono { font-family: var(--vscode-editor-font-family, Consolas, monospace); word-break: break-all; }
        .health-item { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px; margin-bottom: 10px; background: rgba(128,128,128,0.04); }
        .health-head { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
        .health-badge { border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; }
        .health-badge.healthy { background: rgba(76, 175, 80, 0.15); }
        .health-badge.warning { background: rgba(255, 193, 7, 0.18); }
        .health-badge.broken { background: rgba(244, 67, 54, 0.18); }
        .health-detail { margin-bottom: 6px; }
        .health-action { color: var(--vscode-descriptionForeground); }
        @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Codex Switcher Diagnostics</h1>
        <div class="grid">
          ${healthHtml}
          <section class="card">
            <h2>Runtime</h2>
            <table>
              ${item('Storage mode (configured)', diagnostics.storageModeConfigured)}
              ${item('Storage mode (effective)', diagnostics.storageModeEffective)}
              ${item('Usage source mode', formatUsageSourceMode(diagnostics.usageSourceMode))}
              ${item('Usage refresh interval', `${diagnostics.usageRefreshIntervalSeconds}s`)}
              ${item('Usage watcher active', bool(diagnostics.watcherActive))}
              ${item('Remote host', diagnostics.remoteName)}
              ${item('WSL auth path mode', bool(diagnostics.wslAuthPathMode))}
              ${item('CLI source', diagnostics.cliSource)}
              ${item('CLI command', diagnostics.cliCommand)}
              ${item('Last refresh', diagnostics.lastRefresh)}
            </table>
          </section>
          <section class="card">
            <h2>Active Profile</h2>
            <table>
              ${item('Name', diagnostics.activeProfileName)}
              ${item('Email', diagnostics.activeProfileEmail)}
              ${item('Plan', diagnostics.activeProfilePlan)}
              ${item('Stored secret available', bool(diagnostics.activeProfileSecretExists))}
              ${item('Cached usage updated', diagnostics.activeUsageUpdatedAt)}
              ${item('Cached usage source', diagnostics.activeUsageSource)}
            </table>
          </section>
          <section class="card">
            <h2>Paths</h2>
            <table>
              ${item('Codex home', `${diagnostics.codexHome} (${bool(diagnostics.codexHomeExists)})`)}
              ${item('Active auth.json', `${diagnostics.authPath} (${bool(diagnostics.authExists)})`)}
              ${item('config.toml', `${diagnostics.configPath} (${bool(diagnostics.configExists)})`)}
              ${item('cap_sid', `${diagnostics.capSidPath} (${bool(diagnostics.capSidExists)})`)}
              ${item('sessions', `${diagnostics.sessionsPath} (${bool(diagnostics.sessionsPathExists)})`)}
            </table>
          </section>
          <section class="card">
            <h2>Profile Store</h2>
            <table>
              ${item('Storage root', diagnostics.storageRoot)}
              ${item('profiles.json', `${diagnostics.profilesFilePath} (${bool(diagnostics.profilesFileExists)})`)}
            </table>
          </section>
        </div>
      </div>
    </body>
  </html>`;
}

function buildDiagnosticsHealth(diagnostics: {
  storageModeConfigured: string;
  storageModeEffective: string;
  usageSourceMode: UsageSourceMode;
  watcherActive: boolean;
  wslAuthPathMode: boolean;
  lastRefresh: string;
  activeProfileName: string;
  activeProfileSecretExists: boolean;
  authExists: boolean;
  configExists: boolean;
  sessionsPathExists: boolean;
  codexHomeExists: boolean;
  profilesFileExists: boolean;
  remoteName: string;
}): DiagnosticsHealthItem[] {
  const items: DiagnosticsHealthItem[] = [];

  if (diagnostics.activeProfileName !== 'None' && !diagnostics.activeProfileSecretExists) {
    items.push({
      severity: 'broken',
      title: 'Active profile metadata is missing its stored secret',
      detail: 'The selected active profile exists in profile metadata, but its stored auth payload could not be loaded.',
      action: 'Run Repair saved profiles. If the profile is still needed after repair, re-import or reauthenticate it.'
    });
  }

  if (!diagnostics.codexHomeExists) {
    items.push({
      severity: 'broken',
      title: 'Resolved Codex home path does not exist',
      detail: 'The current CODEX_HOME resolution points at a directory that is missing, so auth, config, and session paths will not behave correctly.',
      action: 'Fix codexHome or CODEX_HOME so it points at a real Codex state directory.'
    });
  }

  if (diagnostics.wslAuthPathMode && (!diagnostics.authExists || !diagnostics.configExists)) {
    items.push({
      severity: 'warning',
      title: 'WSL auth path mode is enabled but key WSL-backed files are missing',
      detail: 'The extension is resolving auth/config through WSL, but the expected auth.json or config.toml path is not present.',
      action: 'Confirm chatgpt.runCodexInWindowsSubsystemForLinux matches how Codex is actually running, then sign in again or disable WSL auth-path mode.'
    });
  }

  if (diagnostics.remoteName === 'ssh-remote' && diagnostics.storageModeConfigured === 'secretStorage') {
    items.push({
      severity: 'warning',
      title: 'SSH remote session is forcing secretStorage',
      detail: 'Secret storage can be awkward in shared or remote extension-host scenarios, even though the current configuration forces it.',
      action: 'Consider storageMode = remoteFiles or auto for SSH remote sessions.'
    });
  }

  if (diagnostics.remoteName === 'local' && diagnostics.storageModeConfigured === 'remoteFiles') {
    items.push({
      severity: 'warning',
      title: 'Local session is forcing remoteFiles storage',
      detail: 'The extension is storing profile secrets in files even though local secretStorage would normally be preferred.',
      action: 'Consider storageMode = auto or secretStorage unless you explicitly want file-backed shared storage.'
    });
  }

  if (!diagnostics.watcherActive) {
    items.push({
      severity: 'warning',
      title: 'Usage file watcher is inactive',
      detail: 'The extension is relying only on timed refreshes for local session updates.',
      action: 'Check the resolved sessions path and use diagnostics to confirm it exists. Manual refresh still works.'
    });
  }

  if (diagnostics.usageSourceMode === 'appServerOnly' && diagnostics.lastRefresh.includes('no usage data returned')) {
    items.push({
      severity: 'warning',
      title: 'App-server-only usage mode is not returning data',
      detail: 'The last refresh did not produce live usage while usageSourceMode is locked to appServerOnly.',
      action: 'Switch usageSourceMode to auto or localOnly if session files are available.'
    });
  }

  if (!diagnostics.profilesFileExists && diagnostics.activeProfileName !== 'None') {
    items.push({
      severity: 'warning',
      title: 'Active profile exists but profiles.json is missing',
      detail: 'Profile metadata storage is missing even though an active profile is still referenced.',
      action: 'Run Repair saved profiles and verify the storage root is writable.'
    });
  }

  if (!diagnostics.sessionsPathExists && diagnostics.usageSourceMode !== 'appServerOnly') {
    items.push({
      severity: 'warning',
      title: 'Session fallback path is unavailable',
      detail: 'Local session files are not available, so auto/local usage refresh has reduced fallback coverage.',
      action: 'Keep app-server usage enabled or fix the resolved sessions path under the current Codex home.'
    });
  }

  if (!items.length) {
    items.push({
      severity: 'healthy',
      title: 'No obvious diagnostics problems detected',
      detail: 'Resolved paths, storage state, and current refresh mode do not show a known issue pattern.',
      action: 'If behavior is still wrong, use the last refresh result and path details above when filing a bug.'
    });
  }

  return items;
}

async function exportActiveAuth(): Promise<void> {
  const activeAuthPath = getResolvedActiveAuthPath();
  if (!(await safeExists(activeAuthPath))) {
    void vscode.window.showErrorMessage(`Active auth file not found: ${activeAuthPath}`);
    return;
  }

  const target = await vscode.window.showSaveDialog({
    saveLabel: 'Export auth snapshot',
    defaultUri: vscode.Uri.file(path.join(path.dirname(activeAuthPath), `auth.export.${getTimestamp()}.json`))
  });

  if (!target) {
    return;
  }

  await fs.copyFile(activeAuthPath, target.fsPath);
  output.appendLine(`Exported active auth to ${target.fsPath}`);
  void vscode.window.showInformationMessage('Exported active auth snapshot.');
}

function inferDefaultProfileName(email: string): string {
  if (!email || email === 'Unknown') {
    return 'profile';
  }

  return email.split('@')[0] || 'profile';
}

function parseIsoMs(value?: string): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function getAllUsageWindows(snapshot?: UsageSnapshot): UsageWindow[] {
  if (!snapshot) {
    return [];
  }

  return [snapshot.primary, snapshot.secondary].filter((window): window is UsageWindow => !!window);
}

function isFiveHourWindow(window: UsageWindow): boolean {
  return Math.abs(window.windowMinutes - FIVE_HOUR_WINDOW_MINUTES) <= 5;
}

function isWeeklyWindow(window: UsageWindow): boolean {
  return Math.abs(window.windowMinutes - WEEKLY_WINDOW_MINUTES) <= 60;
}

function getFiveHourUsageWindow(snapshot?: UsageSnapshot): UsageWindow | undefined {
  return getAllUsageWindows(snapshot).find((window) => isFiveHourWindow(window));
}

function getWeeklyUsageWindow(snapshot?: UsageSnapshot): UsageWindow | undefined {
  return getAllUsageWindows(snapshot).find((window) => isWeeklyWindow(window));
}

function formatWindowLabel(windowMinutes: number, compact: boolean): string {
  if (windowMinutes >= 1440 && windowMinutes % 1440 === 0) {
    const days = windowMinutes / 1440;
    return compact ? `${days}D` : `${days}-Day Window`;
  }
  if (windowMinutes >= 60 && windowMinutes % 60 === 0) {
    const hours = windowMinutes / 60;
    return compact ? `${hours}H` : `${hours}-Hour Window`;
  }
  return compact ? `${windowMinutes}M` : `${windowMinutes}-Minute Window`;
}

function getUsageWindowDescriptors(snapshot?: UsageSnapshot): UsageWindowDescriptor[] {
  const descriptors = getAllUsageWindows(snapshot).map((window) => {
    if (isFiveHourWindow(window)) {
      return { key: 'fiveHour' as const, shortLabel: '5H', longLabel: '5-Hour Session', icon: '$(pulse)', window };
    }
    if (isWeeklyWindow(window)) {
      return { key: 'weekly' as const, shortLabel: 'Weekly', longLabel: 'Weekly Limit', icon: '$(calendar)', window };
    }

    return {
      key: 'other' as const,
      shortLabel: formatWindowLabel(window.windowMinutes, true),
      longLabel: formatWindowLabel(window.windowMinutes, false),
      icon: '$(dashboard)',
      window
    };
  });

  return descriptors.sort((left, right) => {
    const leftOrder = left.key === 'fiveHour' ? 0 : left.key === 'weekly' ? 1 : 2;
    const rightOrder = right.key === 'fiveHour' ? 0 : right.key === 'weekly' ? 1 : 2;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.window.windowMinutes - right.window.windowMinutes;
  });
}

function buildUnknownDisplayEntries(planType?: string): Array<{ icon: string; shortLabel: string; text: string }> {
  if ((planType ?? '').toLowerCase() === 'free') {
    return [{ icon: '$(question)', shortLabel: 'Weekly', text: 'Unknown' }];
  }

  return [
    { icon: '$(question)', shortLabel: '5H', text: 'Unknown' },
    { icon: '$(question)', shortLabel: 'Weekly', text: 'Unknown' }
  ];
}

function buildUnknownStatusText(planType?: string): string {
  const parts = buildUnknownDisplayEntries(planType).map((entry) => `${entry.shortLabel}: ${entry.text}`);
  return `$(question) ${parts.join(' | ')}`;
}

function buildUnknownUsageSummary(planType?: string): string {
  return buildUnknownDisplayEntries(planType)
    .map((entry) => `${entry.shortLabel} ${entry.text}`)
    .join(' | ');
}

function buildUsageStatusText(snapshot?: UsageSnapshot, planType?: string): string {
  const descriptors = getUsageWindowDescriptors(snapshot);
  if (!descriptors.length) {
    return buildUnknownStatusText(planType);
  }

  const parts = descriptors.map((descriptor) => {
    const text = !isUsageOutdated(descriptor.window)
      ? `${formatDisplayPercentCompact(descriptor.window)} ${getPercentDisplaySuffixCompact()}`
      : 'Unknown';
    return `${descriptor.shortLabel}: ${text}`;
  });

  return `$(pulse) ${parts.join(' | ')}`;
}

function buildUsageWindowInline(label: string, window: UsageWindow): string {
  return `${label} ${buildUsageBar(window)} ${formatDisplayPercent(window)} ${getPercentDisplaySuffixLong()} | resets ${formatResetShort(window.resetsAt)}`;
}

function buildPickerUsageDetailLine(label: string, window: UsageWindow): string {
  return `${label}: ${formatDisplayPercent(window)} ${getPercentDisplaySuffixLong()} (${formatResetShort(window.resetsAt)})`;
}

function buildUnknownPickerDetailLine(planType?: string): string {
  return buildUnknownDisplayEntries(planType)
    .map((entry) => `${entry.icon} ${entry.shortLabel}: ${entry.text}`)
    .join('  |  ');
}

function formatUsedPercentCompact(window: UsageWindow): string {
  return formatDisplayPercentCompact(window);
}

function buildUsageBar(window: UsageWindow): string {
  const displayPercent = getDisplayPercentValue(window);
  const filled = Math.round(displayPercent / 20);
  return `[${'#'.repeat(filled)}${'-'.repeat(5 - filled)}]`;
}

function getUsageStatusBarColor(usedPercent: number): string | vscode.ThemeColor {
  if (!getConfig().get<boolean>(USAGE_COLORS_ENABLED_SETTING, true)) {
    return new vscode.ThemeColor('statusBarItem.foreground');
  }

  const warningThreshold = getConfig().get<number>(USAGE_WARNING_THRESHOLD_SETTING, 70);
  const criticalThreshold = getConfig().get<number>(USAGE_CRITICAL_THRESHOLD_SETTING, 90);
  const { warning: warningColor, critical: criticalColor } = getSeverityColors();

  if (usedPercent >= criticalThreshold) {
    return criticalColor;
  }
  if (usedPercent >= warningThreshold) {
    return warningColor;
  }
  return new vscode.ThemeColor('statusBarItem.foreground');
}

function getMaxUsedPercent(snapshot: UsageSnapshot): number {
  return getAllUsageWindows(snapshot).reduce((max, window) => Math.max(max, window.usedPercent), 0);
}

function getTimeProgressPercent(window: UsageWindow): number {
  const resetMs = new Date(window.resetsAt).getTime();
  const windowMs = window.windowMinutes * 60 * 1000;
  const remainingMs = Math.max(0, resetMs - Date.now());
  const elapsedPercent = 100 - ((remainingMs / windowMs) * 100);
  return Math.max(0, Math.min(100, elapsedPercent));
}

function isUsageOutdated(window: UsageWindow): boolean {
  return new Date(window.resetsAt).getTime() <= Date.now();
}

function createProgressBar(percentage: number, type: 'usage' | 'time', outdated: boolean, severityPercent?: number): string {
  const width = 200;
  const height = 16;
  const fillWidth = Math.round((Math.max(0, Math.min(100, percentage)) / 100) * width);
  const backgroundColor = '#333';
  let fillColor = '#4CAF50';

  if (outdated) {
    fillColor = '#666';
  } else if (type === 'time') {
    fillColor = '#9C27B0';
  } else {
    const warningThreshold = getConfig().get<number>(USAGE_WARNING_THRESHOLD_SETTING, 70);
    const criticalThreshold = getConfig().get<number>(USAGE_CRITICAL_THRESHOLD_SETTING, 90);
    const effectiveSeverity = severityPercent ?? percentage;
    if (effectiveSeverity >= criticalThreshold) {
      fillColor = getConfig().get<string>(USAGE_CRITICAL_COLOR_SETTING, '#eca7a7');
    } else if (effectiveSeverity >= warningThreshold) {
      fillColor = getConfig().get<string>(USAGE_WARNING_COLOR_SETTING, '#f3d898');
    }
  }

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="${backgroundColor}" rx="2"/><rect width="${fillWidth}" height="${height}" fill="${fillColor}" rx="2"/></svg>`;
  return `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" alt="${percentage.toFixed(1)}%" style="vertical-align:middle;"/>`;
}

function getPercentDisplayMode(): 'remaining' | 'used' {
  return getConfig().get<'remaining' | 'used'>(USAGE_PERCENT_DISPLAY_SETTING, 'remaining');
}

function getDisplayPercentValue(window: UsageWindow): number {
  if (getPercentDisplayMode() === 'used') {
    return Math.max(0, Math.min(100, window.usedPercent));
  }
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

function formatDisplayPercent(window: UsageWindow): string {
  const value = Math.round(getDisplayPercentValue(window) * 10) / 10;
  return Number.isInteger(value) ? `${value.toFixed(0)}%` : `${value.toFixed(1)}%`;
}

function formatDisplayPercentCompact(window: UsageWindow): string {
  return formatDisplayPercent(window);
}

function getPercentDisplaySuffixLong(): string {
  return getPercentDisplayMode() === 'used' ? 'used' : 'left';
}

function getPercentDisplaySuffixCompact(): string {
  return getPercentDisplayMode() === 'used' ? 'used' : 'left';
}

function getLikelyUnusedPercentText(): string {
  return getPercentDisplayMode() === 'used' ? '~0%' : '~100%';
}

function formatTokenUsage(usage: TokenUsage): string {
  const format = (value: number): string => `${Math.round(value / 1000).toLocaleString('en-US')} K`;
  return `input ${format(usage.inputTokens)}, cached ${format(usage.cachedInputTokens)}, output ${format(usage.outputTokens)}, reasoning ${format(usage.reasoningOutputTokens)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll('\n', '&#10;');
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}

function formatResetShort(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  if (isSameLocalDate(date, now)) {
    return formatClock(date);
  }

  const diffDays = Math.abs((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 7) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
  }

  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function formatResetLong(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function formatTimestamp(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso));
}

function formatClock(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function isSameLocalDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
