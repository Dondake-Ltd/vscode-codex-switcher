# Agents Notes

- Product scope: this extension switches local Codex profiles by swapping local Codex auth/state under the resolved `CODEX_HOME`. It does not manage OpenAI accounts directly, and work should preserve that boundary unless the user explicitly changes the product direction.
- Treat any change that activates a different profile/account as requiring the normal Codex reload/restart flow so the official Codex extension and related processes pick up the new auth/state cleanly.
- Respect environment-specific Codex path resolution. Prefer the configured `codexHome`, then `CODEX_HOME`, then the platform default; do not hardcode `~/.codex` assumptions when implementing auth, config, usage, WSL, or remote behavior.
- Preserve and document the file-based-auth assumption. If a behavior depends on Codex using OS keychain/credential-manager storage instead of files, call out the limitation explicitly rather than pretending the switch flow is reliable.
- Codex auth material is sensitive. Never log or display token contents, and treat `auth.json`, exported profile payloads, and equivalent stored secrets like passwords. Any feature touching export/import/backup flows should keep that operational-security stance intact.
- When an issue report results in a fix, credit the reporter in `CHANGELOG.md` and link the relevant GitHub issue whenever practical.
- When a version containing an issue fix is released, reply on the issue to say the fix is live, ask the reporter to test whether it resolves the problem on their side, and close the issue once that release follow-up has been made.
