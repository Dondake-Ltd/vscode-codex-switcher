import * as fscore from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getCodexLoginCommandText,
  getResolvedActiveAuthPath,
  getResolvedCodexHome,
  loadAuthDataFromFile,
  loadCodexConfigText
} from './auth';
import {
  AccountConfig,
  expandPath,
  getBackupPath,
  getEnabledAccounts,
  getTimestamp,
  normalizeAccounts
} from './core';
import { ProfileStore, ProfileSummary } from './profileStore';
import { getSessionsPath, readLatestUsageSnapshot, TokenUsage, UsageSnapshot, UsageWindow } from './usage';

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
const CMD_LOGIN = 'codexAccountSwitcher.loginWithCodexCli';
const CMD_MANAGE = 'codexAccountSwitcher.manageProfiles';
const CMD_SHOW_USAGE_DETAILS = 'codexAccountSwitcher.showUsageDetails';
const STATUS_SIDE_SETTING = 'statusBarSide';
const RELOAD_TARGET_SETTING = 'reloadTarget';
const STORAGE_MODE_SETTING = 'storageMode';
const SHOW_STATUS_BAR_USAGE_SETTING = 'showUsageInStatusBar';
const SHOW_SWITCHER_USAGE_SETTING = 'showUsageInSwitcher';
const USAGE_REFRESH_INTERVAL_SETTING = 'usageRefreshIntervalSeconds';
const USAGE_COLORS_ENABLED_SETTING = 'usageColorsEnabled';
const USAGE_WARNING_THRESHOLD_SETTING = 'usageWarningThreshold';
const USAGE_WARNING_COLOR_SETTING = 'usageWarningColor';
const USAGE_CRITICAL_THRESHOLD_SETTING = 'usageCriticalThreshold';
const USAGE_CRITICAL_COLOR_SETTING = 'usageCriticalColor';
const USAGE_PERCENT_DISPLAY_SETTING = 'usagePercentDisplay';
const CMD_RESTART_EXTENSION_HOST = 'workbench.action.restartExtensionHost';
const USAGE_CACHE_KEY = 'usageByProfile';
const USAGE_HISTORY_KEY = 'usageHistoryByProfile';
const LAST_SWITCH_AT_KEY = 'lastSwitchAtByProfile';

let statusBar: vscode.StatusBarItem;
let usageStatusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let profileStore: ProfileStore;
let usageRefreshTimer: NodeJS.Timeout | undefined;
let usageWatcher: fscore.FSWatcher | undefined;
let usageRefreshDebounce: NodeJS.Timeout | undefined;

type CachedUsageEntry = {
  snapshot: UsageSnapshot;
  cachedAt: string;
};

type UsageCache = Record<string, CachedUsageEntry>;
type UsageHistorySample = {
  recordedAt: string;
  primaryUsedPercent?: number;
  secondaryUsedPercent?: number;
};
type UsageHistoryStore = Record<string, UsageHistorySample[]>;
type LastSwitchMap = Record<string, string>;

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
    | 'reauthenticate'
    | 'refreshCurrent'
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
};

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Codex Account Switcher');
  context.subscriptions.push(output);

  profileStore = new ProfileStore(context, output);

  createStatusBarItems();
  context.subscriptions.push({
    dispose: () => {
      statusBar.dispose();
      usageStatusBar.dispose();
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
  context.subscriptions.push(vscode.commands.registerCommand(CMD_LOGIN, () => loginViaCodexCli(context)));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_MANAGE, () => manageProfiles(context)));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_SHOW_USAGE_DETAILS, () => showUsageDetailsPanel(context)));

  context.subscriptions.push(
    ...profileStore.createWatchers(() => {
      void refreshUsageAndStatus(context);
    })
  );

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
  }));

  recreateUsageRefreshTimer(context);
  recreateUsageWatcher(context);
  void initializeProfiles(context);
}

export function deactivate(): void {}

async function initializeProfiles(context: vscode.ExtensionContext): Promise<void> {
  await maybeWarnEnsureFileBasedCreds(context);
  await migrateLegacyAccounts(context);
  await profileStore.syncActiveProfileToAuthFile();
  await refreshUsageAndStatus(context);
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
}

