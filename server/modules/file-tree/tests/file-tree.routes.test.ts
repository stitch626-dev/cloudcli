import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import type { FileTreeServices } from '@/shared/types.js';

function createFakeServices(overrides: Partial<FileTreeServices> = {}): FileTreeServices {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree service call');
  };

  return {
    browseWorkspace: unexpectedOperation,
    createWorkspaceFolder: unexpectedOperation,
    readTextFile: unexpectedOperation,
    openFile: unexpectedOperation,
    saveTextFile: unexpectedOperation,
    listProjectFiles: unexpectedOperation,
    snapshotProjectFiles: unexpectedOperation,
    createEntry: unexpectedOperation,
    renameEntry: unexpectedOperation,
    deleteEntry: unexpectedOperation,
    storeUploadedFiles: unexpectedOperation,
    ...overrides,
  };
}

const passUploadRequest: RequestHandler = (_request, _response, next) => next();

async function withFileTreeServer(
  services: FileTreeServices,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/file-tree', createFileTreeRouter(
    services,
    passUploadRequest,
    { maximumFileSizeMegabytes: 200, maximumFileCount: 20 },
    { error: () => undefined },
  ));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('large text reads negotiate compression, preserve Unicode, and disable caching', async () => {
  const document = { content: '中文小说 📚\n'.repeat(10_000), path: '/repo/novel.txt' };
  await withFileTreeServer(createFakeServices({ readTextFile: async () => document }), async (baseUrl) => {
    const url = `${baseUrl}/api/file-tree/projects/project-1/file?filePath=novel.txt`;
    const compressed = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(compressed.headers.get('content-encoding'), 'gzip');
    assert.equal(compressed.headers.get('cache-control'), 'private, no-store');
    assert.match(compressed.headers.get('vary') || '', /Accept-Encoding/);
    assert.deepEqual(await compressed.json(), document);
    const plain = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.deepEqual(await plain.json(), document);
  });
});

test('project files route uses the File Tree API namespace and forwards the project id', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: false }]]);
});

test('project files route requests gitignore filtering when explicitly enabled', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true`,
    );

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: true }]]);
});

test('create route parses the transport payload before invoking the service', async () => {
  const inputs: Parameters<FileTreeServices['createEntry']>[0][] = [];
  const services = createFakeServices({
    createEntry: async (input) => {
      inputs.push(input);
      return {
        success: true,
        path: '/workspace/project/src/example.ts',
        name: input.name,
        type: input.type,
        message: 'File created successfully',
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/workspace/project/src',
        type: 'file',
        name: 'example.ts',
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [{
    projectId: 'project-1',
    parentPath: '/workspace/project/src',
    type: 'file',
    name: 'example.ts',
  }]);
});

test('create route rejects invalid entry types without calling the service', async () => {
  let createCalled = false;
  const services = createFakeServices({
    createEntry: async () => {
      createCalled = true;
      throw new Error('createEntry should not run for invalid input');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'link', name: 'example' }),
    });
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'Type must be "file" or "directory"');
  });

  assert.equal(createCalled, false);
});

test('project files route forwards lazy directory requests without changing recursive callers', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  await withFileTreeServer(createFakeServices({ listProjectFiles: async (...args) => { inputs.push(args); return []; } }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/p1/files?respectGitignore=true&shallow=true&directory=src`);
    assert.equal(response.status, 200);
  });
  assert.deepEqual(inputs, [['p1', { respectGitignore: true, shallow: true, directory: 'src' }]]);
});

test('snapshot route parses directory, refresh and filtering and disables shared HTTP caching', async () => {
  const inputs: Parameters<FileTreeServices['snapshotProjectFiles']>[] = [];
  await withFileTreeServer(createFakeServices({ snapshotProjectFiles: async (...args) => {
    inputs.push(args);
    return { rootPath: '/project/docs', directories: [{ path: '/project/docs', children: [] }], truncated: false };
  } }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/p1/files/snapshot?respectGitignore=true&directory=docs&refresh=true`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), { rootPath: '/project/docs', directories: [{ path: '/project/docs', children: [] }], truncated: false });
  });
  assert.deepEqual(inputs, [['p1', { respectGitignore: true, directory: 'docs', refresh: true }]]);
});

test('shallow listing route forwards an explicit refresh', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  await withFileTreeServer(createFakeServices({ listProjectFiles: async (...args) => { inputs.push(args); return []; } }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/p1/files?shallow=true&refresh=true`);
    assert.equal(response.status, 200);
  });
  assert.deepEqual(inputs, [['p1', { respectGitignore: false, shallow: true, directory: '', refresh: true }]]);
});

test('recursive listings and bounded snapshots compress before entering the tunnel', async () => {
  const children = Array.from({ length: 500 }, (_, index) => ({
    type: 'file' as const, name: `中文-${index}.txt`, path: `/repo/中文-${index}.txt`,
    size: 20, modified: null, permissions: '644', permissionsRwx: 'rw-r--r--',
  }));
  const snapshot = { rootPath: '/repo', directories: [{ path: '/repo', children }], truncated: true };
  await withFileTreeServer(createFakeServices({
    listProjectFiles: async () => children,
    snapshotProjectFiles: async () => snapshot,
  }), async (baseUrl) => {
    for (const [suffix, expected] of [['files', children], ['files/snapshot', snapshot]] as const) {
      const url = `${baseUrl}/api/file-tree/projects/p1/${suffix}`;
      for (const encoding of ['gzip', 'identity']) {
        const response = await fetch(url, { headers: { 'Accept-Encoding': encoding } });
        assert.equal(response.headers.get('content-encoding'), encoding === 'gzip' ? 'gzip' : null);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        assert.deepEqual(await response.json(), expected);
      }
    }
  });
});
