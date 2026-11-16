import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readWorkspaceTextFile, writeWorkspaceTextFile } from '@/modules/file-tree/text-file.js';

const text = '高武校花软呆萌，撩人处处于无形\r\n作者：太古一剑 📚\n';
const encodings = [
  { name: 'UTF-8', encode: (value: string) => Buffer.from(value, 'utf8') },
  { name: 'UTF-8 BOM', encode: (value: string) => Buffer.from(`\uFEFF${value}`, 'utf8') },
  { name: 'UTF-16 LE BOM', encode: (value: string) => Buffer.from(`\uFEFF${value}`, 'utf16le') },
  { name: 'UTF-16 BE BOM', encode: (value: string) => Buffer.from(`\uFEFF${value}`, 'utf16le').swap16() },
];

for (const { name, encode } of encodings) {
  test(`${name} reads Chinese and emoji without a visible BOM and preserves bytes on save`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-text-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, '小说.txt');
    await fs.writeFile(filePath, encode(text));
    assert.equal(await readWorkspaceTextFile(filePath), text);
    await writeWorkspaceTextFile(filePath, text);
    assert.deepEqual(await fs.readFile(filePath), encode(text));
    const updated = `${text}新章节\n`;
    await writeWorkspaceTextFile(filePath, updated);
    assert.deepEqual(await fs.readFile(filePath), encode(updated));
    assert.equal(await readWorkspaceTextFile(filePath), updated);
  });
}

test('new files use UTF-8 and empty files can be saved', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-text-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'new.txt');
  await writeWorkspaceTextFile(filePath, '');
  assert.equal(await readWorkspaceTextFile(filePath), '');
  await writeWorkspaceTextFile(filePath, text);
  assert.deepEqual(await fs.readFile(filePath), Buffer.from(text));
});