function recreateStatusBarItem(): void {
  statusBar.dispose();
  usageStatusBar.dispose();
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

  const sample: UsageHistorySample = {
    recordedAt: snapshot.recordedAt,
    primaryUsedPercent: snapshot.primary?.usedPercent,
    secondaryUsedPercent: snapshot.secondary?.usedPercent
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
}

async function refreshActiveUsageCache(context: vscode.ExtensionContext): Promise<void> {
  const activeProfileId = await profileStore.getActiveProfileId();
  if (!activeProfileId) {
    return;
  }

  const snapshot = await readLatestUsageSnapshot(getResolvedCodexHome());
  if (!snapshot) {
    return;
  }

  const lastSwitchAt = getLastSwitchMap(context)[activeProfileId];
  if (lastSwitchAt && parseIsoMs(snapshot.recordedAt) < parseIsoMs(lastSwitchAt)) {
    return;
  }

  const cache = getUsageCache(context);
  const existing = cache[activeProfileId];
  if (existing && parseIsoMs(existing.snapshot.recordedAt) >= parseIsoMs(snapshot.recordedAt)) {
    return;
  }

  cache[activeProfileId] = {
    snapshot,
    cachedAt: new Date().toISOString()
  };
  await updateUsageCache(context, cache);
  await appendUsageHistorySample(context, activeProfileId, snapshot);
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
    return;
  }

  const usageView = getProfileUsageView(context, activeProfileId, activeProfileId);
  statusBar.text = `$(account) ${activeProfile.name}`;
  statusBar.tooltip = usageView.isStaleForActiveProfile
    ? `Switch Codex account/profile\n\nLast-known usage for ${activeProfile.name} is stale. Use Codex once after switching to refresh it.`
    : 'Switch Codex account/profile';
  statusBar.show();

  if (getConfig().get<boolean>(SHOW_STATUS_BAR_USAGE_SETTING, true)) {
    const snapshot = usageView.entry?.snapshot;
    usageStatusBar.text = buildUsageStatusText(snapshot);
    usageStatusBar.tooltip = createUsageTooltip(activeProfile.name, usageView);
    usageStatusBar.color = snapshot
      ? getUsageStatusBarColor(getMaxUsedPercent(snapshot))
      : new vscode.ThemeColor('statusBarItem.foreground');
    usageStatusBar.show();
  } else {
    usageStatusBar.hide();
  }
}

function createUsageTooltip(profileName: string, usageView: ProfileUsageView): vscode.MarkdownString {
  const snapshot = usageView.entry?.snapshot;
  const tooltip = new vscode.MarkdownString();
  tooltip.isTrusted = true;
  tooltip.supportHtml = true;
  tooltip.supportThemeIcons = true;

  if (!snapshot) {
    tooltip.appendMarkdown(`Active Codex account/profile: **${escapeMarkdown(profileName)}**\n\n`);
    tooltip.appendMarkdown('Appears that the current usage cycle is likely unused so far.\n\n');
    tooltip.appendMarkdown(`**Estimated usage:** ${escapeMarkdown(getLikelyUnusedPercentText())} ${escapeMarkdown(getPercentDisplaySuffixLong())} for both 5-hour and weekly windows.\n\n`);
    tooltip.appendMarkdown('Prompt Codex on this profile to replace this estimate with fresh rate-limit data.');
    return tooltip;
  }

  tooltip.appendMarkdown('<div align="center">\n\n');
  tooltip.appendMarkdown('## $(pulse) Codex Usage\n\n');
  tooltip.appendMarkdown('</div>\n\n');
  tooltip.appendMarkdown(`**Profile:** ${escapeMarkdown(profileName)}\n\n`);

  if (snapshot.primary) {
    appendUsageSection(tooltip, '$(pulse) 5-Hour Session', snapshot.primary);
  }
  if (snapshot.secondary) {
    appendUsageSection(tooltip, '$(calendar) Weekly Limit', snapshot.secondary);
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
  tooltip.appendMarkdown(' • [Show Details](command:codexAccountSwitcher.showUsageDetails)');
  tooltip.appendMarkdown(' • [Settings](command:codexAccountSwitcher.editAccounts)');

  if (usageView.isStaleForActiveProfile) {
    tooltip.appendMarkdown('\n\n$(warning) Last-known data only. Use Codex once after switching to refresh it.');
  }

  return tooltip;
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
  await refreshUsageAndStatus(context);

  const profiles = await profileStore.listProfiles();
  if (!profiles.length) {
    await manageProfiles(context, 'No saved profiles yet.');
    return;
  }

  const activeProfileId = await profileStore.getActiveProfileId();
  const picks: SwitcherQuickPickItem[] = profiles.map((profile) => buildProfilePick(context, profile, activeProfileId));
  picks.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  picks.push({ itemType: 'action', actionId: 'addCurrent', label: '$(add) Import current auth.json', detail: 'Create or update a profile from the currently active Codex auth file.' });
  picks.push({ itemType: 'action', actionId: 'importFile', label: '$(folder-opened) Import auth file...', detail: 'Import a profile from an auth.json file.' });
  picks.push({ itemType: 'action', actionId: 'login', label: '$(terminal) Login via Codex CLI...', detail: 'Run codex login in the right runtime and import it as a profile.' });
  picks.push({ itemType: 'action', actionId: 'reauthenticate', label: '$(sync) Reauthenticate profile...', detail: 'Run codex login and save refreshed auth back into an existing profile.' });
  picks.push({ itemType: 'action', actionId: 'refreshCurrent', label: '$(history) Update profile from current auth.json', detail: 'Persist the current auth.json into an existing saved profile without deleting it.' });
  picks.push({ itemType: 'action', actionId: 'rename', label: '$(edit) Rename profile...', detail: 'Rename an existing profile.' });
  picks.push({ itemType: 'action', actionId: 'delete', label: '$(trash) Delete profile...', detail: 'Delete a saved profile.' });
  picks.push({ itemType: 'action', actionId: 'exportProfiles', label: '$(export) Export profiles...', detail: 'Export saved profiles for transfer or backup.' });
  picks.push({ itemType: 'action', actionId: 'importProfiles', label: '$(cloud-upload) Import profiles...', detail: 'Import profiles from a previous export.' });
  picks.push({ itemType: 'action', actionId: 'settings', label: '$(gear) Open settings', detail: 'Edit Codex Account Switcher settings.' });

  const chosen = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Select a Codex account/profile or action'
  });

  if (!chosen) {
    return;
  }

  if ('itemType' in chosen && chosen.itemType === 'action') {
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
      case 'reauthenticate':
        await reauthenticateProfile(context);
        return;
      case 'refreshCurrent':
        await updateProfileFromCurrentAuth(context);
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

  if ('itemType' in chosen && chosen.itemType === 'profile') {
    await switchToProfile(chosen.profileId, context);
  }
}

