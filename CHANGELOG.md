# Changelog

All notable changes to this project are documented in this file.

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
