import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  AccountConfig,
  expandPath,
  getActiveAuthPath,
  getBackupPath,
  getEnabledAccounts,
  getTimestamp,
  normalizeAccounts,
  resolveCodexHome,
  validateJsonObjectText
} from './core';

const EXT_NS = 'codexAccountSwitcher';
const CMD_SWITCH = 'codexAccountSwitcher.switchAccount';
const CMD_ADD = 'codexAccountSwitcher.addAccount';
const CMD_DELETE = 'codexAccountSwitcher.deleteAccount';
const CMD_EDIT = 'codexAccountSwitcher.editAccounts';
const CMD_RELOAD = 'codexAccountSwitcher.reloadWindow';
const CMD_EXPORT = 'codexAccountSwitcher.exportActiveAuth';
const STATUS_SIDE_SETTING = 'statusBarSide';
const RELOAD_TARGET_SETTING = 'reloadTarget';
const CMD_RESTART_EXTENSION_HOST = 'workbench.action.restartExtensionHost';

let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Codex Account Switcher');
  context.subscriptions.push(output);

  createStatusBarItem();
  context.subscriptions.push({ dispose: () => statusBar.dispose() });

  context.subscriptions.push(vscode.commands.registerCommand(CMD_SWITCH, () => switchAccountViaPicker(context)));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_ADD, () => addAccount()));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_DELETE, () => deleteAccount()));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_EDIT, () => editAccounts()));
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_RELOAD, () => vscode.commands.executeCommand('workbench.action.reloadWindow'))
  );
  context.subscriptions.push(vscode.commands.registerCommand(CMD_EXPORT, () => exportActiveAuth()));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(EXT_NS)) {
      if (e.affectsConfiguration(`${EXT_NS}.${STATUS_SIDE_SETTING}`)) {
        recreateStatusBarItem();
      }
      void refreshStatusBar();
    }
  }));

  void maybeWarnEnsureFileBasedCreds(context);
  void refreshStatusBar();
}

export function deactivate(): void {}

function getStatusBarAlignment(): vscode.StatusBarAlignment {
  const side = getConfig().get<string>(STATUS_SIDE_SETTING, 'right').toLowerCase();
  return side === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
}

function createStatusBarItem(): void {
  statusBar = vscode.window.createStatusBarItem(getStatusBarAlignment(), 1000);
  statusBar.command = CMD_SWITCH;
}

function recreateStatusBarItem(): void {
  statusBar.dispose();
  createStatusBarItem();
}

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(EXT_NS);
}

function getAccounts(): AccountConfig[] {
  return normalizeAccounts(getConfig().get<unknown>('accounts', []));
}

function getResolvedCodexHome(): string {
  const config = getConfig();
  return resolveCodexHome({
    configuredCodexHome: config.get<string>('codexHome', ''),
    envCodexHome: process.env.CODEX_HOME,
    homeDir: os.homedir(),
    platform: process.platform,
    envHome: process.env.HOME,
    envUserProfile: process.env.USERPROFILE
  });
}

function resolveAccountAuthPath(account: AccountConfig, codexHome: string): string {
  return expandPath(account.authFile, {
    codexHome,
    homeDir: os.homedir(),
    platform: process.platform,
    envHome: process.env.HOME,
    envUserProfile: process.env.USERPROFILE
  });
}

async function safeExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function validateJsonObjectFile(filePath: string): Promise<{ valid: true } | { valid: false; reason: string }> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return validateJsonObjectText(content);
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : 'Unknown parse error' };
  }
}

async function atomicCopy(src: string, dest: string): Promise<void> {
  const tmp = `${dest}.tmp`;
  await fs.copyFile(src, tmp);
  try {
    await fs.rename(tmp, dest);
  } catch {
    await fs.rm(dest, { force: true });
    await fs.rename(tmp, dest);
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
    'Codex Account Switcher swaps auth files. If Codex uses OS keychain storage, switching may not take effect.'
  );
}

async function refreshStatusBar(): Promise<void> {
  const active = getConfig().get<string>('activeAccount', '').trim();
  const enabledAccounts = getEnabledAccounts(getAccounts());
  const activeExists = enabledAccounts.some((a) => a.name === active);

  if (activeExists) {
    statusBar.text = `$(account) ${active}`;
    statusBar.tooltip = 'Switch Codex account';
  } else {
    statusBar.text = '$(tools) Setup';
    statusBar.tooltip = 'Configure Codex account snapshots';
  }

  statusBar.show();
}