function buildProfilePick(context: vscode.ExtensionContext, profile: ProfileSummary, activeProfileId?: string): ProfileQuickPickItem {
  const usageView = getProfileUsageView(context, profile.id, activeProfileId);
  const showUsageInSwitcher = getConfig().get<boolean>(SHOW_SWITCHER_USAGE_SETTING, true);
  const summaryParts: string[] = [];

  if (profile.id === activeProfileId) {
    summaryParts.push('active');
  }
  if (profile.email && profile.email !== 'Unknown') {
    summaryParts.push(profile.email);
  }
  if (profile.planType && profile.planType !== 'Unknown') {
    summaryParts.push(profile.planType);
  }

  const detailLines: string[] = [];
  if (showUsageInSwitcher && usageView.entry?.snapshot.primary) {
    detailLines.push(buildPickerUsageDetailLine('$(pulse) 5H', usageView.entry.snapshot.primary));
  }
  if (showUsageInSwitcher && usageView.entry?.snapshot.secondary) {
    detailLines.push(buildPickerUsageDetailLine('$(calendar) Weekly', usageView.entry.snapshot.secondary));
  }
  if (showUsageInSwitcher && !usageView.entry) {
    detailLines.push(buildLikelyUnusedPickerDetailLine());
  }
  if (usageView.isStaleForActiveProfile) {
    detailLines.push('$(warning) Waiting for new Codex activity after switch');
  }

  const description = summaryParts.join(' • ');

  return {
    itemType: 'profile',
    profileId: profile.id,
    label: profile.name,
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

  return { entry, history, isStaleForActiveProfile };
}

async function switchToProfile(profileId: string, context: vscode.ExtensionContext): Promise<void> {
  const profile = await profileStore.getProfile(profileId);
  if (!profile) {
    void vscode.window.showErrorMessage('Selected profile no longer exists.');
    return;
  }

  if (getConfig().get<boolean>('confirmBeforeSwitch', false)) {
    const choice = await vscode.window.showWarningMessage(
      `Switch Codex account/profile to '${profile.name}'?`,
      { modal: true },
      'Switch'
    );
    if (choice !== 'Switch') {
      return;
    }
  }

  await backupActiveAuthIfNeeded();

  const switched = await profileStore.setActiveProfileId(profileId);
  if (!switched) {
    void vscode.window.showErrorMessage(`Could not activate profile '${profile.name}'.`);
    return;
  }

  await setLastSwitchAt(context, profileId, new Date().toISOString());
  await refreshStatusBar(context);
  output.appendLine(`Switched active profile to '${profile.name}'`);
  await maybeReloadAfterSwitch(profile.name);
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

async function maybeReloadAfterSwitch(profileName: string): Promise<void> {
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
      `Switched Codex account/profile to: ${profileName}. You have unsaved editors. Reload now?`,
      { modal: true },
      'Reload now',
      'Cancel'
    );
    if (choice === 'Reload now') {
      triggerReload();
    } else {
      void vscode.window.showInformationMessage(
        `Switched Codex account/profile to: ${profileName}. Reload when ready to apply auth to running tools.`
      );
    }
    return;
  }

  void vscode.window.showInformationMessage(`Switched Codex account/profile to: ${profileName}. Reloading...`);
  triggerReload();
}

async function addProfileFromCurrentAuth(context: vscode.ExtensionContext): Promise<void> {
  const authData = await loadAuthDataFromFile(getResolvedActiveAuthPath());
  if (!authData) {
    void vscode.window.showErrorMessage(`Could not read auth from ${getResolvedActiveAuthPath()}. Run '${getCodexLoginCommandText()}' first.`);
    return;
  }
  authData.codexConfigText = await loadCodexConfigText();

  const duplicate = await profileStore.findDuplicateProfile(authData);
  const defaultName = duplicate?.name ?? inferDefaultProfileName(authData.email);
  const name = (await vscode.window.showInputBox({
    prompt: 'Profile/account name',
    value: defaultName,
    validateInput: (value) => value.trim() ? undefined : 'Name is required.'
  }))?.trim();

  if (!name) {
    return;
  }

  const profile = duplicate
    ? (await profileStore.replaceProfileAuth(duplicate.id, authData), await profileStore.renameProfile(duplicate.id, name), (await profileStore.getProfile(duplicate.id)) ?? duplicate)
    : await profileStore.createProfile(name, authData);

  await profileStore.setActiveProfileId(profile.id);
  await setLastSwitchAt(context, profile.id, new Date().toISOString());
  await refreshUsageAndStatus(context);
  void vscode.window.showInformationMessage(`Imported current auth as profile '${profile.name}'.`);
}

