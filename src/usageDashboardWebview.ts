import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

function createWebviewNonce(): string {
  return randomBytes(16).toString('base64');
}

export function buildUsageDashboardWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const nonce = createWebviewNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'usage-dashboard', 'app.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'usage-dashboard', 'app.css'));

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta
        http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};"
      />
      <link rel="stylesheet" href="${styleUri}" />
      <title>Codex Usage</title>
    </head>
    <body>
      <div id="root" class="usage-dashboard-root">
        <div class="usage-dashboard-loading">
          <div class="usage-dashboard-loading__title">Codex Usage</div>
          <div class="usage-dashboard-loading__copy">Loading saved profiles, usage windows, and history…</div>
        </div>
      </div>
      <script nonce="${nonce}" src="${scriptUri}"></script>
    </body>
  </html>`;
}
