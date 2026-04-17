# Changelog

All notable changes to this project are documented in this file.

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

