import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { CodeEditorFile } from '@/shared/types';

const readFile = vi.fn(async () => ({ ok: true, json: async () => ({ content: '# Preview title' }) }));
const saveFile = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
const readFileBlob = vi.fn(async (_project: string, _path: string) => ({ ok: true, blob: async () => new Blob(['asset']) }));

vi.mock('@/shared/api', () => ({
  api: { readFile, saveFile, readFileBlob },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea data-testid="editor" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');
const { prepareHtmlPreview } = await import('@/modules/code-editor/utils/prepareHtmlPreview');
const file: CodeEditorFile = { name: 'readme.md', path: '/repo/readme.md', projectId: 'p1' };

test.each(['md', 'markdown', 'MD'])('a .%s file opens as a rendered preview and keeps edits across preview toggles', async (extension) => {
  const onClose = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<CodeEditor file={{ ...file, name: `readme.${extension}` }} onClose={onClose} />);
  await screen.findByRole('heading', { name: 'Preview title' });
  assert.equal(screen.queryByTestId('editor'), null);
  fireEvent.click(screen.getByRole('button', { name: 'Edit source' }));
  fireEvent.change(screen.getByTestId('editor'), { target: { value: '# Updated preview' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByRole('heading', { name: 'Updated preview' });
  assert.ok(screen.getByLabelText('Unsaved changes'));
  fireEvent.click(screen.getByTitle('actions.close'));
  assert.equal(confirm.mock.calls.length, 1);
  assert.equal(onClose.mock.calls.length, 0);
  fireEvent.click(screen.getByRole('button', { name: 'Edit source' }));
  assert.equal(screen.getByTestId<HTMLTextAreaElement>('editor').value, '# Updated preview');
});

test('switching files resets preview mode, including returning to a previously edited file', async () => {
  const { rerender } = render(<CodeEditor file={file} onClose={() => undefined} />);
  await screen.findByRole('heading', { name: 'Preview title' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit source' }));
  rerender(<CodeEditor file={{ ...file, name: 'other.md', path: '/repo/other.md' }} onClose={() => undefined} />);
  await screen.findByRole('heading', { name: 'Preview title' });
  rerender(<CodeEditor file={file} onClose={() => undefined} />);
  await screen.findByRole('heading', { name: 'Preview title' });
  assert.equal(screen.queryByTestId('editor'), null);
});

test.each(['html', 'htm', 'HTML'])('a .%s file opens inside an opaque sandbox and can still be edited', async (extension) => {
  const html = '<h1>Hello HTML</h1><script>document.body.dataset.ready="yes"</script>';
  readFile.mockResolvedValueOnce({ ok: true, json: async () => ({ content: html }) });
  const name = `index.${extension}`;
  render(<CodeEditor file={{ ...file, name, path: `/repo/${name}` }} projectPath="/repo" onClose={() => undefined} />);
  const frame = await screen.findByTitle<HTMLIFrameElement>(name);
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert.match(frame.srcdoc, /Hello HTML/);
  assert.match(frame.srcdoc, /connect-src 'none'/);
  assert.equal(screen.queryByTestId('editor'), null);
  fireEvent.click(screen.getByRole('button', { name: 'Edit source' }));
  assert.equal(screen.getByTestId<HTMLTextAreaElement>('editor').value, html);
});

test('line references and diff payloads retain source mode', async () => {
  const { rerender } = render(<CodeEditor file={{ ...file, line: 1 }} onClose={() => undefined} />);
  await screen.findByTestId('editor');
  rerender(<CodeEditor file={{ ...file, diffInfo: { old_string: '# Old', new_string: '# New' } }} onClose={() => undefined} />);
  await waitFor(() => assert.equal(screen.getByTestId<HTMLTextAreaElement>('editor').value, '# New'));
});

test('local images, scripts and nested CSS assets resolve from their owner paths without exposing authenticated URLs', async () => {
  readFileBlob.mockImplementation(async (_project, path) => ({
    ok: true,
    blob: async () => new Blob([path.endsWith('.css') ? 'body { background: url(../images/bg.png) }' : 'asset'], { type: path.endsWith('.png') ? 'image/png' : 'text/plain' }),
  }));
  const result = await prepareHtmlPreview(
    '<link rel="stylesheet" href="styles/site.css"><img src="images/bg.png"><script src="scripts/app.js"></script>',
    '/repo/index.html', 'p1', '/repo', new AbortController().signal,
  );
  const document = new DOMParser().parseFromString(result.srcDoc, 'text/html');
  assert.equal(result.missingResources, 0);
  assert.match(document.querySelector('link')!.getAttribute('href')!, /^data:text\/css;base64,/);
  const css = atob(document.querySelector('link')!.getAttribute('href')!.split(',')[1]);
  assert.match(css, /data:image\/png;base64,/);
  assert.match(document.querySelector('script')!.getAttribute('src')!, /^data:text\/javascript;base64,/);
  assert.equal(readFileBlob.mock.calls.filter(([, path]) => path === '/repo/images/bg.png').length, 1);
  assert.equal(result.srcDoc.includes('/api/'), false);
  assert.equal(result.srcDoc.includes('token='), false);
});

test('out-of-project assets and document bases are blocked without blocking the document itself', async () => {
  readFileBlob.mockClear();
  const result = await prepareHtmlPreview(
    '<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=/api/auth"><img src="../secret.txt"><h1>Readable</h1>',
    '/repo/index.html', 'p1', '/repo', new AbortController().signal,
  );
  assert.equal(readFileBlob.mock.calls.length, 0);
  assert.equal(result.missingResources, 1);
  assert.equal(result.srcDoc.includes('<base'), false);
  assert.equal(result.srcDoc.includes('refresh'), false);
  assert.match(result.srcDoc, /Readable/);
});

test('resource loading stays bounded and failures leave a readable preview', async () => {
  let active = 0;
  let maximum = 0;
  readFileBlob.mockImplementation(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return { ok: false, blob: async () => new Blob() };
  });
  readFileBlob.mockClear();
  const result = await prepareHtmlPreview(
    `<h1>Readable</h1>${Array.from({ length: 70 }, (_, index) => `<img src="${index}.png">`).join('')}`,
    '/repo/index.html', 'p1', '/repo', new AbortController().signal,
  );
  assert.ok(maximum <= 4);
  assert.equal(readFileBlob.mock.calls.length, 48);
  assert.equal(result.missingResources, 70);
  assert.match(result.srcDoc, /Readable/);
});

test('oversized resources are omitted and reported', async () => {
  readFileBlob.mockImplementation(async () => ({ ok: true, blob: async () => new Blob(['x'.repeat(4 * 1024 * 1024 + 1)]) }));
  const result = await prepareHtmlPreview('<img src="large.png"><p>Readable</p>', '/repo/index.html', 'p1', '/repo', new AbortController().signal);
  assert.equal(result.missingResources, 1);
  assert.match(result.srcDoc, /src="data:,"/);
  assert.match(result.srcDoc, /Readable/);
});

test('a stream without Content-Length is cancelled at the per-resource limit instead of buffering the whole file', async () => {
  let chunksRead = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunksRead += 1;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel,
  }, { highWaterMark: 0 });
  const blob = vi.fn(async () => new Blob());
  readFileBlob.mockImplementation(async () => ({ ok: true, headers: new Headers(), body, blob }));
  const result = await prepareHtmlPreview('<img src="huge.png"><p>Readable</p>', '/repo/index.html', 'p1', '/repo', new AbortController().signal);
  assert.equal(result.missingResources, 1);
  assert.equal(chunksRead, 5);
  assert.equal(cancel.mock.calls.length, 1);
  assert.equal(blob.mock.calls.length, 0);
  assert.equal(body.locked, false);
  assert.match(result.srcDoc, /Readable/);
});

test('concurrent streams without Content-Length share the total preview budget', async () => {
  let bytesRead = 0;
  const cancellations: string[] = [];
  const bodies: ReadableStream<Uint8Array>[] = [];
  readFileBlob.mockImplementation(async (_project, path) => {
    let chunksRead = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksRead === 3) {
          controller.close();
          return;
        }
        chunksRead += 1;
        bytesRead += 1024 * 1024;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() { cancellations.push(path); },
    }, { highWaterMark: 0 });
    bodies.push(body);
    return { ok: true, headers: new Headers(), body, blob: async () => new Blob() };
  });
  const result = await prepareHtmlPreview(
    Array.from({ length: 6 }, (_, index) => `<img src="${index}.png">`).join(''),
    '/repo/index.html', 'p1', '/repo', new AbortController().signal,
  );
  assert.ok(result.missingResources > 0);
  assert.equal(cancellations.length, result.missingResources);
  // One rejected chunk per affected stream is enough to detect the limit;
  // accepted chunks across all concurrent responses never exceed 16 MiB.
  assert.ok(bytesRead - cancellations.length * 1024 * 1024 <= 16 * 1024 * 1024);
  assert.ok(bodies.every((body) => !body.locked));
});

test('aborting a pending streamed resource cancels its reader and releases the lock', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
  readFileBlob.mockImplementation(async () => ({ ok: true, headers: new Headers(), body, blob: async () => new Blob() }));
  const controller = new AbortController();
  const pending = prepareHtmlPreview('<img src="pending.png">', '/repo/index.html', 'p1', '/repo', controller.signal);
  await waitFor(() => assert.equal(body.locked, true));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancel.mock.calls.length, 1);
  assert.equal(body.locked, false);
});

