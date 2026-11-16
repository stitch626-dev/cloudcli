import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeFileSystem,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeStats,
} from '@/shared/types.js';
import { AppError, resolveReadOnlyRootPath, validateWorkspacePath } from '@/shared/utils.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function createDirectoryEntry(name: string, directory: boolean): FileTreeDirectoryEntry {
  return {
    name,
    isDirectory: () => directory,
  };
}

/**
 * Adapts a path-keyed listing to the streaming directory contract so tests keep
 * describing directories as plain arrays.
 */
function createDirectoryReader(
  listDirectory: (directoryPath: string) => FileTreeDirectoryEntry[],
): FileTreeFileSystem['openDirectory'] {
  return async function* openDirectory(directoryPath) {
    yield* listDirectory(directoryPath);
  };
}

function createStats(directory: boolean, mode: number): FileTreeStats {
  return {
    size: directory ? 0 : 24,
    mtime: new Date('2026-01-02T03:04:05.000Z'),
    mode,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  };
}

function createFakeFileSystem(
  overrides: Partial<FileTreeFileSystem> = {},
): FileTreeFileSystem {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree filesystem operation');
  };

  return {
    access: unexpectedOperation,
    stat: unexpectedOperation,
    lstat: unexpectedOperation,
    openDirectory: () => ({
      [Symbol.asyncIterator]: () => ({ next: unexpectedOperation }),
    }),
    realpath: unexpectedOperation,
    readTextFile: unexpectedOperation,
    writeTextFile: unexpectedOperation,
    makeDirectory: unexpectedOperation,
    rename: unexpectedOperation,
    removeDirectory: unexpectedOperation,
    unlink: unexpectedOperation,
    copyFile: unexpectedOperation,
    createReadStream: () => Readable.from([]),
    ...overrides,
  };
}

function createDependencies(
  fileSystem: FileTreeFileSystem,
  projectRoot: string,
): FileTreeServiceDependencies {
  return {
    fileSystem,
    projects: {
      getProjectPathById: async () => projectRoot,
    },
    workspace: {
      rootPath: projectRoot,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
      resolveReadOnlyRootPath: async () => null,
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
    now: () => Date.now(),
  };
}

test('browseWorkspace lists only immediate directories without reading child metadata', async () => {
  const root = path.resolve('folder-browser-root');
  const opened: string[] = [];
  let metadataReads = 0;
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    stat: async () => createStats(true, 0o755),
    realpath: async (candidate) => candidate,
    lstat: async () => {
      metadataReads += 1;
      throw new Error('Protected child metadata must never be accessed');
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      opened.push(directoryPath);
      assert.equal(directoryPath, root, 'Do not descend into protected or large children');
      return [
        createDirectoryEntry('Library', true),
        createDirectoryEntry('Projects', true),
        createDirectoryEntry('.cache', true),
        createDirectoryEntry('dist', true),
        createDirectoryEntry('node_modules', true),
        createDirectoryEntry('.git', true),
        createDirectoryEntry('README.md', false),
      ];
    }),
  });
  const service = createFileTreeService(createDependencies(fileSystem, root));

  const result = await service.browseWorkspace('~');

  assert.equal(result.path, root);
  assert.deepEqual(opened, [root]);
  assert.equal(metadataReads, 0);
  assert.equal(result.suggestions[0]?.name, 'Projects');
  assert.deepEqual(result.suggestions.map((entry) => entry.name).sort(), ['.cache', 'Library', 'Projects', 'dist']);
  assert.ok(result.suggestions.every((entry) => entry.path === path.join(root, entry.name)));
});

