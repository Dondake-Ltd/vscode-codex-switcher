import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { coerceExpectedFilePath } from '../core';

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
