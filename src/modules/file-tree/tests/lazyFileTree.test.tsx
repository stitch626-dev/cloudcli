import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import type { FileTreeNode, FileTreeSnapshot, Project } from '@/shared/types';
import { useFileTreeData } from '@/modules/file-tree/hooks/useFileTreeData';
import { AUTH_SESSION_CLEARED_EVENT, AUTH_SESSION_EXPIRED_EVENT } from '@/shared/authToken';
import { FILE_TREE_CHANGED_EVENT } from '@/shared/constants';
import type * as ApiModule from '@/shared/api';

const { getFileTreeSnapshot } = vi.hoisted(() => ({ getFileTreeSnapshot: vi.fn() }));
vi.mock('@/shared/api', async (importOriginal) => ({
  ...await importOriginal<typeof ApiModule>(),
  api: { getFileTreeSnapshot },
}));
const project: Project = { projectId: 'p1', fullPath: '/repo', displayName: 'repo' };
const root: FileTreeNode[] = [{ name: 'src', path: '/repo/src', type: 'directory' }];
const children: FileTreeNode[] = [{ name: 'app.ts', path: '/repo/src/app.ts', type: 'file' }];
let userId = 0;
const token = (id: number) => `e30.${btoa(JSON.stringify({ userId: id }))}.signature`;
const response = (rootPath = '/repo', directories: FileTreeSnapshot['directories'] = [{ path: '/repo', children: root }]) => ({ ok: true, json: async () => ({ rootPath, directories, truncated: false }) });
const fullResponse = () => response('/repo', [{ path: '/repo', children: root }, { path: '/repo/src', children }]);

beforeEach(() => {
  getFileTreeSnapshot.mockReset();
  sessionStorage.clear();
  localStorage.setItem('auth-token', token(++userId));
  window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT));
});

test('preloads child folders in one request and reuses them on expansion', async () => {
  getFileTreeSnapshot.mockResolvedValue(fullResponse());
  const { result, rerender } = renderHook(({ expanded }) => useFileTreeData(project, expanded), { initialProps: { expanded: new Set<string>() } });
  await waitFor(() => expect(result.current.files[0]?.children?.[0].name).toBe('app.ts'));
  rerender({ expanded: new Set(['/repo/src']) });
  expect(getFileTreeSnapshot).toHaveBeenCalledTimes(1);
  expect(result.current.loading).toBe(false);
});

test('loads omitted branches once, then keeps the existing tree visible during a forced refresh', async () => {
  getFileTreeSnapshot.mockImplementation(async (_id, _options, directory) => directory ? response(directory, [{ path: directory, children }]) : response());
  const { result, rerender } = renderHook(({ expanded }) => useFileTreeData(project, expanded), { initialProps: { expanded: new Set<string>() } });
  await waitFor(() => expect(result.current.files).toHaveLength(1));
  rerender({ expanded: new Set(['/repo/src']) });
  await waitFor(() => expect(result.current.files[0].children?.[0].name).toBe('app.ts'));
  rerender({ expanded: new Set() });
  rerender({ expanded: new Set(['/repo/src']) });
  expect(getFileTreeSnapshot).toHaveBeenCalledTimes(2);
  let finishRefresh: (value: unknown) => void = () => undefined;
  getFileTreeSnapshot.mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
  act(() => result.current.refreshFiles());
  expect(result.current.files[0].children?.[0].name).toBe('app.ts');
  expect(result.current.loading).toBe(false);
  expect(result.current.refreshing).toBe(true);
  expect(getFileTreeSnapshot.mock.calls[2][3]).toBe(true);
  await act(async () => finishRefresh(fullResponse()));
  expect(result.current.refreshing).toBe(false);
});

test('a previous project response cannot overwrite the current project', async () => {
  let finishOld: (value: unknown) => void = () => undefined;
  getFileTreeSnapshot.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
    .mockResolvedValueOnce(response('/new', [{ path: '/new', children: [{ name: 'new.txt', path: '/new/new.txt', type: 'file' }] }]));
  const { result, rerender } = renderHook(({ selected }) => useFileTreeData(selected), { initialProps: { selected: project } });
  rerender({ selected: { ...project, projectId: 'p2', fullPath: '/new' } });
  await waitFor(() => expect(result.current.files[0]?.name).toBe('new.txt'));
  await act(async () => finishOld(fullResponse()));
  expect(result.current.files[0].name).toBe('new.txt');
});

