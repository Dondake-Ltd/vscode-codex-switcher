# Codex Account Switcher (VS Code)

Switch between named local Codex auth snapshots from the status bar and reload the current window so Codex integrations pick up the new credentials.

## What it does

- Adds a right-side status bar dropdown:
  - `Codex: <ActiveAccount>` when configured
  - `Codex: Setup` when not configured
- Lets you pick an account or actions:
  - account names
  - `Add account...`
  - `Open settings`
  - `Reload window`
- On switch:
  - validates snapshot JSON
  - optionally backs up current `auth.json`
  - replaces active `auth.json` using a temp-file swap
  - updates `activeAccount`
  - runs `Reload Window`
- Includes a setup wizard when no accounts are configured or `codexHome` is missing.

## Why reload is needed

Codex extension/CLI auth state is read by running processes. Reloading the VS Code window ensures those processes pick up the newly swapped `auth.json`.

## Configuration

Settings live under `codexAccountSwitcher.*`:

- `codexHome` (string, default `""`)
  - If empty, resolution order is:
    1. `CODEX_HOME` env var
    2. platform home default (`~/.codex` on macOS/Linux, `%USERPROFILE%\\.codex` on Windows)
- `accounts` (array)
  - each item: `{ "name": string, "authFile": string, "enabled": boolean }`
  - `authFile` supports `${codexHome}`
- `activeAccount` (string)
- `confirmBeforeSwitch` (boolean, default `false`)
- `backupActiveAuth` (boolean, default `true`)
- `ensureFileBasedCreds` (boolean, default `false`)

Example:

```json
{
  "codexAccountSwitcher.accounts": [
    {
      "name": "Personal",
      "authFile": "${codexHome}/auth.personal.json",
      "enabled": true
    },
    {
      "name": "Work",
      "authFile": "${codexHome}/auth.work.json",
      "enabled": true
    }
  ],
  "codexAccountSwitcher.activeAccount": "Personal"
}
```

## Commands

- `codexAccountSwitcher.switchAccount`
- `codexAccountSwitcher.addAccount`
- `codexAccountSwitcher.editAccounts`
- `codexAccountSwitcher.reloadWindow`
- `codexAccountSwitcher.exportActiveAuth`

## Add account wizard

`Codex Account Switcher: Add Account` asks for:

1. account name
2. creation method:
   - snapshot current `auth.json`
   - select existing snapshot file

Then it writes the account entry to settings.

## Setup wizard

When status bar shows `Codex: Setup` (or when switching fails due to missing `codexHome`), the wizard can:

1. create the `codexHome` folder
2. add an account snapshot
3. open extension settings
4. reload the window

## Security warning

`~/.codex/auth.json` and snapshot files contain sensitive access tokens.

- Treat these files like passwords.
- Never commit them to git.
- This extension never logs auth file contents.

## Notes on file-based credentials

This extension swaps files. If Codex is using OS keychain-backed credentials, file swapping may not affect active auth. Enable `ensureFileBasedCreds` to show a warning in the UI.

## Development

- `npm run compile` builds the extension
- `npm test` runs unit tests
- `npm run test:integration` runs VS Code extension-host integration tests
- `npm run test:all` runs both unit and integration tests
- `npm run package` builds a `.vsix`

Detailed manual release validation steps are in `TESTING.md`.