test('browseWorkspace uses the configured starting folder without changing explicit home or project paths', async () => {
  const root = path.resolve('folder-browser-root');
  const validated: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    stat: async () => createStats(true, 0o755),
    realpath: async (candidate) => candidate,
    openDirectory: createDirectoryReader(() => []),
  });
  const dependencies = createDependencies(fileSystem, root);
  dependencies.workspace.defaultBrowsePath = '~/Desktop/code/doit';
  dependencies.workspace.validatePath = async (candidate) => {
    validated.push(candidate);
    return { valid: true, resolvedPath: candidate };
  };
  const service = createFileTreeService(dependencies);

  assert.equal((await service.browseWorkspace(null)).path, path.join(root, 'Desktop/code/doit'));
  assert.equal((await service.browseWorkspace('~')).path, root);
  assert.equal((await service.browseWorkspace('~/Projects')).path, path.join(root, 'Projects'));
  assert.deepEqual(validated, [path.join(root, 'Desktop/code/doit'), root, path.join(root, 'Projects')]);
});

test('browseWorkspace validates the configured start before any filesystem reads', async () => {
  const root = path.resolve('folder-browser-root');
  const dependencies = createDependencies(createFakeFileSystem(), root);
  dependencies.workspace.defaultBrowsePath = '/outside-workspace';
  dependencies.workspace.validatePath = async () => ({ valid: false, error: 'Outside workspace' });

  await assert.rejects(
    createFileTreeService(dependencies).browseWorkspace(null),
    (error: unknown) => (error as AppError).code === 'INVALID_WORKSPACE_PATH',
  );
});

test('browseWorkspace reports an unreadable directory instead of presenting it as empty', async () => {
  const root = path.resolve('folder-browser-root');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    stat: async () => createStats(true, 0o755),
    openDirectory: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => { throw Object.assign(new Error('Permission denied'), { code: 'EPERM' }); },
      }),
    }),
  });
  await assert.rejects(
    createFileTreeService(createDependencies(fileSystem, root)).browseWorkspace('~'),
    (error: unknown) => (error as AppError).code === 'DIRECTORY_NOT_ACCESSIBLE',
  );
});