async function ensureCodexHomeReady(codexHome: string, setupMode: boolean): Promise<boolean> {
  if (await safeExists(codexHome)) {
    return true;
  }

  const create = 'Create folder';
  const settings = 'Open settings';
  const message = setupMode
    ? `Codex home folder does not exist: ${codexHome}`
    : `Codex home is missing: ${codexHome}`;

  const action = await vscode.window.showWarningMessage(message, create, settings);

  if (action === create) {
    await fs.mkdir(codexHome, { recursive: true });
    output.appendLine(`Created codexHome folder at ${codexHome}`);
    return true;
  }

  if (action === settings) {
    await editAccounts();
  }

  return false;
}

async function runSetupWizard(context: vscode.ExtensionContext, reason?: string): Promise<void> {
  await maybeWarnEnsureFileBasedCreds(context);

  const codexHome = getResolvedCodexHome();
  const exists = await ensureCodexHomeReady(codexHome, true);
  if (!exists) {
    return;
  }

  const picks = [
    {
      label: 'Add account now',
      description: 'Create a snapshot entry and configure it in settings.',
      value: 'add'
    },
    {
      label: '$(trash) Delete account',
      description: 'Remove an account entry from settings.',
      value: 'delete'
    },
    {
      label: '$(gear) Open settings',
      description: 'Open Codex Account Switcher settings.',
      value: 'settings'
    }
  ];

  const selected = await vscode.window.showQuickPick(picks, {
    placeHolder: reason ?? 'Codex Account Switcher setup'
  });

  if (!selected) {
    return;
  }

  if (selected.value === 'add') {
    await addAccount();
    return;
  }

  if (selected.value === 'delete') {
    await deleteAccount();
    return;
  }

  if (selected.value === 'settings') {
    await editAccounts();
    return;
  }
}

async function switchAccountViaPicker(context: vscode.ExtensionContext): Promise<void> {
  await maybeWarnEnsureFileBasedCreds(context);

  const enabledAccounts = getEnabledAccounts(getAccounts());
  if (enabledAccounts.length === 0) {
    await runSetupWizard(context, 'No enabled accounts configured.');
    return;
  }

  const picks: vscode.QuickPickItem[] = enabledAccounts.map((a) => ({ label: a.name }));
  picks.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  picks.push({ label: '$(add) Add account...', detail: 'Create a new account snapshot entry.' });
  picks.push({ label: '$(trash) Delete account...', detail: 'Remove an account snapshot entry.' });
  picks.push({ label: '$(gear) Open settings', detail: 'Edit Codex Account Switcher settings.' });

  const chosen = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Select a Codex account or action'
  });

  if (!chosen) {
    return;
  }

  if (chosen.label === '$(add) Add account...') {
    await addAccount();
    return;
  }

  if (chosen.label === '$(trash) Delete account...') {
    await deleteAccount();
    return;
  }

  if (chosen.label === '$(gear) Open settings') {
    await editAccounts();
    return;
  }

  await switchTo(chosen.label, context);
}