async function importProfileFromFile(context: vscode.ExtensionContext): Promise<void> {
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
  const defaultName = duplicate?.name ?? inferDefaultProfileName(authData.email);
  const name = (await vscode.window.showInputBox({
    prompt: 'Profile/account name',
    value: defaultName,
    validateInput: (value) => value.trim() ? undefined : 'Name is required.'
  }))?.trim();

  if (!name) {
    return;
  }

  const profile = duplicate
    ? (await profileStore.replaceProfileAuth(duplicate.id, authData), await profileStore.renameProfile(duplicate.id, name), (await profileStore.getProfile(duplicate.id)) ?? duplicate)
    : await profileStore.createProfile(name, authData);

  await profileStore.setActiveProfileId(profile.id);
  await setLastSwitchAt(context, profile.id, new Date().toISOString());
  await refreshUsageAndStatus(context);
  void vscode.window.showInformationMessage(`Imported auth file as profile '${profile.name}'.`);
}

async function deleteProfile(context: vscode.ExtensionContext): Promise<void> {
  const profiles = await profileStore.listProfiles();
  if (!profiles.length) {
    void vscode.window.showInformationMessage('No profiles configured.');
    return;
  }

  const pick = await vscode.window.showQuickPick(
    profiles.map((profile) => ({ label: profile.name, description: profile.email !== 'Unknown' ? profile.email : undefined, profileId: profile.id })),
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
      label: profile.name,
      description: profile.email !== 'Unknown' ? profile.email : undefined,
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
    throw new Error(`Could not read auth from ${getResolvedActiveAuthPath()}. Run '${getCodexLoginCommandText()}' first.`);
  }
  authData.codexConfigText = await loadCodexConfigText();

  const duplicate = await profileStore.findDuplicateProfile(authData);
  if (duplicate && duplicate.id !== targetProfile.id) {
    const duplicateLabel = duplicate.email && duplicate.email !== 'Unknown'
      ? `${duplicate.name} (${duplicate.email})`
      : duplicate.name;
    throw new Error(`Current auth already matches saved profile '${duplicateLabel}'. Log into the intended account/profile first or update that matching profile instead.`);
  }

  if (targetProfile.email !== 'Unknown' && authData.email !== 'Unknown' && targetProfile.email.toLowerCase() !== authData.email.toLowerCase()) {
    throw new Error(`Current auth belongs to '${authData.email}', but target profile '${targetProfile.name}' expects '${targetProfile.email}'. Reauthenticate the correct account and try again.`);
  }

  const replaced = await profileStore.replaceProfileAuth(targetProfile.id, authData);
  if (!replaced) {
    throw new Error(`Could not update profile '${targetProfile.name}'.`);
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
    void vscode.window.showInformationMessage(`Updated profile '${targetProfile.name}' from the current auth.json.`);
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

  const proceed = await vscode.window.showInformationMessage(
    `Reauthenticate '${targetProfile.name}' by running '${getCodexLoginCommandText()}'. When login finishes, the refreshed auth will be saved back into this profile and it will become the active profile.`,
    'Continue',
    'Cancel'
  );

  if (proceed !== 'Continue') {
    return;
  }

  const authPath = getResolvedActiveAuthPath();
  const loginCommand = getCodexLoginCommandText();

  await vscode.commands.executeCommand('workbench.action.terminal.new');
  setTimeout(() => {
    void vscode.commands.executeCommand('workbench.action.terminal.sendSequence', { text: `${loginCommand}\n` });
  }, 400);

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
      await profileStore.setActiveProfileId(targetProfile.id);
      await setLastSwitchAt(context, targetProfile.id, new Date().toISOString());
      await refreshUsageAndStatus(context);
      output.appendLine(`Reauthenticated profile '${targetProfile.name}'`);
      await maybeReloadAfterSwitch(targetProfile.name);
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
    `After completing '${loginCommand}', save the refreshed auth back into '${targetProfile.name}'.`,
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
    profiles.map((profile) => ({ label: profile.name, description: profile.email !== 'Unknown' ? profile.email : undefined, profileId: profile.id })),
    { placeHolder: 'Select profile to rename' }
  );

  if (!pick) {
    return;
  }

  const nextName = (await vscode.window.showInputBox({
    prompt: 'New profile/account name',
    value: pick.label,
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
      { label: 'Import current auth.json', actionId: 'addCurrent' },
      { label: 'Import auth file...', actionId: 'importFile' },
      { label: 'Switch profile', actionId: 'switch' },
      { label: 'Reauthenticate profile', actionId: 'reauthenticate' },
      { label: 'Update profile from current auth.json', actionId: 'refreshCurrent' },
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
    case 'reauthenticate':
      await reauthenticateProfile(context);
      return;
    case 'refreshCurrent':
      await updateProfileFromCurrentAuth(context);
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
  const loginCommand = getCodexLoginCommandText();

  await vscode.commands.executeCommand('workbench.action.terminal.new');
  setTimeout(() => {
    void vscode.commands.executeCommand('workbench.action.terminal.sendSequence', { text: `${loginCommand}\n` });
  }, 400);

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
    `After completing '${loginCommand}', import the current environment auth.json from ${authPath}.`,
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
};

async function showUsageDetailsPanel(context: vscode.ExtensionContext): Promise<void> {
  const activeProfileId = await profileStore.getActiveProfileId();
  const activeProfile = activeProfileId ? await profileStore.getProfile(activeProfileId) : undefined;

  const panel = vscode.window.createWebviewPanel(
    'codexAccountSwitcherUsage',
    'Codex Usage Details',
    vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
    { enableScripts: true }
  );

  if (!activeProfileId || !activeProfile) {
    panel.webview.html = `<!DOCTYPE html><html><body style="font-family: sans-serif; padding: 20px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background);"><h2>No profile selected</h2><p>Save or switch to a Codex profile first.</p></body></html>`;
    return;
  }

  const profiles = await profileStore.listProfiles();
  const panelProfiles: UsagePanelProfile[] = profiles.map((profile) => {
    const usageView = getProfileUsageView(context, profile.id, activeProfileId);
    return {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      planType: profile.planType,
      snapshot: usageView.entry?.snapshot,
      history: usageView.history,
      isStale: usageView.isStaleForActiveProfile,
      isActive: profile.id === activeProfileId
    };
  });

  const activePanelProfile = panelProfiles.find((profile) => profile.id === activeProfileId);
  if (!activePanelProfile) {
    panel.webview.html = `<!DOCTYPE html><html><body style="font-family: sans-serif; padding: 20px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background);"><h2>No profile selected</h2><p>Save or switch to a Codex profile first.</p></body></html>`;
    return;
  }

  panel.webview.html = buildUsageDetailsHtml(panel.webview, context.extensionUri, activePanelProfile, panelProfiles);

  panel.webview.onDidReceiveMessage(async (message) => {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'switchProfile' && typeof message.profileId === 'string') {
      await switchToProfile(message.profileId, context);
      panel.dispose();
    }
  });
}

function buildUsageDetailsHtml(webview: vscode.Webview, extensionUri: vscode.Uri, activeProfile: UsagePanelProfile, profiles: UsagePanelProfile[]): string {
  const warningColor = getConfig().get<string>(USAGE_WARNING_COLOR_SETTING, '#f3d898');
  const criticalColor = getConfig().get<string>(USAGE_CRITICAL_COLOR_SETTING, '#eca7a7');
  const nonce = getTimestamp();
  const initialCompareId = profiles.find((profile) => profile.id !== activeProfile.id)?.id ?? activeProfile.id;
  const payload = JSON.stringify({
    activeProfileId: activeProfile.id,
    initialCompareId,
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      email: profile.email,
      planType: profile.planType,
      isActive: profile.isActive,
      isStale: profile.isStale,
      snapshot: profile.snapshot
        ? {
            recordedAt: profile.snapshot.recordedAt,
            totalUsage: profile.snapshot.totalUsage,
            lastUsage: profile.snapshot.lastUsage,
            primary: profile.snapshot.primary
              ? {
                  usedPercent: profile.snapshot.primary.usedPercent,
                  resetsAt: profile.snapshot.primary.resetsAt,
                  windowMinutes: profile.snapshot.primary.windowMinutes
                }
              : undefined,
            secondary: profile.snapshot.secondary
              ? {
                  usedPercent: profile.snapshot.secondary.usedPercent,
                  resetsAt: profile.snapshot.secondary.resetsAt,
                  windowMinutes: profile.snapshot.secondary.windowMinutes
                }
              : undefined
          }
        : undefined,
      history: profile.history
    })),
    percentDisplayMode: getPercentDisplayMode(),
    warningThreshold: getConfig().get<number>(USAGE_WARNING_THRESHOLD_SETTING, 70),
    criticalThreshold: getConfig().get<number>(USAGE_CRITICAL_THRESHOLD_SETTING, 90),
    warningColor,
    criticalColor
  });

  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8" />
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
      <style>
        body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); margin: 0; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: stretch; gap: 16px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 16px 18px; margin-bottom: 20px; background: var(--vscode-panel-background); min-height: 84px; }
        .brand { display: flex; align-items: center; }
        .brand-title { font-size: 30px; font-weight: 800; line-height: 1; }
        .compare-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-left: auto; justify-content: flex-end; }
        .compare-controls label { font-weight: 600; }
        select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 6px; padding: 6px 8px; min-width: 160px; }
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 6px; padding: 7px 12px; cursor: pointer; }
        button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        button:disabled { opacity: 0.55; cursor: default; }
        .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
        .card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 16px; background: var(--vscode-panel-background); }
        .card-header { display: flex; justify-content: space-between; align-items: start; gap: 12px; margin-bottom: 14px; }
        .card-header-inline { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
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
        .chart-wrap { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; background: rgba(0,0,0,0.08); }
        .chart-legend { display: flex; gap: 14px; flex-wrap: wrap; color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 10px; }
        .legend-chip { display: inline-flex; align-items: center; gap: 6px; }
        .legend-line { width: 18px; height: 3px; border-radius: 999px; }
        .warning { margin-top: 12px; color: var(--vscode-editorWarning-foreground); font-weight: 600; }
        .empty { border: 1px dashed var(--vscode-panel-border); border-radius: 8px; padding: 16px; color: var(--vscode-descriptionForeground); }
        @media (max-width: 980px) { .columns { grid-template-columns: 1fr; } .header { justify-content: flex-start; flex-direction: column; } .compare-controls { margin-left: 0; } }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="brand">
            <div class="brand-title">Codex Usage</div>
          </div>
          <div class="compare-controls">
            <label for="historyRange">History</label>
            <select id="historyRange">
              <option value="day">Daily</option>
              <option value="week">Weekly</option>
              <option value="month">Monthly</option>
              <option value="year">Yearly</option>
            </select>
          </div>
        </div>
        <div class="columns">
          <div id="activeColumn"></div>
          <div id="compareColumn"></div>
        </div>
      </div>
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const state = ${payload};

        const historyRangeSelect = document.getElementById('historyRange');
        const activeColumn = document.getElementById('activeColumn');
        const compareColumn = document.getElementById('compareColumn');
        let selectedCompareProfileId = state.initialCompareId;

        const profilesById = new Map(state.profiles.map((profile) => [profile.id, profile]));
        const activeProfile = profilesById.get(state.activeProfileId);

        function clamp(value) {
          return Math.max(0, Math.min(100, value));
        }

        function getDisplayPercentValue(window) {
          return state.percentDisplayMode === 'used' ? clamp(window.usedPercent) : clamp(100 - window.usedPercent);
        }

        function formatPercent(value) {
          const rounded = Math.round(value * 10) / 10;
          return Number.isInteger(rounded) ? rounded.toFixed(0) + '%' : rounded.toFixed(1) + '%';
        }

        function getDisplaySuffix() {
          return state.percentDisplayMode === 'used' ? 'used' : 'left';
        }

        function getTimeProgressPercent(window) {
          const resetMs = new Date(window.resetsAt).getTime();
          const windowMs = window.windowMinutes * 60 * 1000;
          const remainingMs = Math.max(0, resetMs - Date.now());
          return clamp(100 - ((remainingMs / windowMs) * 100));
        }

        function isOutdated(window) {
          return new Date(window.resetsAt).getTime() <= Date.now();
        }

        function escapeHtml(value) {
          return String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
        }

        function formatReset(iso) {
          return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
        }

        function formatTimestamp(iso) {
          return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso));
        }

        function severityClass(usedPercent, outdated) {
          if (outdated) return 'outdated';
          if (usedPercent >= state.criticalThreshold) return 'high';
          if (usedPercent >= state.warningThreshold) return 'medium';
          return 'low';
        }

        function formatTokenUsage(usage) {
          const format = (value) => Math.round(value / 1000).toLocaleString('en-US') + ' K';
          return 'input ' + format(usage.inputTokens) + ', cached ' + format(usage.cachedInputTokens) + ', output ' + format(usage.outputTokens) + ', reasoning ' + format(usage.reasoningOutputTokens);
        }

        function getRangeWindowMs(range) {
          if (range === 'day') return 24 * 60 * 60 * 1000;
          if (range === 'week') return 7 * 24 * 60 * 60 * 1000;
          if (range === 'month') return 31 * 24 * 60 * 60 * 1000;
          return 366 * 24 * 60 * 60 * 1000;
        }

        function buildHistorySeries(profile, range) {
          const samples = Array.isArray(profile.history) ? profile.history : [];
          const threshold = Date.now() - getRangeWindowMs(range);
          return samples.filter((sample) => new Date(sample.recordedAt).getTime() >= threshold);
        }

        function buildSparklinePath(points, width, height) {
          if (!points.length) return '';
          const step = points.length === 1 ? 0 : width / (points.length - 1);
          return points.map((point, index) => {
            const x = Math.round(index * step * 100) / 100;
            const y = Math.round((height - ((clamp(point) / 100) * height)) * 100) / 100;
            return (index === 0 ? 'M' : 'L') + x + ' ' + y;
          }).join(' ');
        }

        function renderHistorySection(profile) {
          const range = historyRangeSelect.value || 'week';
          const samples = buildHistorySeries(profile, range);
          if (!samples.length) {
            return '<section class="history"><div class="section-title">Usage History</div><div class="empty">No historical samples yet. This profile appears likely unused until Codex emits fresh usage data.</div></section>';
          }

          const primaryPoints = samples.map((sample) => typeof sample.primaryUsedPercent === 'number' ? sample.primaryUsedPercent : null).filter((value) => value !== null);
          const secondaryPoints = samples.map((sample) => typeof sample.secondaryUsedPercent === 'number' ? sample.secondaryUsedPercent : null).filter((value) => value !== null);
          const peakPrimary = primaryPoints.length ? Math.max(...primaryPoints) : 0;
          const peakSecondary = secondaryPoints.length ? Math.max(...secondaryPoints) : 0;
          const latest = samples[samples.length - 1];
          const pathWidth = 520;
          const pathHeight = 180;
          const primaryPath = buildSparklinePath(primaryPoints, pathWidth, pathHeight);
          const secondaryPath = buildSparklinePath(secondaryPoints, pathWidth, pathHeight);
          const latestText = latest ? formatTimestamp(latest.recordedAt) : 'N/A';

          return [
            '<section class="history">',
            '<div class="section-title">Usage History</div>',
            '<div class="history-stats">',
            '<div class="stat"><div class="stat-label">Range</div><div class="stat-value">' + escapeHtml(range.charAt(0).toUpperCase() + range.slice(1)) + '</div></div>',
            '<div class="stat"><div class="stat-label">Peak 5H Used</div><div class="stat-value">' + escapeHtml(formatPercent(peakPrimary)) + '</div></div>',
            '<div class="stat"><div class="stat-label">Peak Weekly Used</div><div class="stat-value">' + escapeHtml(formatPercent(peakSecondary)) + '</div></div>',
            '</div>',
            '<div class="chart-wrap">',
            '<svg viewBox="0 0 ' + pathWidth + ' ' + pathHeight + '" width="100%" height="180" role="img" aria-label="Usage history chart">',
            '<line x1="0" y1="0" x2="0" y2="' + pathHeight + '" stroke="rgba(255,255,255,0.15)" stroke-width="1"></line>',
            '<line x1="0" y1="' + pathHeight + '" x2="' + pathWidth + '" y2="' + pathHeight + '" stroke="rgba(255,255,255,0.15)" stroke-width="1"></line>',
            primaryPath ? '<path d="' + primaryPath + '" fill="none" stroke="#4CAF50" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>' : '',
            secondaryPath ? '<path d="' + secondaryPath + '" fill="none" stroke="#2196F3" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>' : '',
            '</svg>',
            '<div class="chart-legend">',
            '<span class="legend-chip"><span class="legend-line" style="background:#4CAF50"></span>5H used %</span>',
            '<span class="legend-chip"><span class="legend-line" style="background:#2196F3"></span>Weekly used %</span>',
            '<span class="legend-chip">Latest sample: ' + escapeHtml(latestText) + '</span>',
            '</div>',
            '</div>',
            '</section>'
          ].join('');
        }

        function renderWindowSection(title, window) {
          const outdated = isOutdated(window);
          const usedPercent = clamp(window.usedPercent);
          const displayPercent = getDisplayPercentValue(window);
          const timePercent = getTimeProgressPercent(window);
          const usageClass = severityClass(usedPercent, outdated);
          return [
            '<section class="section">',
            '<div class="section-title">' + escapeHtml(title) + '</div>',
            '<div class="row"><div class="label">Usage</div><div class="track"><div class="fill ' + usageClass + '" style="width:' + displayPercent + '%"></div></div><div class="value">' + (outdated ? 'N/A' : escapeHtml(formatPercent(displayPercent) + ' ' + getDisplaySuffix())) + '</div></div>',
            '<div class="row"><div class="label">Time</div><div class="track"><div class="fill time ' + (outdated ? 'outdated' : '') + '" style="width:' + timePercent + '%"></div></div><div class="value">' + (outdated ? 'N/A' : escapeHtml(formatPercent(timePercent))) + '</div></div>',
            '<div class="details">Reset: ' + escapeHtml(formatReset(window.resetsAt)) + (outdated ? ' [OUTDATED]' : '') + '</div>',
            '</section>'
          ].join('');
        }

        function renderTokenSection(profile) {
          if (!profile.snapshot?.totalUsage && !profile.snapshot?.lastUsage) {
            return '<section class="tokens"><h3>Token Usage</h3><div class="details">Likely unused so far. Prompt Codex on this profile to populate live token usage.</div></section>';
          }
          return [
            '<section class="tokens">',
            '<h3>Token Usage</h3>',
            profile.snapshot?.totalUsage ? '<div><strong>Total:</strong> ' + escapeHtml(formatTokenUsage(profile.snapshot.totalUsage)) + '</div>' : '',
            profile.snapshot?.lastUsage ? '<div><strong>Last:</strong> ' + escapeHtml(formatTokenUsage(profile.snapshot.lastUsage)) + '</div>' : '',
            profile.snapshot ? '<div class="details">Updated: ' + escapeHtml(formatTimestamp(profile.snapshot.recordedAt)) + '</div>' : '',
            profile.isStale ? '<div class="warning">Last-known data only. Use Codex once after switching to refresh it.</div>' : '',
            '</section>'
          ].join('');
        }

        function renderProfileCard(profile, roleLabel, roleClass, isCompareColumn) {
          const subtitleParts = [];
          if (profile.email && profile.email !== 'Unknown') subtitleParts.push(profile.email);
          if (profile.planType && profile.planType !== 'Unknown') subtitleParts.push(profile.planType);
          const snapshot = profile.snapshot;
          const noData = !snapshot?.primary && !snapshot?.secondary;
          const compareSelector = isCompareColumn
            ? '<select id="compareProfileInline"></select>'
            : '<h3 class="card-title">' + escapeHtml(profile.name) + '</h3>';
          const compareActions = isCompareColumn
            ? '<div class="card-header-inline"><span class="pill ' + roleClass + '">' + escapeHtml(roleLabel) + '</span><button id="switchProfileInline" class="secondary" type="button">Switch Now</button></div>'
            : '<span class="pill ' + roleClass + '">' + escapeHtml(roleLabel) + '</span>';
          return [
            '<article class="card">',
            '<div class="card-header">',
            '<div>',
            compareSelector,
            '<div class="card-subtitle">' + escapeHtml(subtitleParts.join(' • ') || 'No profile metadata') + '</div>',
            '</div>',
            compareActions,
            '</div>',
            noData ? '<div class="empty">Likely unused this cycle. Prompt Codex on this profile to replace this estimate with live usage data.</div>' : '',
            snapshot?.primary ? renderWindowSection('5-Hour Session', snapshot.primary) : '',
            snapshot?.secondary ? renderWindowSection('Weekly Limit', snapshot.secondary) : '',
            renderHistorySection(profile),
            renderTokenSection(profile),
            '</article>'
          ].join('');
        }

        function render() {
          const compareProfile = profilesById.get(selectedCompareProfileId) || activeProfile;
          activeColumn.innerHTML = renderProfileCard(activeProfile, 'Current', 'active', false);
          compareColumn.innerHTML = renderProfileCard(compareProfile, compareProfile.id === activeProfile.id ? 'Same Profile' : 'Compare', 'compare', true);

          const compareSelectInline = document.getElementById('compareProfileInline');
          const switchInlineButton = document.getElementById('switchProfileInline');
          if (compareSelectInline) {
            compareSelectInline.innerHTML = '';
            for (const profile of state.profiles) {
              if (profile.id === state.activeProfileId) continue;
              const option = document.createElement('option');
              option.value = profile.id;
              option.textContent = profile.name + (profile.email && profile.email !== 'Unknown' ? ' • ' + profile.email : '');
              compareSelectInline.appendChild(option);
            }
            if (!compareSelectInline.options.length) {
              const option = document.createElement('option');
              option.value = state.activeProfileId;
              option.textContent = 'No other saved profiles';
              compareSelectInline.appendChild(option);
              compareSelectInline.disabled = true;
            }
            compareSelectInline.value = selectedCompareProfileId;
            compareSelectInline.addEventListener('change', (event) => {
              selectedCompareProfileId = event.target.value;
              render();
            });
          }
          if (switchInlineButton) {
            switchInlineButton.disabled = compareProfile.id === activeProfile.id;
            switchInlineButton.addEventListener('click', () => {
              const profileId = selectedCompareProfileId;
              if (!profileId || profileId === state.activeProfileId) return;
              vscode.postMessage({ type: 'switchProfile', profileId });
            });
          }
        }

        historyRangeSelect.addEventListener('change', render);

        render();
      </script>
    </body>
  </html>`;
}

async function exportProfiles(): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    saveLabel: 'Export profiles',
    defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(), 'codex-account-switcher-profiles.json')),
    filters: { JSON: ['json'] }
  });

  if (!target) {
    return;
  }

  const payload = await profileStore.exportProfiles();
  await fs.writeFile(target.fsPath, JSON.stringify(payload, null, 2), 'utf8');
  void vscode.window.showInformationMessage(`Exported ${payload.profiles.length} profiles.`);
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
    const result = await profileStore.importProfiles(JSON.parse(raw) as unknown);
    void vscode.window.showInformationMessage(`Imported profiles: created ${result.created}, updated ${result.updated}, skipped ${result.skipped}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown import error.';
    void vscode.window.showErrorMessage(`Failed to import profiles: ${message}`);
  }
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