test('returning to a project and remounting reuse the authenticated cache immediately', async () => {
  getFileTreeSnapshot.mockImplementation(async (id) => id === 'p1' ? fullResponse() : response('/new', [{ path: '/new', children: [] }]));
  const hook = renderHook(({ selected }) => useFileTreeData(selected), { initialProps: { selected: project } });
  await waitFor(() => expect(hook.result.current.files).toHaveLength(1));
  hook.rerender({ selected: { ...project, projectId: 'p2', fullPath: '/new' } });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  hook.rerender({ selected: project });
  expect(hook.result.current.files[0].children?.[0].name).toBe('app.ts');
  expect(getFileTreeSnapshot).toHaveBeenCalledTimes(2);
  hook.unmount();
  const remounted = renderHook(() => useFileTreeData(project));
  expect(remounted.result.current.files[0].name).toBe('src');
  expect(getFileTreeSnapshot).toHaveBeenCalledTimes(2);
  expect(sessionStorage.getItem('file-tree-cache:v1')).toContain('app.ts');
});

test('expired cache stays visible while revalidating and editor saves force an update', async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  getFileTreeSnapshot.mockResolvedValue(fullResponse());
  const hook = renderHook(() => useFileTreeData(project));
  await waitFor(() => expect(hook.result.current.files).toHaveLength(1));
  clock.mockReturnValue(now + 31_000);
  let finish: (value: unknown) => void = () => undefined;
  getFileTreeSnapshot.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => window.dispatchEvent(new Event('focus')));
  expect(hook.result.current.files[0].name).toBe('src');
  expect(hook.result.current.loading).toBe(false);
  await act(async () => finish(fullResponse()));
  act(() => window.dispatchEvent(new CustomEvent(FILE_TREE_CHANGED_EVENT, { detail: { projectId: 'p1' } })));
  await waitFor(() => expect(getFileTreeSnapshot).toHaveBeenCalledTimes(3));
  expect(getFileTreeSnapshot.mock.calls[2][3]).toBe(true);
});

test('a different account cannot see cached paths and logout clears persistence', async () => {
  getFileTreeSnapshot.mockResolvedValueOnce(fullResponse());
  const hook = renderHook(() => useFileTreeData(project));
  await waitFor(() => expect(hook.result.current.files).toHaveLength(1));
  hook.unmount();
  localStorage.setItem('auth-token', token(++userId));
  getFileTreeSnapshot.mockImplementation(() => new Promise(() => {}));
  const nextUser = renderHook(() => useFileTreeData(project));
  expect(nextUser.result.current.files).toEqual([]);
  expect(nextUser.result.current.loading).toBe(true);
  localStorage.removeItem('auth-token');
  nextUser.unmount();
  expect(sessionStorage.getItem('file-tree-cache:v1')).toBeNull();
});

test('caps parallel requests and drains expanded folders without duplicate requests', async () => {
  const folders: FileTreeNode[] = Array.from({ length: 5 }, (_, i) => ({ name: `d${i}`, path: `/repo/d${i}`, type: 'directory' }));
  const resolvers: (() => void)[] = [];
  getFileTreeSnapshot.mockImplementation(async (_id, _options, directory) => {
    if (!directory) return response('/repo', [{ path: '/repo', children: folders }]);
    return new Promise((resolve) => resolvers.push(() => resolve(response(directory, [{ path: directory, children: [] }]))));
  });
  renderHook(() => useFileTreeData(project, new Set(folders.map((node) => node.path))));
  await waitFor(() => expect(getFileTreeSnapshot).toHaveBeenCalledTimes(4));
  await act(async () => resolvers.splice(0).forEach((resolve) => resolve()));
  await waitFor(() => expect(getFileTreeSnapshot).toHaveBeenCalledTimes(6));
  await act(async () => resolvers.splice(0).forEach((resolve) => resolve()));
  expect(getFileTreeSnapshot).toHaveBeenCalledTimes(6);
});

test('token renewal preserves the same account cache', async () => {
  getFileTreeSnapshot.mockResolvedValue(fullResponse());
  const hook = renderHook(() => useFileTreeData(project));
  await waitFor(() => expect(hook.result.current.files).toHaveLength(1));
  hook.unmount();
  localStorage.setItem('auth-token', `e30.${btoa(JSON.stringify({ userId, refreshed: true }))}.renewed`);
  const renewed = renderHook(() => useFileTreeData(project));
  expect(renewed.result.current.files[0].name).toBe('src');
  expect(getFileTreeSnapshot).toHaveBeenCalledTimes(1);
});

