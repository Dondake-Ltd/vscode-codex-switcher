import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { AuthData, getResolvedActiveAuthPath, getResolvedCodexConfigPath, loadAuthDataFromFile, loadCodexConfigText, syncAuthFile, syncCodexConfigFile } from './auth';
import { AccountConfig } from './core';

export type StorageMode = 'auto' | 'secretStorage' | 'remoteFiles';

export type ProfileSummary = {
  id: string;
  name: string;
  email: string;
  planType: string;
  accountId?: string;
  defaultOrganizationId?: string;
  defaultOrganizationTitle?: string;
  chatgptUserId?: string;
  userId?: string;
  subject?: string;
  createdAt: string;
  updatedAt: string;
};

type StoredProfileSecret = {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId?: string;
  authJson: Record<string, unknown>;
  codexConfigText?: string;
};

type ProfilesFile = {
  version: 1;
  profiles: ProfileSummary[];
};

type ExportedProfile = {
  profile: ProfileSummary;
  secret: StoredProfileSecret;
};

type ExportedTransfer = {
  format: 'codex-account-switcher-profiles';
  version: 1;
  exportedAt: string;
  activeProfileId?: string;
  lastProfileId?: string;
  profiles: ExportedProfile[];
};

const ACTIVE_PROFILE_KEY = 'codexAccountSwitcher.activeProfileId';
const LAST_PROFILE_KEY = 'codexAccountSwitcher.lastProfileId';
const MIGRATED_ACCOUNTS_KEY = 'codexAccountSwitcher.migratedLegacyAccounts';
const PROFILES_FILENAME = 'profiles.json';
const SHARED_ROOT = '.codex-account-switcher';
const SHARED_PROFILES_DIR = 'profiles';
const SHARED_ACTIVE_FILENAME = 'active-profile.json';
const SECRET_PREFIX = 'codexAccountSwitcher.profile.';

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export class ProfileStore {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  private getConfiguredStorageMode(): StorageMode {
    const raw = vscode.workspace.getConfiguration('codexAccountSwitcher').get<StorageMode>('storageMode', 'auto');
    return raw === 'remoteFiles' || raw === 'secretStorage' || raw === 'auto' ? raw : 'auto';
  }

  private getResolvedStorageMode(): Exclude<StorageMode, 'auto'> {
    const configured = this.getConfiguredStorageMode();
    if (configured === 'auto') {
      return vscode.env.remoteName === 'ssh-remote' ? 'remoteFiles' : 'secretStorage';
    }
    return configured;
  }

  private isRemoteFilesMode(): boolean {
    return this.getResolvedStorageMode() === 'remoteFiles';
  }

  private getStorageDir(): string {
    return this.isRemoteFilesMode()
      ? path.join(os.homedir(), SHARED_ROOT)
      : this.context.globalStorageUri.fsPath;
  }

  private getProfilesPath(): string {
    return path.join(this.getStorageDir(), PROFILES_FILENAME);
  }

  private getRemoteSecretsDir(): string {
    return path.join(this.getStorageDir(), SHARED_PROFILES_DIR);
  }

  private getRemoteSecretPath(profileId: string): string {
    return path.join(this.getRemoteSecretsDir(), `${profileId}.json`);
  }

  private getSharedActivePath(): string {
    return path.join(this.getStorageDir(), SHARED_ACTIVE_FILENAME);
  }

  private async ensureStorageDir(): Promise<void> {
    await fsp.mkdir(this.getStorageDir(), { recursive: true });
    if (this.isRemoteFilesMode()) {
      await fsp.mkdir(this.getRemoteSecretsDir(), { recursive: true });
    }
  }

  private normalizeIdentity(value?: string): string {
    return String(value ?? '').trim();
  }

  private normalizeEmail(value?: string): string {
    return this.normalizeIdentity(value).toLowerCase();
  }

  private compareIdentityField(profileValue?: string, authValue?: string): boolean | undefined {
    const profileNormalized = this.normalizeIdentity(profileValue);
    const authNormalized = this.normalizeIdentity(authValue);
    if (!profileNormalized || !authNormalized) {
      return undefined;
    }
    return profileNormalized === authNormalized;
  }

  private normalizePlanType(value?: string): string {
    return this.normalizeIdentity(value).toLowerCase();
  }

  private isKnownPlanType(value?: string): boolean {
    const normalized = this.normalizePlanType(value);
    return Boolean(normalized && normalized !== 'unknown');
  }

  private isWorkspaceScopedPlanType(value?: string): boolean {
    const normalized = this.normalizePlanType(value);
    return ['team', 'business', 'edu', 'enterprise'].some((token) => normalized.includes(token));
  }

  private isPersonalPlanType(value?: string): boolean {
    const normalized = this.normalizePlanType(value);
    return ['free', 'plus', 'pro'].some((token) => normalized.includes(token));
  }

  private hasSameEffectiveContext(profile: ProfileSummary, authData: AuthData): boolean {
    const accountIdMatch = this.compareIdentityField(profile.accountId, authData.accountId);
    if (accountIdMatch === false) {
      return false;
    }

    const profilePlan = this.normalizePlanType(profile.planType);
    const authPlan = this.normalizePlanType(authData.planType);
    if (this.isKnownPlanType(profilePlan) && this.isKnownPlanType(authPlan) && profilePlan !== authPlan) {
      return false;
    }

    const organizationMatch = this.compareIdentityField(profile.defaultOrganizationId, authData.defaultOrganizationId);
    const hasProfileOrg = Boolean(this.normalizeIdentity(profile.defaultOrganizationId));
    const hasAuthOrg = Boolean(this.normalizeIdentity(authData.defaultOrganizationId));

    if (hasProfileOrg || hasAuthOrg) {
      return organizationMatch === true;
    }

    const profileWorkspaceScoped = this.isWorkspaceScopedPlanType(profilePlan);
    const authWorkspaceScoped = this.isWorkspaceScopedPlanType(authPlan);
    const profilePersonal = this.isPersonalPlanType(profilePlan);
    const authPersonal = this.isPersonalPlanType(authPlan);

    if (profileWorkspaceScoped !== authWorkspaceScoped && (profileWorkspaceScoped || authWorkspaceScoped)) {
      return false;
    }

    if (profilePersonal !== authPersonal && (profilePersonal || authPersonal)) {
      return false;
    }

    return true;
  }

  private matchesAuth(profile: ProfileSummary, authData: AuthData): boolean {
    const identityMatches = [
      this.compareIdentityField(profile.chatgptUserId, authData.chatgptUserId),
      this.compareIdentityField(profile.userId, authData.userId),
      this.compareIdentityField(profile.subject, authData.subject)
    ].filter((value): value is boolean => value !== undefined);

    if (identityMatches.length > 0) {
      if (identityMatches.some((value) => !value)) {
        return false;
      }
      return this.hasSameEffectiveContext(profile, authData);
    }

    const profileEmail = this.normalizeEmail(profile.email);
    const authEmail = this.normalizeEmail(authData.email);
    const emailComparable = profileEmail && authEmail && profileEmail !== 'unknown' && authEmail !== 'unknown';
    const accountComparable = Boolean(profile.accountId && authData.accountId);

    if (!emailComparable) {
      return false;
    }

    if (accountComparable && profile.accountId !== authData.accountId) {
      return false;
    }

    if (profileEmail !== authEmail) {
      return false;
    }

    return this.hasSameEffectiveContext(profile, authData);
  }

  private async readProfilesFile(): Promise<ProfilesFile> {
    await this.ensureStorageDir();
    try {
      const raw = await fsp.readFile(this.getProfilesPath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<ProfilesFile> | ProfileSummary[];
      if (Array.isArray(parsed)) {
        return { version: 1, profiles: parsed as ProfileSummary[] };
      }
      if (parsed && parsed.version === 1 && Array.isArray(parsed.profiles)) {
        return { version: 1, profiles: parsed.profiles };
      }
      if (parsed && Array.isArray((parsed as { profiles?: ProfileSummary[] }).profiles)) {
        return { version: 1, profiles: (parsed as { profiles: ProfileSummary[] }).profiles };
      }
    } catch {
      // ignore corruption and recreate empty store
    }

    return { version: 1, profiles: [] };
  }

  private async writeProfilesFile(file: ProfilesFile): Promise<void> {
    await this.ensureStorageDir();
    await fsp.writeFile(this.getProfilesPath(), JSON.stringify(file, null, 2), 'utf8');
  }

  private async readStoredSecret(profileId: string): Promise<StoredProfileSecret | null> {
    if (this.isRemoteFilesMode()) {
      try {
        const raw = await fsp.readFile(this.getRemoteSecretPath(profileId), 'utf8');
        return JSON.parse(raw) as StoredProfileSecret;
      } catch {
        return null;
      }
    }

    const raw = await this.context.secrets.get(`${SECRET_PREFIX}${profileId}`);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as StoredProfileSecret;
    } catch {
      return null;
    }
  }

  private async writeStoredSecret(profileId: string, secret: StoredProfileSecret): Promise<void> {
    if (this.isRemoteFilesMode()) {
      await this.ensureStorageDir();
      await fsp.writeFile(this.getRemoteSecretPath(profileId), JSON.stringify(secret, null, 2), 'utf8');
      return;
    }

    await this.context.secrets.store(`${SECRET_PREFIX}${profileId}`, JSON.stringify(secret));
  }

  private async deleteStoredSecret(profileId: string): Promise<void> {
    if (this.isRemoteFilesMode()) {
      await fsp.rm(this.getRemoteSecretPath(profileId), { force: true });
      return;
    }

    await this.context.secrets.delete(`${SECRET_PREFIX}${profileId}`);
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    const file = await this.readProfilesFile();
    return [...file.profiles].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getProfile(profileId: string): Promise<ProfileSummary | undefined> {
    const profiles = await this.listProfiles();
    return profiles.find((profile) => profile.id === profileId);
  }

  async loadAuthData(profileId: string): Promise<AuthData | null> {
    const profile = await this.getProfile(profileId);
    const secret = await this.readStoredSecret(profileId);
    if (!profile || !secret) {
      return null;
    }

    return {
      idToken: secret.idToken,
      accessToken: secret.accessToken,
      refreshToken: secret.refreshToken,
      accountId: secret.accountId ?? profile.accountId,
      defaultOrganizationId: profile.defaultOrganizationId,
      defaultOrganizationTitle: profile.defaultOrganizationTitle,
      chatgptUserId: profile.chatgptUserId,
      userId: profile.userId,
      subject: profile.subject,
      email: profile.email,
      planType: profile.planType,
      authJson: secret.authJson,
      codexConfigText: secret.codexConfigText
    };
  }

  async findDuplicateProfile(authData: AuthData): Promise<ProfileSummary | undefined> {
    const profiles = await this.listProfiles();
    return profiles.find((profile) => this.matchesAuth(profile, authData));
  }

  private buildProfileSummary(id: string, name: string, authData: AuthData, createdAt?: string): ProfileSummary {
    const now = new Date().toISOString();
    return {
      id,
      name,
      email: authData.email,
      planType: authData.planType,
      accountId: authData.accountId,
      defaultOrganizationId: authData.defaultOrganizationId,
      defaultOrganizationTitle: authData.defaultOrganizationTitle,
      chatgptUserId: authData.chatgptUserId,
      userId: authData.userId,
      subject: authData.subject,
      createdAt: createdAt ?? now,
      updatedAt: now
    };
  }

  private buildStoredSecret(authData: AuthData): StoredProfileSecret {
    return {
      idToken: authData.idToken,
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
      accountId: authData.accountId,
      authJson: authData.authJson,
      codexConfigText: authData.codexConfigText
    };
  }

  async createProfile(name: string, authData: AuthData): Promise<ProfileSummary> {
    const file = await this.readProfilesFile();
    const id = randomUUID();
    const summary = this.buildProfileSummary(id, name, authData);
    file.profiles.push(summary);
    await this.writeProfilesFile(file);
    await this.writeStoredSecret(id, this.buildStoredSecret(authData));
    return summary;
  }

  async replaceProfileAuth(profileId: string, authData: AuthData): Promise<boolean> {
    const file = await this.readProfilesFile();
    const index = file.profiles.findIndex((profile) => profile.id === profileId);
    if (index === -1) {
      return false;
    }

    file.profiles[index] = this.buildProfileSummary(
      file.profiles[index].id,
      file.profiles[index].name,
      authData,
      file.profiles[index].createdAt
    );
    await this.writeProfilesFile(file);
    await this.writeStoredSecret(profileId, this.buildStoredSecret(authData));
    return true;
  }

  async renameProfile(profileId: string, newName: string): Promise<boolean> {
    const file = await this.readProfilesFile();
    const index = file.profiles.findIndex((profile) => profile.id === profileId);
    if (index === -1) {
      return false;
    }

    file.profiles[index] = {
      ...file.profiles[index],
      name: newName,
      updatedAt: new Date().toISOString()
    };
    await this.writeProfilesFile(file);
    return true;
  }

  async deleteProfile(profileId: string): Promise<boolean> {
    const file = await this.readProfilesFile();
    const nextProfiles = file.profiles.filter((profile) => profile.id !== profileId);
    if (nextProfiles.length === file.profiles.length) {
      return false;
    }

    file.profiles = nextProfiles;
    await this.writeProfilesFile(file);
    await this.deleteStoredSecret(profileId);

    const activeProfileId = await this.getActiveProfileId();
    if (activeProfileId === profileId) {
      await this.setActiveProfileId(nextProfiles[0]?.id);
    }

    const lastProfileId = await this.getLastProfileId();
    if (lastProfileId === profileId) {
      await this.context.globalState.update(LAST_PROFILE_KEY, undefined);
    }

    return true;
  }

  async getActiveProfileId(): Promise<string | undefined> {
    if (this.isRemoteFilesMode()) {
      try {
        const raw = await fsp.readFile(this.getSharedActivePath(), 'utf8');
        const parsed = JSON.parse(raw) as { profileId?: string };
        return asOptionalString(parsed.profileId);
      } catch {
        return undefined;
      }
    }

    return this.context.globalState.get<string>(ACTIVE_PROFILE_KEY);
  }

  async getLastProfileId(): Promise<string | undefined> {
    return this.context.globalState.get<string>(LAST_PROFILE_KEY);
  }

  async setActiveProfileId(profileId: string | undefined): Promise<boolean> {
    const previous = await this.getActiveProfileId();
    if (profileId) {
      const authData = await this.loadAuthData(profileId);
      if (!authData) {
        return false;
      }
      await syncAuthFile(getResolvedActiveAuthPath(), authData);
      if (authData.codexConfigText) {
        await syncCodexConfigFile(getResolvedCodexConfigPath(), authData.codexConfigText);
      }
    }

    if (this.isRemoteFilesMode()) {
      await this.ensureStorageDir();
      if (profileId) {
        await fsp.writeFile(this.getSharedActivePath(), JSON.stringify({ profileId, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
      } else {
        await fsp.rm(this.getSharedActivePath(), { force: true });
      }
    } else {
      await this.context.globalState.update(ACTIVE_PROFILE_KEY, profileId);
    }

    if (previous && profileId && previous !== profileId) {
      await this.context.globalState.update(LAST_PROFILE_KEY, previous);
    }

    return true;
  }

  async syncActiveProfileToAuthFile(): Promise<void> {
    const activeProfileId = await this.getActiveProfileId();
    if (!activeProfileId) {
      return;
    }

    const authData = await this.loadAuthData(activeProfileId);
    if (!authData) {
      return;
    }

    await syncAuthFile(getResolvedActiveAuthPath(), authData);
    if (authData.codexConfigText) {
      await syncCodexConfigFile(getResolvedCodexConfigPath(), authData.codexConfigText);
    }
  }

  async exportProfiles(): Promise<ExportedTransfer> {
    const profiles = await this.listProfiles();
    const exportedProfiles: ExportedProfile[] = [];
    for (const profile of profiles) {
      const secret = await this.readStoredSecret(profile.id);
      if (secret) {
        exportedProfiles.push({ profile, secret });
      }
    }

    return {
      format: 'codex-account-switcher-profiles',
      version: 1,
      exportedAt: new Date().toISOString(),
      activeProfileId: await this.getActiveProfileId(),
      lastProfileId: await this.getLastProfileId(),
      profiles: exportedProfiles
    };
  }

  async importProfiles(payload: unknown): Promise<{ created: number; updated: number; skipped: number }> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Invalid profile export payload.');
    }

    const parsed = payload as Partial<ExportedTransfer>;
    if (parsed.format !== 'codex-account-switcher-profiles' || parsed.version !== 1 || !Array.isArray(parsed.profiles)) {
      throw new Error('Unsupported profile export format.');
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const sourceToTarget = new Map<string, string>();

    for (const entry of parsed.profiles) {
      if (!entry || typeof entry !== 'object' || !entry.profile || !entry.secret) {
        skipped += 1;
        continue;
      }

      const secret = entry.secret as StoredProfileSecret;
      const authJson = secret.authJson;
      if (!authJson || typeof authJson !== 'object' || Array.isArray(authJson)) {
        skipped += 1;
        continue;
      }

      const authData = await loadAuthDataFromFile(await this.writeTemporaryImportFile(authJson));
      if (!authData) {
        skipped += 1;
        continue;
      }

      const duplicate = await this.findDuplicateProfile(authData);
      if (duplicate) {
        await this.replaceProfileAuth(duplicate.id, authData);
        sourceToTarget.set((entry.profile as ProfileSummary).id, duplicate.id);
        updated += 1;
      } else {
        const createdProfile = await this.createProfile((entry.profile as ProfileSummary).name, authData);
        sourceToTarget.set((entry.profile as ProfileSummary).id, createdProfile.id);
        created += 1;
      }
    }

    const importedActive = parsed.activeProfileId ? sourceToTarget.get(parsed.activeProfileId) : undefined;
    if (importedActive) {
      await this.setActiveProfileId(importedActive);
    }

    return { created, updated, skipped };
  }

  private async writeTemporaryImportFile(authJson: Record<string, unknown>): Promise<string> {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-account-switcher-import-'));
    const filePath = path.join(tempDir, 'auth.json');
    await fsp.writeFile(filePath, JSON.stringify(authJson, null, 2), 'utf8');
    return filePath;
  }

  async importLegacyAccounts(
    accounts: AccountConfig[],
    activeAccountName: string,
    resolveAccountAuthPath: (account: AccountConfig) => string
  ): Promise<void> {
    if (this.context.globalState.get<boolean>(MIGRATED_ACCOUNTS_KEY, false)) {
      return;
    }

    const existingProfiles = await this.listProfiles();
    if (existingProfiles.length > 0) {
      await this.context.globalState.update(MIGRATED_ACCOUNTS_KEY, true);
      return;
    }

    let activeProfileId: string | undefined;

    for (const account of accounts) {
      try {
        const authData = await loadAuthDataFromFile(resolveAccountAuthPath(account));
        if (!authData) {
          continue;
        }
        const profile = await this.createProfile(account.name, authData);
        if (account.name === activeAccountName) {
          activeProfileId = profile.id;
        }
      } catch {
        // Ignore invalid snapshots during one-time migration.
      }
    }

    if (activeProfileId) {
      await this.setActiveProfileId(activeProfileId);
    }

    await this.context.globalState.update(MIGRATED_ACCOUNTS_KEY, true);
  }

  async importFromCurrentAuth(name: string): Promise<ProfileSummary> {
    const authData = await loadAuthDataFromFile(getResolvedActiveAuthPath());
    if (!authData) {
      throw new Error(`Could not read auth from ${getResolvedActiveAuthPath()}.`);
    }
    authData.codexConfigText = await loadCodexConfigText();

    const duplicate = await this.findDuplicateProfile(authData);
    if (duplicate) {
      await this.replaceProfileAuth(duplicate.id, authData);
      return (await this.getProfile(duplicate.id)) ?? duplicate;
    }

    return this.createProfile(name, authData);
  }

  async importFromFile(name: string, filePath: string): Promise<ProfileSummary> {
    const authData = await loadAuthDataFromFile(filePath);
    if (!authData) {
      throw new Error('Selected file is not a valid auth.json.');
    }

    const duplicate = await this.findDuplicateProfile(authData);
    if (duplicate) {
      await this.replaceProfileAuth(duplicate.id, authData);
      return (await this.getProfile(duplicate.id)) ?? duplicate;
    }

    return this.createProfile(name, authData);
  }

  createWatchers(onChanged: () => void): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];
    const fire = (): void => {
      try {
        onChanged();
      } catch {
        // ignore watcher refresh errors
      }
    };

    const activeAuthPath = getResolvedActiveAuthPath();
    const activeAuthDir = path.dirname(activeAuthPath);
    const authWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(activeAuthDir), path.basename(activeAuthPath))
    );
    authWatcher.onDidCreate(fire);
    authWatcher.onDidChange(fire);
    authWatcher.onDidDelete(fire);
    disposables.push(authWatcher);

    if (this.isRemoteFilesMode()) {
      const storeWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(this.getStorageDir()), '*.json')
      );
      storeWatcher.onDidCreate(fire);
      storeWatcher.onDidChange(fire);
      storeWatcher.onDidDelete(fire);
      disposables.push(storeWatcher);

      const profileSecretWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(this.getRemoteSecretsDir()), '*.json')
      );
      profileSecretWatcher.onDidCreate(fire);
      profileSecretWatcher.onDidChange(fire);
      profileSecretWatcher.onDidDelete(fire);
      disposables.push(profileSecretWatcher);
    }

    return disposables;
  }
}
