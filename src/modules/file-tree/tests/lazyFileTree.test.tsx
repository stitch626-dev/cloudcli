import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import type { FileTreeNode, Project } from '@/shared/types';
import { useFileTreeData } from '@/modules/file-tree/hooks/useFileTreeData';

const { getFiles } = vi.hoisted(() => ({ getFiles: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { getFiles } }));
const project: Project = { projectId: 'p1', fullPath: '/repo', displayName: 'repo' };
const root: FileTreeNode[] = [{ name: 'src', path: '/repo/src', type: 'directory' }];
beforeEach(() => getFiles.mockReset());

test('loads branches only on expansion, reuses them and refreshes expanded directories', async () => {
  getFiles.mockImplementation(async (_id, _options, directory) => ({ ok: true, json: async () => directory ? [{ name: 'app.ts', path: '/repo/src/app.ts', type: 'file' }] : root }));
  const { result, rerender } = renderHook(({ expanded }) => useFileTreeData(project, expanded), { initialProps: { expanded: new Set<string>() } });
  await waitFor(() => expect(result.current.files).toHaveLength(1));
  expect(getFiles).toHaveBeenCalledTimes(1);
  rerender({ expanded: new Set(['/repo/src']) });
  await waitFor(() => expect(result.current.files[0].children?.[0].name).toBe('app.ts'));
  rerender({ expanded: new Set() });
  rerender({ expanded: new Set(['/repo/src']) });
  expect(getFiles).toHaveBeenCalledTimes(2);
  act(() => result.current.refreshFiles());
  await waitFor(() => expect(getFiles).toHaveBeenCalledTimes(4));
  await waitFor(() => expect(result.current.files[0].children?.[0].name).toBe('app.ts'));
});

test('a previous project response cannot overwrite the current project', async () => {
  let finishOld: (value: unknown) => void = () => undefined;
  getFiles.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
    .mockResolvedValueOnce({ ok: true, json: async () => [{ name: 'new.txt', path: '/new/new.txt', type: 'file' }] });
  const { result, rerender } = renderHook(({ selected }) => useFileTreeData(selected), { initialProps: { selected: project } });
  rerender({ selected: { ...project, projectId: 'p2', fullPath: '/new' } });
  await waitFor(() => expect(result.current.files[0]?.name).toBe('new.txt'));
  await act(async () => finishOld({ ok: true, json: async () => root }));
  expect(result.current.files[0].name).toBe('new.txt');
});
