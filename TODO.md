# TODO

## Epic

- Support switching Claude accounts for the VS Code Claude Code extension so this can evolve into an all-in-one account and usage switchboard across major coding-agent extensions.

## Reliability and Recovery

- Expand health checks for saved profiles so broken, stale, or mismatched auth state is easier to spot.
- Add stronger platform-specific secure-store diagnostics and remediation guidance, especially for Windows Credential Manager and Linux Secret Service failures.
- Add stronger diagnostics for active Codex home/auth/config resolution, especially in WSL and remote setups.

## Optional Exploration

- Evaluate whether a lightweight warm-up action is worth supporting for accounts whose usage state needs nudging to update.
- Consider whether any longer-lived watcher model outside the VS Code process is worth supporting later for users who want more persistent auto-switch behavior.
- Consider a standalone dashboard mode in the future if the usage/details surface outgrows the VS Code panel comfortably.