test('listProjectFiles applies gitignore alongside hard directory exclusions', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const gitDirectory = path.join(projectRoot, '.git');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return '*.log';
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.git', true),
          createDirectoryEntry('node_modules', true),
          createDirectoryEntry('README.md', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [createDirectoryEntry('build', true)];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('foo.md', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [createDirectoryEntry('index.ts', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === documentationDirectory
        || candidatePath === buildDocumentationDirectory
        || candidatePath === sourceDirectory
        || candidatePath === gitDirectory
        || candidatePath === nodeModulesDirectory,
      0o754,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'src', 'README.md']);
  const documentationEntry = tree[0];
  assert.deepEqual(documentationEntry?.children?.map((entry) => entry.name), ['build']);
  assert.deepEqual(documentationEntry?.children?.[0]?.children?.map((entry) => entry.name), ['foo.md']);
  const sourceEntry = tree[1];
  assert.ok(sourceEntry);
  assert.equal(sourceEntry.type, 'directory');
  assert.equal(sourceEntry.permissions, '754');
  assert.equal(sourceEntry.permissionsRwx, 'rwxr-xr--');
  assert.deepEqual(sourceEntry.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(gitDirectory), false);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
});

test('listProjectFiles excludes gitignored entries only when requested', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const cacheDirectory = path.join(projectRoot, 'cache');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return ['*.log', '!keep.log', 'cache/', 'src/generated.ts'].join('\n');
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.gitignore', false),
          createDirectoryEntry('cache', true),
          createDirectoryEntry('ignored.log', false),
          createDirectoryEntry('keep.log', false),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === cacheDirectory) {
        return [createDirectoryEntry('cached.txt', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [
          createDirectoryEntry('generated.ts', false),
          createDirectoryEntry('index.ts', false),
        ];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === cacheDirectory || candidatePath === sourceDirectory,
      0o644,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['src', '.gitignore', 'keep.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(cacheDirectory), false);
});

test('listProjectFiles falls back to conventional directory names when no gitignore exists', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('debug.log', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('node_modules', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [
          createDirectoryEntry('build', true),
          createDirectoryEntry('guide.md', false),
        ];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('generated.md', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(candidatePath === documentationDirectory, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'debug.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['guide.md']);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
  assert.equal(readDirectories.includes(buildDocumentationDirectory), false);
});

test('listProjectFiles rejects a tree that exceeds the server entry limit', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => directoryPath === projectRoot
      ? Array.from({ length: 10_001 }, (_, index) => createDirectoryEntry(`file-${index}.txt`, false))
      : []),
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('listProjectFiles abandons a directory stream as soon as the entry limit is passed', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let streamedEntries = 0;
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    // Endless on purpose: the walk has to stop consuming the stream itself
    // instead of waiting for the directory listing to be materialized.
    openDirectory: async function* (directoryPath) {
      if (directoryPath !== projectRoot) {
        return;
      }
      for (let index = 0; ; index += 1) {
        streamedEntries += 1;
        yield createDirectoryEntry(`file-${index}.txt`, false);
      }
    },
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
  // The budget plus the single entry that proves it was exceeded.
  assert.equal(streamedEntries, 10_001);
});

test('listProjectFiles shares the entry limit across nested directories', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const firstDirectory = path.join(projectRoot, 'first');
  const secondDirectory = path.join(projectRoot, 'second');
  const directoryPaths = new Set([firstDirectory, secondDirectory]);
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => {
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('first', true),
          createDirectoryEntry('second', true),
        ];
      }
      if (directoryPaths.has(directoryPath)) {
        return Array.from(
          { length: 5_000 },
          (_, index) => createDirectoryEntry(`${path.basename(directoryPath)}-${index}.txt`, false),
        );
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(directoryPaths.has(candidatePath), 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('readTextFile rejects traversal before invoking the filesystem adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const readPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    readTextFile: async (filePath) => {
      readPaths.push(filePath);
      return 'should not be read';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', '../secret.txt'),
    (error: unknown) => error instanceof AppError
      && error.code === 'PATH_OUTSIDE_PROJECT'
      && error.statusCode === 403,
  );
  assert.deepEqual(readPaths, []);
});

test('readTextFile reports a directory as a client error, not a 500', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    readTextFile: async () => {
      const error = new Error('EISDIR: illegal operation on a directory, read');
      (error as NodeJS.ErrnoException).code = 'EISDIR';
      throw error;
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', 'decisions'),
    (error: unknown) => error instanceof AppError
      && error.code === 'EISDIR'
      && error.statusCode === 400
      && error.message === 'Path is a directory, not a file',
  );
});

test('createEntry performs filesystem mutation only through the injected adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const targetPath = path.join(projectRoot, 'notes.txt');
  const writtenFiles: Array<{ filePath: string; content: string }> = [];
  const fileSystem = createFakeFileSystem({
    access: async (candidatePath) => {
      if (candidatePath === targetPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    writeTextFile: async (filePath, content) => {
      writtenFiles.push({ filePath, content });
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const result = await service.createEntry({
    projectId: 'project-1',
    parentPath: projectRoot,
    type: 'file',
    name: 'notes.txt',
  });

  assert.equal(result.path, targetPath);
  assert.deepEqual(writtenFiles, [{ filePath: targetPath, content: '' }]);
});

/**
 * Builds the service against the real filesystem and the real workspace policy,
 * which is the only way to exercise the read-only roots: the whole guarantee
 * rests on `realpath` resolving symlinks before the comparison.
 */
function createRealFileSystemService(projectRoot: string, workspaceRoot = projectRoot): FileTreeServices {
  return createFileTreeService({
    fileSystem: {
      access: (candidatePath) => fsPromises.access(candidatePath),
      stat: (candidatePath) => fsPromises.stat(candidatePath),
      lstat: (candidatePath) => fsPromises.lstat(candidatePath),
      openDirectory: async function* (directoryPath) {
        yield* await fsPromises.opendir(directoryPath);
      },
      realpath: (candidatePath) => fsPromises.realpath(candidatePath),
      readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
      writeTextFile: (filePath, content) => fsPromises.writeFile(filePath, content, 'utf8'),
      async makeDirectory(directoryPath, recursive) {
        await fsPromises.mkdir(directoryPath, { recursive });
      },
      rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
      async removeDirectory(directoryPath) {
        await fsPromises.rm(directoryPath, { recursive: true, force: true });
      },
      unlink: (filePath) => fsPromises.unlink(filePath),
      copyFile: (source, destination) => fsPromises.copyFile(source, destination),
      createReadStream: (filePath) => createReadStream(filePath),
    },
    projects: { getProjectPathById: async () => projectRoot },
    workspace: {
      rootPath: workspaceRoot,
      validatePath: (candidatePath) => validateWorkspacePath(candidatePath),
      resolveReadOnlyRootPath: (candidatePath) => resolveReadOnlyRootPath(candidatePath),
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
    now: () => Date.now(),
  });
}

test('the temp directory can be browsed and read, but never written to', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));

  try {
    // The shape a task notification quotes: an agent's output file written to
    // the system temp directory, outside every project.
    await fsPromises.mkdir(path.join(temporaryDirectory, 'tasks'));
    const outputPath = path.join(temporaryDirectory, 'tasks', 'agent.output');
    await fsPromises.writeFile(outputPath, 'what the agent found', 'utf8');

    const service = createRealFileSystemService(projectRoot);

    const browsed = await service.browseWorkspace(temporaryDirectory);
    assert.deepEqual(browsed.suggestions.map((entry) => entry.name), ['tasks']);

    const opened = await service.readTextFile('project-1', outputPath);
    assert.equal(opened.content, 'what the agent found');

    const streamed = await service.openFile('project-1', outputPath);
    streamed.stream.destroy();

    // Read-only means read-only: nothing may be created or changed there.
    await assert.rejects(
      service.saveTextFile('project-1', outputPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.createWorkspaceFolder(path.join(temporaryDirectory, 'new-folder')),
      (error: unknown) => (error as AppError).code === 'INVALID_WORKSPACE_PATH',
    );
    await assert.rejects(
      service.createEntry({
        projectId: 'project-1',
        parentPath: path.join(temporaryDirectory, 'tasks'),
        type: 'file',
        name: 'planted.txt',
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.renameEntry({ projectId: 'project-1', oldPath: outputPath, newName: 'renamed.output' }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    const uploadedTemporaryPath = path.join(projectRoot, 'upload.tmp');
    await fsPromises.writeFile(uploadedTemporaryPath, 'upload', 'utf8');
    await assert.rejects(
      service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath: path.join(temporaryDirectory, 'tasks'),
        relativePaths: [],
        requestedFileCount: 1,
        files: [{ originalName: 'upload.txt', temporaryPath: uploadedTemporaryPath, size: 6, mimeType: 'text/plain' }],
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: outputPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.deepEqual(await fsPromises.readdir(path.join(temporaryDirectory, 'tasks')), ['agent.output']);
    assert.equal(await fsPromises.readFile(outputPath, 'utf8'), 'what the agent found');
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

test('reading through a symlink out of the temp directory is still refused', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));
  // The link target has to sit under no read-only root. Beside this file is
  // deterministic; a directory under `$HOME` lands under `/tmp` whenever a
  // test run isolates its home there, and the Claude projects directory is a
  // read-only root too.
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    assert.equal(await resolveReadOnlyRootPath(outsideDirectory), null);
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(temporaryDirectory, 'escape'));

    const service = createRealFileSystemService(projectRoot);
    await assert.rejects(
      service.readTextFile('project-1', path.join(temporaryDirectory, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test('a file in another folder of the workspace can be read, but never written to', async () => {
  // Both sit beside this file, outside every read-only root, for the reason
  // given in the symlink test above.
  const workspaceRoot = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-workspace-'));
  const projectRoot = path.join(workspaceRoot, 'project');
  const siblingDirectory = path.join(workspaceRoot, '.runs', 'run-1');
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    await fsPromises.mkdir(projectRoot);
    await fsPromises.mkdir(siblingDirectory, { recursive: true });
    const reportPath = path.join(siblingDirectory, 'report.md');
    await fsPromises.writeFile(reportPath, 'what the run found', 'utf8');
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(workspaceRoot, 'escape'));

    const service = createRealFileSystemService(projectRoot, workspaceRoot);

    const opened = await service.readTextFile('project-1', reportPath);
    assert.equal(opened.content, 'what the run found');
    const streamed = await service.openFile('project-1', reportPath);
    streamed.stream.destroy();

    await assert.rejects(
      service.saveTextFile('project-1', reportPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: reportPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.equal(await fsPromises.readFile(reportPath, 'utf8'), 'what the run found');

    // A link inside the workspace does not open what lies outside it.
    await assert.rejects(
      service.readTextFile('project-1', path.join(workspaceRoot, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test('shallow file listing reads one directory without traversing its descendants', async () => {
  const root = path.resolve('lazy-project');
  const opened: string[] = [];
  const service = createFileTreeService(createDependencies(createFakeFileSystem({
    access: async () => undefined,
    realpath: async (candidate) => candidate,
    stat: async () => createStats(true, 0o755),
    lstat: async () => createStats(false, 0o644),
    openDirectory: createDirectoryReader((directory) => {
      opened.push(directory);
      assert.equal(directory, root);
      return [createDirectoryEntry('src', true), createDirectoryEntry('README.md', false)];
    }),
  }), root));
  const listing = await service.listProjectFiles('p1', { respectGitignore: false, shallow: true });
  assert.deepEqual(opened, [root]);
  assert.equal(listing[0].name, 'src');
  assert.equal(listing[0].children, undefined);
});

test('shallow file listing rejects traversal and symlink escapes', async () => {
  const root = path.resolve('lazy-project');
  let reads = 0;
  const service = createFileTreeService(createDependencies(createFakeFileSystem({
    access: async () => undefined,
    realpath: async (candidate) => candidate.endsWith('/link') ? path.dirname(root) : candidate,
    openDirectory: createDirectoryReader(() => { reads += 1; return []; }),
  }), root));
  for (const directory of ['..', 'link', `${root}-sibling`]) {
    await assert.rejects(service.listProjectFiles('p1', { respectGitignore: false, shallow: true, directory }),
      (error: unknown) => error instanceof AppError && error.statusCode === 403);
  }
  assert.equal(reads, 0);
});

function createCachedTreeFixture() {
  const root = path.resolve('cached-tree-project');
  const state = {
    now: 0,
    directoryMtime: new Date('2026-01-02T03:04:05.000Z'),
    gitignore: '*.log',
    opened: [] as string[],
    directories: new Map<string, FileTreeDirectoryEntry[]>([
      [root, [createDirectoryEntry('README.md', false)]],
    ]),
  };
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    realpath: async (candidate) => candidate,
    stat: async () => ({ ...createStats(true, 0o755), mtime: state.directoryMtime }),
    lstat: async () => createStats(false, 0o644),
    readTextFile: async () => state.gitignore,
    writeTextFile: async () => undefined,
    openDirectory: createDirectoryReader((directory) => {
      state.opened.push(directory);
      return state.directories.get(directory) ?? [];
    }),
  });
  const dependencies = createDependencies(fileSystem, root);
  dependencies.now = () => state.now;
  return { root, state, dependencies };
}

test('shallow cache coalesces simultaneous reads and expires, refreshes, and detects external directory changes', async () => {
  const { root, state, dependencies } = createCachedTreeFixture();
  const service = createFileTreeService(dependencies);
  const options = { respectGitignore: false, shallow: true };
  const results = await Promise.all(Array.from({ length: 8 }, () => service.listProjectFiles('p1', options)));
  assert.equal(state.opened.length, 1);
  assert.ok(results.every((result) => result[0].name === 'README.md'));
  await service.listProjectFiles('p1', options);
  assert.equal(state.opened.length, 1);
  state.now = 20_001;
  await service.listProjectFiles('p1', options);
  assert.equal(state.opened.length, 2);
  await service.listProjectFiles('p1', { ...options, refresh: true });
  assert.equal(state.opened.length, 3);
  state.directoryMtime = new Date('2026-01-02T03:04:06.000Z');
  state.directories.set(root, [createDirectoryEntry('new.md', false)]);
  assert.equal((await service.listProjectFiles('p1', options))[0].name, 'new.md');
  assert.equal(state.opened.length, 4);
});

test('directory cache respects gitignore mode and changes to the ignore file', async () => {
  const { root, state, dependencies } = createCachedTreeFixture();
  state.directories.set(root, [createDirectoryEntry('debug.log', false), createDirectoryEntry('README.md', false)]);
  const service = createFileTreeService(dependencies);
  assert.equal((await service.listProjectFiles('p1', { respectGitignore: true, shallow: true })).length, 1);
  assert.equal((await service.listProjectFiles('p1', { respectGitignore: false, shallow: true })).length, 2);
  state.gitignore = '*.md';
  assert.deepEqual((await service.listProjectFiles('p1', { respectGitignore: true, shallow: true })).map((node) => node.name), ['debug.log']);
  assert.equal(state.opened.length, 3);
});

test('writes invalidate cached parent workspaces and cannot be overwritten by an older pending read', async () => {
  const { root, state, dependencies } = createCachedTreeFixture();
  let finishRead: () => void = () => undefined;
  let readStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { finishRead = resolve; });
  let reads = 0;
  dependencies.fileSystem.openDirectory = async function* () {
    const entries = state.directories.get(root) ?? [];
    if (++reads === 1) {
      readStarted();
      await blocked;
    }
    yield* entries;
  };
  dependencies.projects.getProjectPathById = async (id) => id === 'nested' ? path.join(root, 'nested') : root;
  const service = createFileTreeService(dependencies);
  const oldRead = service.listProjectFiles('parent', { respectGitignore: false, shallow: true });
  await started;
  await service.saveTextFile('nested', 'new.md', 'new');
  state.directories.set(root, [createDirectoryEntry('new.md', false)]);
  finishRead();
  assert.equal((await oldRead)[0].name, 'README.md');
  assert.equal((await service.listProjectFiles('parent', { respectGitignore: false, shallow: true }))[0].name, 'new.md');
  assert.equal(reads, 2);
});

test('cached directories are revalidated when a safe path becomes an escaping symlink', async () => {
  const { root, state, dependencies } = createCachedTreeFixture();
  const service = createFileTreeService(dependencies);
  const options = { respectGitignore: false, shallow: true, directory: 'link' };
  await service.listProjectFiles('p1', options);
  dependencies.fileSystem.realpath = async (candidate) => candidate.endsWith('/link') ? path.dirname(root) : candidate;
  await assert.rejects(service.listProjectFiles('p1', options), (error: unknown) => error instanceof AppError && error.statusCode === 403);
  assert.equal(state.opened.length, 1);
});

test('snapshot preloads breadth-first with a depth bound while excluding dependency directories', async () => {
  const { root, state, dependencies } = createCachedTreeFixture();
  state.directories.set(root, [createDirectoryEntry('src', true), createDirectoryEntry('docs', true), createDirectoryEntry('node_modules', true), createDirectoryEntry('.git', true)]);
  state.directories.set(path.join(root, 'docs'), [createDirectoryEntry('one', true)]);
  state.directories.set(path.join(root, 'docs/one'), [createDirectoryEntry('two', true)]);
  state.directories.set(path.join(root, 'docs/one/two'), [createDirectoryEntry('three', true)]);
  state.directories.set(path.join(root, 'docs/one/two/three'), [createDirectoryEntry('deep.md', false)]);
  const service = createFileTreeService(dependencies);
  const snapshot = await service.snapshotProjectFiles('p1', { respectGitignore: false });
  assert.equal(snapshot.rootPath, root);
  assert.deepEqual(snapshot.directories.map((directory) => path.relative(root, directory.path)), ['', 'docs', 'src', 'docs/one', 'docs/one/two']);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.directories[0].children[0].children, undefined);
  assert.equal(state.opened.some((directory) => /node_modules|\.git/.test(directory)), false);
  const before = state.opened.length;
  await service.listProjectFiles('p1', { respectGitignore: false, shallow: true, directory: 'docs' });
  assert.equal(state.opened.length, before, 'Shallow requests reuse prefetched directories');
});

test('snapshot directory cap leaves the remaining directories unloaded', async () => {
  const { root, state, dependencies } = createCachedTreeFixture();
  state.directories.set(root, Array.from({ length: 200 }, (_, index) => createDirectoryEntry(`directory-${index}`, true)));
  const snapshot = await createFileTreeService(dependencies).snapshotProjectFiles('p1', { respectGitignore: false });
  assert.equal(snapshot.directories.length, 96);
  assert.equal(state.opened.length, 96);
  assert.equal(snapshot.directories[0].children.length, 200);
  assert.equal(snapshot.truncated, true);
});

test('snapshot node budget omits entire directories instead of presenting partial listings', async () => {
  const { root, state, dependencies } = createCachedTreeFixture();
  state.directories.set(root, [createDirectoryEntry('a', true), createDirectoryEntry('b', true)]);
  for (const directory of ['a', 'b']) {
    state.directories.set(path.join(root, directory), Array.from({ length: 6000 }, (_, index) => createDirectoryEntry(`file-${index}.md`, false)));
  }
  const snapshot = await createFileTreeService(dependencies).snapshotProjectFiles('p1', { respectGitignore: false });
  assert.deepEqual(snapshot.directories.map((directory) => path.relative(root, directory.path)), ['', 'a']);
  assert.equal(snapshot.directories[1].children.length, 6000);
  assert.equal(snapshot.directories.reduce((sum, directory) => sum + directory.children.length, 0), 6002);
  assert.equal(snapshot.truncated, true);
});

test('snapshot time budget always preserves a complete root and stops speculative reads', async () => {
  const { root, state, dependencies } = createCachedTreeFixture();
  state.directories.set(root, [createDirectoryEntry('src', true), createDirectoryEntry('README.md', false)]);
  dependencies.fileSystem.lstat = async () => { state.now = 400; return createStats(false, 0o644); };
  const snapshot = await createFileTreeService(dependencies).snapshotProjectFiles('p1', { respectGitignore: false });
  assert.deepEqual(snapshot.directories.map((directory) => directory.path), [root]);
  assert.equal(snapshot.directories[0].children.length, 2);
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(state.opened, [root]);
});

test('snapshot rejects unreadable roots without caching them as empty folders', async () => {
  const { dependencies } = createCachedTreeFixture();
  let reads = 0;
  dependencies.fileSystem.openDirectory = async function* () {
    yield* [];
    reads += 1;
    throw Object.assign(new Error('No permission'), { code: 'EACCES' });
  };
  const service = createFileTreeService(dependencies);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(service.snapshotProjectFiles('p1', { respectGitignore: false }),
      (error: unknown) => error instanceof AppError && error.statusCode === 403);
  }
  assert.equal(reads, 2);
});

test('directory cache evicts least recently used listings when its directory cap is reached', async () => {
  const { state, dependencies } = createCachedTreeFixture();
  const service = createFileTreeService(dependencies);
  for (let index = 0; index < 257; index += 1) {
    await service.listProjectFiles('p1', { respectGitignore: false, shallow: true, directory: `dir-${index}` });
  }
  await service.listProjectFiles('p1', { respectGitignore: false, shallow: true, directory: 'dir-256' });
  assert.equal(state.opened.length, 257);
  await service.listProjectFiles('p1', { respectGitignore: false, shallow: true, directory: 'dir-0' });
  assert.equal(state.opened.length, 258);
});
