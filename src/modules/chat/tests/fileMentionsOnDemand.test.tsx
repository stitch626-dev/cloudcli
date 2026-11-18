import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

const getFiles = vi.fn();
vi.mock('@/shared/api', () => ({ api: { getFiles: (...args: unknown[]) => getFiles(...args) } }));
const { useFileMentions } = await import('@/modules/chat/hooks/useFileMentions');
const project = (id: string): Project => ({ projectId: id, displayName: id, fullPath: `/repo/${id}` });

test('mounting and switching projects never requests recursive files without a mention', () => {
  getFiles.mockReset();
  const hook = renderHook(({ selectedProject }) => useFileMentions({ selectedProject, input: '', setInput: vi.fn(), textareaRef: { current: null } }), { initialProps: { selectedProject: project('a') } });
  hook.rerender({ selectedProject: project('b') });
  expect(getFiles).not.toHaveBeenCalled();
});

test('switching projects and unmounting cancel pending mention requests', async () => {
  getFiles.mockReset();
  const resolveResponses: Array<(response: unknown) => void> = [];
  getFiles.mockImplementation(() => new Promise(resolve => resolveResponses.push(resolve)));
  const hook = renderHook(({ selectedProject }) => useFileMentions({ selectedProject, input: '@', setInput: vi.fn(), textareaRef: { current: null } }), { initialProps: { selectedProject: project('a') } });
  act(() => hook.result.current.setCursorPosition(1));
  await waitFor(() => expect(getFiles).toHaveBeenCalledTimes(1));
  const firstSignal = getFiles.mock.calls[0][1].signal as AbortSignal;
  hook.rerender({ selectedProject: project('b') });
  await waitFor(() => expect(getFiles).toHaveBeenCalledTimes(2));
  expect(firstSignal.aborted).toBe(true);
  await act(async () => resolveResponses[0]({ ok: true, json: async () => [{ type: 'file', name: 'old.txt' }] }));
  expect(hook.result.current.filteredFiles).toEqual([]);
  const secondSignal = getFiles.mock.calls[1][1].signal as AbortSignal;
  hook.unmount();
  expect(secondSignal.aborted).toBe(true);
});