function buildUsageStatusText(snapshot?: UsageSnapshot): string {
  if (!snapshot) {
    const estimate = getLikelyUnusedPercentText();
    return `⚡ 5H: ${estimate} | Weekly: ${estimate}`;
  }

  const primaryText = snapshot.primary && !isUsageOutdated(snapshot.primary)
    ? `${formatDisplayPercentCompact(snapshot.primary)} ${getPercentDisplaySuffixCompact()}`
    : getLikelyUnusedPercentText();
  const weeklyText = snapshot.secondary && !isUsageOutdated(snapshot.secondary)
    ? `${formatDisplayPercentCompact(snapshot.secondary)} ${getPercentDisplaySuffixCompact()}`
    : getLikelyUnusedPercentText();
  return `⚡ 5H: ${primaryText} | Weekly: ${weeklyText}`;
}

function buildUsageWindowInline(label: string, window: UsageWindow): string {
  return `${label} ${buildUsageBar(window)} ${formatDisplayPercent(window)} ${getPercentDisplaySuffixLong()} | resets ${formatResetShort(window.resetsAt)}`;
}

function buildPickerUsageDetailLine(label: string, window: UsageWindow): string {
  return `${label}: ${formatDisplayPercent(window)} ${getPercentDisplaySuffixLong()} (${formatResetShort(window.resetsAt)})`;
}

function buildLikelyUnusedPickerDetailLine(): string {
  const estimate = getLikelyUnusedPercentText();
  return `$(pulse) 5H: ${estimate} ${getPercentDisplaySuffixLong()} (likely unused)  •  $(calendar) Weekly: ${estimate} ${getPercentDisplaySuffixLong()} (likely unused)`;
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
  const warningColor = getConfig().get<string>(USAGE_WARNING_COLOR_SETTING, '#f3d898');
  const criticalColor = getConfig().get<string>(USAGE_CRITICAL_COLOR_SETTING, '#eca7a7');

  if (usedPercent >= criticalThreshold) {
    return criticalColor;
  }
  if (usedPercent >= warningThreshold) {
    return warningColor;
  }
  return new vscode.ThemeColor('statusBarItem.foreground');
}

function getMaxUsedPercent(snapshot: UsageSnapshot): number {
  return Math.max(snapshot.primary?.usedPercent ?? 0, snapshot.secondary?.usedPercent ?? 0);
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