async function switchTo(accountName: string, context: vscode.ExtensionContext): Promise<void> {
  const config = getConfig();
  const account = getAccounts().find((a) => a.name === accountName);

  if (!account) {
    void vscode.window.showErrorMessage(`Account '${accountName}' is not configured.`);
    return;
  }

  if (account.enabled === false) {
    void vscode.window.showErrorMessage(`Account '${accountName}' is disabled.`);
    return;
  }

  const codexHome = getResolvedCodexHome();
  if (!codexHome.trim()) {
    await runSetupWizard(context, 'Codex home could not be resolved.');
    return;
  }

  if (!(await ensureCodexHomeReady(codexHome, false))) {
    await runSetupWizard(context, 'Codex home setup is required before switching accounts.');
    return;
  }

  const confirm = config.get<boolean>('confirmBeforeSwitch', false);
  if (confirm) {
    const yes = 'Switch';
    const choice = await vscode.window.showWarningMessage(
      `Switch Codex account to '${accountName}'?`,
      { modal: true },
      yes
    );
    if (choice !== yes) {
      return;
    }
  }

  const activeAuthPath = getActiveAuthPath(codexHome);
  const snapshotPath = resolveAccountAuthPath(account, codexHome);

  if (!(await safeExists(snapshotPath))) {
    const createChoice = 'Create from current auth';
    const choice = await vscode.window.showErrorMessage(
      `Snapshot file not found: ${snapshotPath}`,
      createChoice,
      'Cancel'
    );

    if (choice !== createChoice) {
      return;
    }

    if (!(await safeExists(activeAuthPath))) {
      void vscode.window.showErrorMessage(`Cannot create snapshot. Active auth file is missing: ${activeAuthPath}`);
      return;
    }

    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.copyFile(activeAuthPath, snapshotPath);
    output.appendLine(`Created snapshot '${accountName}' at ${snapshotPath}`);
  }

  const validation = await validateJsonObjectFile(snapshotPath);
  if (!validation.valid) {
    const open = await vscode.window.showErrorMessage(
      `Invalid JSON in snapshot '${accountName}': ${validation.reason}`,
      'Open file'
    );
    if (open === 'Open file') {
      const doc = await vscode.workspace.openTextDocument(snapshotPath);
      await vscode.window.showTextDocument(doc, { preview: false });
    }
    return;
  }

  const backup = config.get<boolean>('backupActiveAuth', true);
  if (backup && (await safeExists(activeAuthPath))) {
    const backupPath = getBackupPath(codexHome, getTimestamp());
    await fs.copyFile(activeAuthPath, backupPath);
    output.appendLine(`Backed up active auth to ${backupPath}`);
  }

  await fs.mkdir(path.dirname(activeAuthPath), { recursive: true });
  await atomicCopy(snapshotPath, activeAuthPath);

  await config.update('activeAccount', accountName, vscode.ConfigurationTarget.Global);
  await refreshStatusBar();

  output.appendLine(`Switched active account to '${accountName}'`);
  await maybeReloadAfterSwitch(accountName);
}

function hasDirtyEditors(): boolean {
  return vscode.workspace.textDocuments.some((doc) => doc.isDirty);
}

async function maybeReloadAfterSwitch(accountName: string): Promise<void> {
  const config = getConfig();
  const reloadTarget = config.get<string>(RELOAD_TARGET_SETTING, 'extensionHost');

  const triggerReload = (): void => {
    // Fire asynchronously so reload/restart does not bubble a command-cancel error toast.
    setTimeout(() => {
      if (reloadTarget === 'extensionHost') {
        void vscode.commands.executeCommand(CMD_RESTART_EXTENSION_HOST);
        return;
      }
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }, 25);
  };

  const reloadAction = async (): Promise<void> => {
    if (reloadTarget === 'extensionHost') {
      try {
        triggerReload();
        return;
      } catch {
        output.appendLine('Restart Extension Host failed; falling back to full window reload.');
      }
    }
    setTimeout(() => {
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }, 25);
  }

  const dirty = hasDirtyEditors();
  if (dirty) {
    const choice = await vscode.window.showWarningMessage(
      `Switched Codex account to: ${accountName}. You have unsaved editors. Reload now?`,
      { modal: true },
      'Reload now',
      'Cancel'
    );
    if (choice === 'Reload now') {
      await reloadAction();
    } else {
      void vscode.window.showInformationMessage(
        `Switched Codex account to: ${accountName}. Reload when ready to apply auth to running tools.`
      );
    }
    return;
  }

  void vscode.window.showInformationMessage(`Switched Codex account to: ${accountName}. Reloading...`);
  await reloadAction();
}

