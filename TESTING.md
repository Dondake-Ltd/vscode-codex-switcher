# Manual Testing Checklist

Run these checks before publishing a release.

## 1. Basic setup

- Install the extension in a clean VS Code profile.
- Confirm status bar shows `Codex: Setup` when no accounts are configured.
- Click the status bar item and confirm setup wizard options appear.

## 2. Account creation

- Run `Codex Account Switcher: Add Account`.
- Create one account by snapshotting current `auth.json`.
- Create another account by selecting an existing snapshot file.
- Confirm `codexAccountSwitcher.accounts` is updated in settings.

## 3. Switch behavior

- Set `confirmBeforeSwitch` to `true`, switch accounts, confirm warning appears.
- Verify info toast appears: `Switched Codex account to: <name>. Reloading window...`
- Confirm VS Code reloads automatically.
- After reload, confirm status bar shows `Codex: <activeAccount>`.

## 4. Missing and invalid files

- Point an account to a missing snapshot file.
- Confirm prompt offers `Create from current auth` and `Cancel`.
- Choose create path and verify snapshot is created.
- Put invalid JSON in a snapshot and switch to it.
- Confirm error appears and `Open file` opens the snapshot.

## 5. Backup behavior

- Enable `backupActiveAuth`.
- Switch accounts and verify `auth.backup.<timestamp>.json` appears in `codexHome`.

## 6. Security checks

- Confirm output channel logs operational messages only.
- Confirm no auth token content appears in UI or logs.
- Confirm snapshot/auth files are ignored in your personal workflows and not committed.

## 7. Cross-platform checks

Windows:
- Verify default `codexHome` resolves to `%USERPROFILE%\\.codex` when `CODEX_HOME` is unset.
- Verify path expansion works with `%USERPROFILE%`.

macOS/Linux:
- Verify default `codexHome` resolves to `~/.codex` when `CODEX_HOME` is unset.
- Verify `${HOME}` and `~` path expansions work.

## 8. Command palette coverage

Verify these commands are present and executable:
- `codexAccountSwitcher.switchAccount`
- `codexAccountSwitcher.addAccount`
- `codexAccountSwitcher.editAccounts`
- `codexAccountSwitcher.reloadWindow`
- `codexAccountSwitcher.exportActiveAuth`