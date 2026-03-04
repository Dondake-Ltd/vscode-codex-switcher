import * as path from 'path';
import { fileURLToPath } from 'url';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const extensionDevelopmentPath = path.resolve(dirname, '.');
    const extensionTestsPath = path.resolve(dirname, './out/test/suite/index');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath
    });
  } catch (error) {
    console.error('Failed to run integration tests');
    if (error instanceof Error) {
      console.error(error.message);
    }
    process.exit(1);
  }
}

void main();