async function addAccount(): Promise<void> {
  const name = (await vscode.window.showInputBox({
    prompt: 'New Codex account name',
    placeHolder: 'Personal',
    validateInput: (value) => {
      const v = value.trim();
      if (!v) {
        return 'Name is required.';
      }
      if (getAccounts().some((a) => a.name.toLowerCase() === v.toLowerCase())) {
        return 'Account name already exists.';
      }
      return undefined;
    }
  }))?.trim();

  if (!name) {
    return;
  }

  const method = await vscode.window.showQuickPick(
    [
      { label: 'Snapshot current active auth.json', value: 'snapshotCurrent' as const },
      { label: 'Select an existing auth snapshot file', value: 'selectExisting' as const },
      { label: 'Cancel', value: 'cancel' as const }
    ],
    { placeHolder: 'How do you want to create it?' }
  );

  if (!method || method.value === 'cancel') {
    return;
  }

  const codexHome = getResolvedCodexHome();
  if (!(await ensureCodexHomeReady(codexHome, true))) {
    return;
  }

  const defaultSnapshotPath = path.join(codexHome, `auth.${name}.json`);
  let authFilePath = defaultSnapshotPath;

  if (method.value === 'snapshotCurrent') {
    const activeAuthPath = getActiveAuthPath(codexHome);
    if (!(await safeExists(activeAuthPath))) {
      void vscode.window.showErrorMessage(`Active auth file does not exist: ${activeAuthPath}`);
      return;
    }

    await fs.mkdir(path.dirname(defaultSnapshotPath), { recursive: true });
    await fs.copyFile(activeAuthPath, defaultSnapshotPath);
    output.appendLine(`Created snapshot for '${name}' at ${defaultSnapshotPath}`);
  } else {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      canSelectFolders: false,
      openLabel: 'Use snapshot file'
    });

    if (!selected || selected.length === 0) {
      return;
    }

    authFilePath = selected[0].fsPath;
  }

  const accounts = getAccounts();
  accounts.push({ name, authFile: authFilePath, enabled: true });
  await getConfig().update('accounts', accounts, vscode.ConfigurationTarget.Global);

  const setActive = await vscode.window.showQuickPick(['Yes', 'No'], {
    placeHolder: `Set '${name}' as activeAccount setting now?`
  });

  if (setActive === 'Yes') {
    await getConfig().update('activeAccount', name, vscode.ConfigurationTarget.Global);
  }

  await refreshStatusBar();
  void vscode.window.showInformationMessage(`Added Codex account '${name}'.`);
}

async function deleteAccount(): Promise<void> {
  const accounts = getAccounts();
  if (accounts.length === 0) {
    void vscode.window.showInformationMessage('No accounts configured.');
    return;
  }

  const pick = await vscode.window.showQuickPick(
    accounts.map((a) => ({ label: a.name, description: a.enabled === false ? 'disabled' : undefined })),
    { placeHolder: 'Select account to delete' }
  );
  if (!pick) {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Delete account '${pick.label}' from settings?`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') {
    return;
  }

  const nextAccounts = accounts.filter((a) => a.name !== pick.label);
  await getConfig().update('accounts', nextAccounts, vscode.ConfigurationTarget.Global);

  const active = getConfig().get<string>('activeAccount', '').trim();
  if (active === pick.label) {
    const nextActive = getEnabledAccounts(nextAccounts)[0]?.name ?? '';
    await getConfig().update('activeAccount', nextActive, vscode.ConfigurationTarget.Global);
  }

  await refreshStatusBar();
  void vscode.window.showInformationMessage(`Deleted Codex account '${pick.label}'.`);
}

async function editAccounts(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', 'codexAccountSwitcher');
  const openJson = await vscode.window.showQuickPick(['Open settings.json', 'Done'], {
    placeHolder: 'Optional: open raw JSON settings file'
  });

  if (openJson === 'Open settings.json') {
    await vscode.commands.executeCommand('workbench.action.openSettingsJson');
  }
}

async function exportActiveAuth(): Promise<void> {
  const codexHome = getResolvedCodexHome();
  if (!(await ensureCodexHomeReady(codexHome, false))) {
    return;
  }

  const activeAuthPath = getActiveAuthPath(codexHome);
  if (!(await safeExists(activeAuthPath))) {
    void vscode.window.showErrorMessage(`Active auth file not found: ${activeAuthPath}`);
    return;
  }

  const target = await vscode.window.showSaveDialog({
    saveLabel: 'Export auth snapshot',
    defaultUri: vscode.Uri.file(path.join(codexHome, `auth.export.${getTimestamp()}.json`))
  });

  if (!target) {
    return;
  }

  await fs.copyFile(activeAuthPath, target.fsPath);
  output.appendLine(`Exported active auth to ${target.fsPath}`);
  void vscode.window.showInformationMessage('Exported active auth snapshot.');
}
