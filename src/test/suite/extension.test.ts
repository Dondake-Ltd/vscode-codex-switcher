import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Codex Account Switcher Integration', () => {
  test('contributes required commands', async () => {
    const commands = await vscode.commands.getCommands(true);

    const expected = [
      'codexAccountSwitcher.switchAccount',
      'codexAccountSwitcher.addAccount',
      'codexAccountSwitcher.editAccounts',
      'codexAccountSwitcher.reloadWindow',
      'codexAccountSwitcher.exportActiveAuth'
    ];

    for (const command of expected) {
      assert.ok(commands.includes(command), `Missing command: ${command}`);
    }
  });
});