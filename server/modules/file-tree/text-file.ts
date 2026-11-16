import fs from 'node:fs/promises';

// BOMs are unambiguous; files without one retain the existing UTF-8 default.
function textEncoding(bytes: Buffer): 'utf8' | 'utf16le' | 'utf16be' {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf16be';
  return 'utf8';
}

/** Used by the File Tree filesystem adapter to read BOM-marked Unicode documents. */
export async function readWorkspaceTextFile(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  const encoding = textEncoding(bytes);
  if (encoding === 'utf16le') return bytes.subarray(2).toString('utf16le');
  if (encoding === 'utf16be') return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

/** Used by the File Tree filesystem adapter to preserve an existing file's Unicode BOM and encoding. */
export async function writeWorkspaceTextFile(filePath: string, content: string): Promise<void> {
  const prefix = Buffer.alloc(3);
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      await handle.read(prefix, 0, prefix.length, 0);
    } finally {
      await handle.close();
    }
  } catch (error) {
    // New text files use UTF-8. Other read failures must not overwrite the file.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const encoding = textEncoding(prefix);
  if (encoding !== 'utf8') {
    const payload = Buffer.from(content, 'utf16le');
    if (encoding === 'utf16be') payload.swap16();
    await fs.writeFile(filePath, Buffer.concat([prefix.subarray(0, 2), payload]));
    return;
  }
  const hasBom = prefix.equals(Buffer.from([0xef, 0xbb, 0xbf]));
  await fs.writeFile(filePath, `${hasBom ? '\uFEFF' : ''}${content}`, 'utf8');
}
