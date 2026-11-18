import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

function deferResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('concurrent metadata readers share transport but each can consume its own response', async () => {
  const deferred = deferResponse();
  const fetcher = vi.fn(() => deferred.promise);
  vi.stubGlobal('fetch', fetcher);
  const first = api.providers.capabilities();
  const second = api.providers.capabilities();
  expect(fetcher).toHaveBeenCalledTimes(1);
  deferred.resolve(Response.json({ available: true }));
  const responses = await Promise.all([first, second]);
  expect(await Promise.all(responses.map((response) => response.json()))).toEqual([{ available: true }, { available: true }]);
  fetcher.mockResolvedValueOnce(Response.json({ available: false }));
  expect(await (await api.providers.capabilities()).json()).toEqual({ available: false });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('read sharing never crosses accounts or workspaces', async () => {
  const deferred = deferResponse();
  const fetcher = vi.fn(() => deferred.promise);
  vi.stubGlobal('fetch', fetcher);
  localStorage.setItem('auth-token', 'account-a');
  const first = api.commands.list('/repo/a');
  const same = api.commands.list('/repo/a');
  const otherProject = api.commands.list('/repo/b');
  localStorage.setItem('auth-token', 'account-b');
  const otherUser = api.commands.list('/repo/a');
  expect(fetcher).toHaveBeenCalledTimes(3);
  deferred.resolve(Response.json([]));
  await Promise.all([first, same, otherProject, otherUser]);
});

test('a failed read can be retried and mutations remain independent', async () => {
  const deferred = deferResponse();
  const fetcher = vi.fn(() => deferred.promise);
  vi.stubGlobal('fetch', fetcher);
  const first = api.providers.capabilities();
  const second = api.providers.capabilities();
  deferred.reject(new Error('offline'));
  await Promise.all([expect(first).rejects.toThrow('offline'), expect(second).rejects.toThrow('offline')]);
  fetcher.mockResolvedValue(Response.json({ success: true }));
  await api.providers.capabilities();
  await Promise.all([api.commands.execute({ command: 'x' }), api.commands.execute({ command: 'x' })]);
  expect(fetcher).toHaveBeenCalledTimes(4);
});
