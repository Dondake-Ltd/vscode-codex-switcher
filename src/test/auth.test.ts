import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { coerceExpectedFilePath, normalizeOptionalTextFileContent } from '../core';

test('coerceExpectedFilePath preserves a correct file path', () => {
  const filePath = path.join('C:\\Users\\tester\\.codex', 'auth.json');
  assert.equal(coerceExpectedFilePath(filePath, 'auth.json'), filePath);
});

test('coerceExpectedFilePath appends the expected file name when given a directory path', () => {
  const directoryPath = 'C:\\Users\\tester\\AppData\\Roaming\\Microsoft VS Code';
  assert.equal(
    coerceExpectedFilePath(directoryPath, 'auth.json'),
    path.join(directoryPath, 'auth.json')
  );
});

test('coerceExpectedFilePath trims quotes and trailing separators before appending', () => {
  const quotedDirectoryPath = '"\\\\wsl$\\Ubuntu\\home\\tester\\.codex\\"';
  assert.equal(
    coerceExpectedFilePath(quotedDirectoryPath, 'config.toml'),
    path.join('\\\\wsl$\\Ubuntu\\home\\tester\\.codex', 'config.toml')
  );
});

test('normalizeOptionalTextFileContent trims empty config state and appends a trailing newline when needed', () => {
  assert.equal(normalizeOptionalTextFileContent(undefined), undefined);
  assert.equal(normalizeOptionalTextFileContent('   '), undefined);
  assert.equal(normalizeOptionalTextFileContent('model = "gpt-5.4"'), 'model = "gpt-5.4"\n');
  assert.equal(normalizeOptionalTextFileContent('model = "gpt-5.4"\n'), 'model = "gpt-5.4"\n');
});