test('refreshing a nested workspace invalidates its parent project cache', async () => {
  const nested = { ...project, projectId: 'nested', fullPath: '/repo/src' };
  getFileTreeSnapshot.mockImplementation(async (id) => id === 'p1' ? fullResponse() : response('/repo/src', [{ path: '/repo/src', children }]));
  const hook = renderHook(({ selected }) => useFileTreeData(selected), { initialProps: { selected: project } });
  await waitFor(() => expect(hook.result.current.files[0]?.name).toBe('src'));
  hook.rerender({ selected: nested });
  await waitFor(() => expect(hook.result.current.files[0]?.name).toBe('app.ts'));
  act(() => hook.result.current.refreshFiles());
  await waitFor(() => expect(getFileTreeSnapshot).toHaveBeenCalledTimes(3));
  hook.rerender({ selected: project });
  await waitFor(() => expect(getFileTreeSnapshot).toHaveBeenCalledTimes(4));
});

test('a successful parallel folder cannot hide another folder failure', async () => {
  const folders: FileTreeNode[] = ['a', 'b'].map((name) => ({ name, path: `/repo/${name}`, type: 'directory' }));
  let finishSuccess: (value: unknown) => void = () => undefined;
  getFileTreeSnapshot.mockImplementation(async (_id, _options, directory) => {
    if (!directory) return response('/repo', [{ path: '/repo', children: folders }]);
    if (directory === '/repo/a') return { ok: false, json: async () => ({ error: { message: 'Access denied' } }) };
    return new Promise((resolve) => { finishSuccess = resolve; });
  });
  const hook = renderHook(() => useFileTreeData(project, new Set(['/repo/a', '/repo/b'])));
  await waitFor(() => expect(hook.result.current.error).toBe('Access denied'));
  await act(async () => finishSuccess(response('/repo/b', [{ path: '/repo/b', children: [] }])));
  expect(hook.result.current.error).toBe('Access denied');
  expect(hook.result.current.files[0].loadError).toBe('Access denied');
  expect(hook.result.current.files[1].children).toEqual([]);
  expect(getFileTreeSnapshot).toHaveBeenCalledTimes(3);
});

test('logout clears private cache even after the explorer has been hidden', async () => {
  getFileTreeSnapshot.mockResolvedValue(fullResponse());
  const hook = renderHook(() => useFileTreeData(project));
  await waitFor(() => expect(hook.result.current.files).toHaveLength(1));
  hook.unmount();
  expect(sessionStorage.getItem('file-tree-cache:v1')).toContain('app.ts');
  localStorage.removeItem('auth-token');
  window.dispatchEvent(new Event(AUTH_SESSION_CLEARED_EVENT));
  expect(sessionStorage.getItem('file-tree-cache:v1')).toBeNull();
  localStorage.setItem('auth-token', token(userId));
  getFileTreeSnapshot.mockImplementation(() => new Promise(() => {}));
  const reopened = renderHook(() => useFileTreeData(project));
  expect(reopened.result.current.files).toEqual([]);
});

test('saving from the editor while the explorer is hidden invalidates its cached metadata', async () => {
  getFileTreeSnapshot.mockResolvedValue(fullResponse());
  const hook = renderHook(() => useFileTreeData(project));
  await waitFor(() => expect(hook.result.current.files[0]?.children?.[0].name).toBe('app.ts'));
  hook.unmount();
  window.dispatchEvent(new CustomEvent(FILE_TREE_CHANGED_EVENT, {
    detail: { projectId: project.projectId, filePath: '/repo/src/app.ts' },
  }));
  getFileTreeSnapshot.mockResolvedValue(response('/repo', [
    { path: '/repo', children: root },
    { path: '/repo/src', children: [{ ...children[0], size: 1234 }] },
  ]));
  const reopened = renderHook(() => useFileTreeData(project));
  expect(reopened.result.current.files).toEqual([]);
  await waitFor(() => expect(reopened.result.current.files[0]?.children?.[0].size).toBe(1234));
  expect(getFileTreeSnapshot).toHaveBeenCalledTimes(2);
});
