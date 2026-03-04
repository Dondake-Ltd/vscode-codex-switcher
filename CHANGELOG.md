# Changelog

All notable changes to this project are documented in this file.

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
