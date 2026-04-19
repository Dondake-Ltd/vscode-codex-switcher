# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [0.3.4] - 2026-04-19

### Fixed
- Rebuilt the Codex Usage Details panel so it now renders the full dashboard server-side instead of depending on a large client-side bootstrap script. This fixes the page getting stuck on `Loading usage details…` / `Loading comparison view…` while preserving the richer history dashboard requested by [@tsenturion](https://github.com/tsenturion) in [#12](https://github.com/Dondake-Ltd/vscode-codex-switcher/issues/12).
- The usage details `History`, `Compare`, and `Refresh Now` controls now round-trip through the extension host and re-render the page with current data instead of trying to rebuild the whole dashboard inside the webview runtime.

### Changed
- Refined the rebuilt Codex Usage Details dashboard so the Usage History view better preserves the intent of [#12](https://github.com/Dondake-Ltd/vscode-codex-switcher/issues/12): chart points now align to real sample timing, the latest sample gets a richer context summary, and recent sample rows expose the same hover detail as the chart points without relying on heavier client-side rendering.

## [0.3.3] - 2026-04-19

### Fixed
- Hardened the Codex Usage Details webview so malformed cached usage/history data no longer blanks the whole page. The panel now sanitizes invalid payload values before rendering and falls back to inline error/empty states instead of silently rendering only the header controls.
- Replaced the usage-details webview script nonce with a proper random CSP nonce so the panel script can execute reliably instead of rendering only the static header shell.
- Stopped inlining raw usage-panel JSON directly into the webview script, so profile/history data can no longer break script parsing and leave the page body blank. The details panel now ships a safe encoded payload plus visible loading/failure placeholders.
- The experimental web usage prompt is now a one-time non-modal notification instead of a modal dialog, and the response is remembered across future activations and version updates.

## [0.3.0] - 2026-04-17

### Changed
- Added optional UI masking for saved profile names and email addresses so status bar text, pickers, tooltips, dialogs, the usage details panel, and diagnostics can hide account identity without changing stored profile data.
- Added clearer post-switch verification signals so the status bar and tooltip show when a profile switch is still pending reload, and the extension confirms once that switch has been applied after reload.
- Added optional process-safety checks that warn before switching while Codex appears active and suppress low-usage auto-switches until Codex no longer looks busy. A new setting allows disabling those checks when needed.
- Added an opt-in experimental web usage probe with one-time startup consent. It uses undocumented ChatGPT web endpoints, clearly labels that source in the UI, and falls back to the supported app-server and local session usage paths when the web probe fails.
- Surfaced usage provenance more consistently across the UI so the switcher and usage details panel now show source labels plus refresh outcomes such as no newer data, no usage returned, or pre-switch cached snapshots.
- Expanded the Usage History panel with clearer axis labeling, background severity bands, richer hover detail, sample counts, latest-source stats, and a recent-samples table so historical usage snapshots are easier to inspect directly.
- Profile export/import now supports passphrase-encrypted transfer files with `Encrypted (Recommended)` and `Plain JSON` export modes, while still accepting older plain JSON exports for backward compatibility.
- Added workspace-aware preferred-profile prompts that can remember a repo/workspace's usual profile, suggest switching when the current active profile does not match, and can be disabled globally with a new setting.
- Importing or linking a profile now defaults to asking whether you want to switch to it, with a new setting to choose `ask`, `always`, or `never`. Thanks [@Encryption-c08](https://github.com/Encryption-c08) for requesting this in [#11](https://github.com/Dondake-Ltd/vscode-codex-switcher/issues/11).
- Added low-usage profile switch assistance with `off` / `ask` / `auto` modes, using only recent cached usage data from other profiles before suggesting or countdown-switching away from a nearly exhausted active profile. Thanks [@Encryption-c08](https://github.com/Encryption-c08) for requesting this in [#10](https://github.com/Dondake-Ltd/vscode-codex-switcher/issues/10).
- Expanded the Usage History chart with visible percentage axes and hoverable data points that show recorded time plus token usage context where available. Thanks [@tsenturion](https://github.com/tsenturion) for requesting this in [#12](https://github.com/Dondake-Ltd/vscode-codex-switcher/issues/12).

## [0.2.16] - 2026-04-17

### Fixed
- Switching profiles now clears stale `config.toml` when the target profile has no saved Codex config snapshot, and older active profiles can hydrate missing config from the current environment on upgrade instead of inheriting the previous profile's config.

### Changed
- Added a `usageSourceMode` setting so usage refresh can be forced to `auto`, `appServerOnly`, or `localOnly` instead of always following the built-in source order.
- Improved usage refresh diagnostics in the tooltips so they now report whether the last refresh fetched newer data, found no newer data, or returned no usage data, along with the active source mode.
- Added more manual refresh entry points for the active profile, including the switcher/manage flows and a `Refresh Now` button in the usage details panel.
- Added `Repair saved profiles` to rebuild the valid profile list from stored profile secrets and repair broken active/last-profile references when metadata drifts out of sync.
- Added `Open diagnostics` to show resolved Codex paths, storage mode, usage source mode, watcher state, CLI resolution, and the last refresh result in one panel.
- Expanded diagnostics with derived health warnings and suggested remediation steps for common path, storage-mode, WSL, watcher, and usage-source problems.
- Added regression coverage for import switch policy decisions and low-usage candidate selection logic.

## [0.2.15] - 2026-04-17

### Fixed
- Saved profiles now capture and restore Codex `cap_sid` session state alongside `auth.json`, preventing account switches from leaving stale challenge/session state behind.
- Switching to a profile that does not yet have a saved `cap_sid` now clears any previously active `cap_sid` file instead of reusing mismatched session state.
- Existing active profiles can now hydrate their saved `cap_sid` from the current environment on upgrade, reducing the odds of the official Codex extension getting stuck in an endless auth spinner after switching.

## [0.2.14] - 2026-04-16

### Fixed
- Opening the account/profile picker no longer blocks on a full usage refresh, so the list appears immediately and refreshes in place instead of stalling for several seconds. Thanks [@tsenturion](https://github.com/tsenturion) for reporting this in [#8](https://github.com/Dondake-Ltd/vscode-codex-switcher/issues/8).
- Replaced the misleading non-clickable “Click to switch” text in the active-profile tooltip with a real `Switch Profiles` command link and clearer wording. Thanks [@tsenturion](https://github.com/tsenturion) for flagging this in [#9](https://github.com/Dondake-Ltd/vscode-codex-switcher/issues/9).

## [0.2.13] - 2026-04-14

### Fixed
- Darkened the warning and critical usage colors so status bar usage indicators remain readable on light themes. Thanks [@tsenturion](https://github.com/tsenturion) for flagging this in [#7](https://github.com/Dondake-Ltd/vscode-codex-switcher/issues/7).
- Fixed free-plan usage rendering so weekly-only Codex limits no longer appear as fake 5-hour + weekly windows. Thanks [@tsenturion](https://github.com/tsenturion) for reporting this in [#5](https://github.com/Dondake-Ltd/vscode-codex-switcher/issues/5).
- Replaced optimistic `~100%` fallback usage guesses with explicit `Unknown` states when no live Codex rate-limit data is available, so exhausted profiles are no longer overstated. Thanks [@tsenturion](https://github.com/tsenturion) for reporting this in [#6](https://github.com/Dondake-Ltd/vscode-codex-switcher/issues/6).
- Importing current auth or auth files no longer silently overwrites a matching saved profile; duplicate imports now require explicit confirmation. Thanks [@mxyue](https://github.com/mxyue) for reporting this in [#4](https://github.com/Dondake-Ltd/vscode-codex-switcher/issues/4).
- Creating or importing a profile that becomes active now follows the normal reload path, so Codex does not stay on the previously active profile after `Import now` or other import flows.

### Improved
- Usage refresh now probes `codex app-server` for live `account/rateLimits/read` data before falling back to local session files, improving the odds of showing fresher Codex limits sooner.
- Session fallback now prioritizes recent files, reuses the latest known session file, and tails appended JSONL content before falling back to broader scans.
- Usage tooltips now show which data source is active (`app-server` or session file) to make troubleshooting freshness and correctness easier.

## [0.2.12] - 2026-04-06

### Fixed
- Fixed a Windows + WSL auth path resolution bug that could treat the Codex home directory as the active auth file path, causing `EPERM` failures during auth import and account switching backups. Thanks [@Exxenoz](https://github.com/Exxenoz) for the clear report in [#3](https://github.com/Dondake-Ltd/vscode-codex-switcher/issues/3).
- Added regression coverage for expected auth/config file path coercion so directory-style path results no longer slip through unnoticed.

## [0.2.11] - 2026-04-03

### Changed
- Tightened same-login profile matching again so contexts in the same organization no longer merge when `accountId` or known `planType` differs. Thanks again [@wswaq](https://github.com/wswaq) for the follow-up on [#2](https://github.com/Dondake-Ltd/vscode-codex-switcher/issues/2).

## [0.2.10] - 2026-04-03

### Changed
- Login via Codex CLI now prefers the OpenAI VS Code extension's bundled or configured Codex CLI instead of assuming a global PATH install.
- Refined the active-profile and usage hover tooltips with denser identity summaries and direct OpenAI usage/profile-management links.
- Bumped the packaged build so the latest same-login multi-context profile handling can be tested locally.

## [0.2.9] - 2026-04-03

### Changed
- Added richer hover tooltips for the active profile and usage status bar items, including email, plan type, and organization details when available.
- Improved the usage hover so account identity and subscription context are visible without opening the picker.
- Profiles now distinguish between different effective subscription/workspace contexts on the same login, so personal and Team-style Codex contexts can live as separate saved profiles instead of collapsing into one. Thanks [@wswaq](https://github.com/wswaq) for raising this in [#2](https://github.com/Dondake-Ltd/vscode-codex-switcher/issues/2).

## [0.2.8] - 2026-04-02

### Changed
- Refined the Marketplace README copy with a small follow-up wording pass.

## [0.2.7] - 2026-04-02

### Changed
- Humanized the README so it speaks to users like actual humans instead of a haunted appliance manual. Fie ye bots.
- Reframed the Marketplace documentation around the feature set, the demo, and why the extension is fun to use.

## [0.2.6] - 2026-04-02

### Changed
- Removed the broken/cluttered icon from the Codex Usage details panel header so the title-only header stays clean.
- Bumped the packaged build so the updated local install is picked up cleanly.

## [0.2.5] - 2026-04-02

### Changed
- Missing usage data now defaults to a likely-unused estimate instead of a dead-end "no data yet" message.
- Status bar, picker, tooltip, and usage details panel now consistently show inferred `~100%` remaining (or `~0%` used) until Codex emits fresh rate-limit data for that profile.

## [0.2.4] - 2026-04-02

### Changed
- Moved the compare profile selector into the right-hand usage details card, next to a `Switch Now` action, and removed the extra static header copy.
- Right-aligned the history range selector in the details panel header.
- Profiles now capture and restore Codex `config.toml` so model and reasoning settings persist with each saved profile when switching.
- Bumped the packaged build so the new local install is picked up cleanly.

## [0.2.3] - 2026-04-02

### Changed
- Added profile recovery flows: reauthenticate an existing profile via `codex login`, or refresh a saved profile from the current `auth.json` without deleting and recreating it.
- Added per-profile usage history sampling plus daily/weekly/monthly/yearly charts in the usage details panel, including side-by-side comparison against another saved profile.
- Bumped the packaged build so the new local install is picked up cleanly.

## [0.2.2] - 2026-04-02

### Changed
- Bumped the packaged build after the usage monitor UI refresh so the new local install is picked up cleanly.
- Usage percentages now default to remaining allowance to match Codex, with a setting to switch displays back to used percentage.

## [0.2.1] - 2026-04-02

### Changed
- Split the status bar into separate switcher and usage items so usage is easier to scan.
- Reworked the usage item to use the competitor-style short text, threshold colors, rich markdown tooltip, and dedicated details panel.
- Moved reset timestamps out of the status bar text and into the usage tooltip/details view.
- Standardized switch picker usage details with compact bars and clearer separation from identity info.

## [0.2.0] - 2026-04-02

### Added
- Added live 5h/week usage display and reset times for the active account/profile in the status bar and switch picker. Thanks [@compacson](https://github.com/compacson) for the feature request in [#1](https://github.com/Dondake-Ltd/vscode-codex-switcher/issues/1).
- Parsed last-known Codex 5h and weekly rate-limit data from local session files.
- Added per-profile usage cache with inline usage and reset times in the switch picker.
- Added unit tests for session usage parsing.
- Added a separate switcher usage visibility setting.
- Added profile import/export, rename, and Codex CLI login onboarding commands.
- Added storage modes: `secretStorage`, `remoteFiles`, and `auto`.
- Added WSL-aware auth path resolution for Windows setups using Codex in WSL.

### Changed
- Refactored the extension from legacy named account snapshots to a profile store that preserves the full auth payload.
- Status bar now separates switching and usage into distinct items, with compact visual usage bars and reset times moved into the usage tooltip.
- Status-bar click now refreshes usage immediately before opening the switch picker.
- Added best-effort live watcher support for Codex session file changes, with timed polling as fallback.
- Added settings for showing usage in the status bar, showing usage in the switcher, and tuning usage refresh cadence.
- Added automatic one-time migration from legacy snapshot accounts into the new profile store.

## [0.1.6] - 2026-03-04

### Added
- Added animated demo (`assets/codex-account-switcher.gif`) to README for Marketplace preview.

### Changed
- Rewrote README with a friendlier, more playful tone and clearer onboarding flow.
- Updated top banner styling in README.

## [0.1.5] - 2026-03-04

### Changed
- Removed manual `promptBeforeReload` setting.
- Reload warning is now shown only when dirty editors are present.
- Improved reload trigger behavior to reduce noisy cancellation notifications.

## [0.1.4] - 2026-03-04

### Added
- Reload strategy setting: `reloadTarget` (`extensionHost` or `window`).

### Changed
- Restored mandatory restart/reload flow after switching accounts.
- Default switch behavior now prefers restarting extension host instead of full window reload.

## [0.1.3] - 2026-03-04

### Added
- Codicon-based status bar and picker action labels for clearer UX.

## [0.1.2] - 2026-03-04

### Added
- Account deletion support (`codexAccountSwitcher.deleteAccount`).
- Separator between account list and actions in switch picker.

### Changed
- Removed `Reload window` action from the status picker menu.

## [0.1.1] - 2026-03-04

### Fixed
- Corrected Marketplace publisher release path and republished.

## [0.1.0] - 2026-03-04

### Added
- Initial public release.
- Status bar account switcher.
- Add/edit/export commands.
- Auth snapshot swap + backup behavior.
- Setup wizard flow.
- README, packaging, and test scaffolding.

