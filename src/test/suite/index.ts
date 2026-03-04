import * as path from 'path';
import Mocha from 'mocha';
import * as fs from 'fs/promises';

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true
  });

  const testsRoot = path.resolve(__dirname);

  return new Promise<void>((resolve, reject) => {
    fs.readdir(testsRoot)
      .then((files) => {
        files
          .filter((f) => f.endsWith('.test.js'))
          .forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));

        mocha.run((failures: number) => {
          if (failures > 0) {
            reject(new Error(`${failures} integration test(s) failed.`));
          } else {
            resolve();
          }
        });
      })
      .catch(reject);
  });
}
