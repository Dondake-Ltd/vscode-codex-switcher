+----------------------+
| Codex Account Switch |
+----------------------+

# Codex Account Switcher

You know the ritual:

1. "Oops, wrong account."
2. Logout.
3. Login.
4. Reload.
5. Lose your flow.
6. Mutter things unfit for documentation.

This extension exists because that loop is cursed.

Now you click one status bar item, pick your account, and keep coding like the main character.

## Demo

Observe the cursed loop being defeated:

![Codex Account Switcher demo](assets/codex-account-switcher.gif)

## The Vibe

- Before: account-switching side quest every time usage limits, context, or account boundaries get in your way.
- After: one click, one switch, one restart/reload path, back to shipping.
- This is not just a QoL tweak. This is anti-friction technology.

## What It Actually Does

- Adds a status bar switcher:
  - `$(account) <ActiveAccount>` when configured
  - `$(tools) Setup` when not configured
- Lets you:
  - switch accounts
  - add account snapshots
  - delete account entries
  - open settings fast
- On switch, it:
  - validates snapshot JSON
  - optionally backs up active `auth.json`
  - swaps snapshot -> active `auth.json`
  - updates `activeAccount`
  - restarts extension host (default) or reloads window

## Why Restart/Reload Is Needed

Because running tools cache auth state. Swapping files alone does not force live processes to re-read credentials.

Default behavior uses extension host restart (`reloadTarget = extensionHost`) because it is usually less disruptive than full window reload.

## Commands

- `codexAccountSwitcher.switchAccount`
- `codexAccountSwitcher.addAccount`
- `codexAccountSwitcher.deleteAccount`
- `codexAccountSwitcher.editAccounts`
- `codexAccountSwitcher.reloadWindow`
- `codexAccountSwitcher.exportActiveAuth`

## Settings

Everything lives under `codexAccountSwitcher.*`.

- `codexHome` (string, default `""`)
- `accounts` (array of `{ name, authFile, enabled }`)
- `activeAccount` (string)
- `confirmBeforeSwitch` (boolean, default `false`)
- `backupActiveAuth` (boolean, default `true`)
- `ensureFileBasedCreds` (boolean, default `false`)
- `reloadTarget` (`"extensionHost" | "window"`, default `"extensionHost"`)
- `statusBarSide` (`"right" | "left"`, default `"right"`)

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
  "codexAccountSwitcher.activeAccount": "Personal",
  "codexAccountSwitcher.reloadTarget": "extensionHost"
}
```

## Setup (Fast)

If status bar shows setup mode:

1. click status bar item
2. create/check `codexHome`
3. add account snapshot
4. switch like a legend

## Security (Not Optional)

`~/.codex/auth.json` and account snapshot files contain sensitive tokens.

- treat them like passwords
- do not commit them
- do not share them
- extension does not log token contents

## Power User Notes

- Yes, snapshots can carry account-specific Codex behavior/preferences.
- Yes, that means switching back can restore that account's usual "mode".
- If Codex uses OS keychain auth instead of file-based auth, file swapping may not behave as expected.

## Development

- `npm run compile`
- `npm test`
- `npm run test:integration`
- `npm run package`

Manual release checklist is in `TESTING.md`.

From "why is this still manual" to "best thing since sliced bread".
Next stop: Mars operations, probably.