test('a late asset response cannot replace the HTML file opened afterwards', async () => {
  let release: (() => void) | undefined;
  readFileBlob.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { ok: true, blob: async () => new Blob(['old asset']) };
  });
  readFile.mockResolvedValueOnce({ ok: true, json: async () => ({ content: '<h1>First</h1><img src="slow.png">' }) });
  readFile.mockResolvedValueOnce({ ok: true, json: async () => ({ content: '<h1>Second</h1>' }) });
  const first = { ...file, name: 'first.html', path: '/repo/first.html' };
  const second = { ...file, name: 'second.html', path: '/repo/second.html' };
  const { rerender } = render(<CodeEditor file={first} projectPath="/repo" onClose={() => undefined} />);
  await waitFor(() => assert.equal(typeof release, 'function'));
  rerender(<CodeEditor file={second} projectPath="/repo" onClose={() => undefined} />);
  const frame = await screen.findByTitle<HTMLIFrameElement>('second.html');
  await act(async () => {
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(frame.srcdoc, /Second/);
  assert.equal(frame.srcdoc.includes('First'), false);
});

test.each([
  ['<script type="module" src="/src/main.ts"></script>', true],
  ['<script type="module" src="./main.js"></script>', true],
  ['<script src="./main.tsx?version=1"></script>', true],
  ['<script src="./main.jsx"></script>', true],
  ['<script src="./main.js"></script>', false],
  ['<script type="module" src="https://example.com/main.js"></script>', false],
] as const)('identifies project development entrypoints in %s', async (source, expected) => {
  readFileBlob.mockImplementation(async () => ({ ok: true, blob: async () => new Blob(['source']) }));
  const result = await prepareHtmlPreview(source, '/repo/index.html', 'p1', '/repo', new AbortController().signal);
  assert.equal(result.requiresDevelopmentServer, expected);
});

test('a Vite-style HTML shell explains why the preview may be incomplete', async () => {
  readFile.mockResolvedValueOnce({ ok: true, json: async () => ({ content: '<div id="root"></div><script type="module" src="/src/main.ts"></script>' }) });
  readFileBlob.mockImplementation(async () => ({ ok: true, blob: async () => new Blob(['source']) }));
  render(<CodeEditor file={{ ...file, name: 'index.html', path: '/repo/index.html' }} projectPath="/repo" onClose={() => undefined} />);
  await screen.findByText('This HTML needs its project development server. The built-in preview may not display it completely.');
  assert.ok(screen.getByTitle('index.html'));
  assert.ok(screen.getByRole('button', { name: 'Edit source' }));
});
