import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import FolderBrowserModal from '@/modules/project-creation-wizard/FolderBrowserModal';

const { browse } = vi.hoisted(() => ({ browse: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/modules/project-creation-wizard/utils/workspaceApi', () => ({
  browseFilesystemFolders: browse,
  createFolderInFilesystem: vi.fn(),
}));

const root = '/Users/robert/Desktop/code/doit';
const listing = (directory: string, names: string[] = []) => ({
  path: directory,
  suggestions: names.map((name) => ({ name, path: `${directory}/${name}`, type: 'directory' as const })),
});
const props = { isOpen: true, autoAdvanceOnSelect: false, onClose: vi.fn(), onFolderSelected: vi.fn() };

beforeEach(() => {
  browse.mockReset();
});

test('starts at the server default, caches navigation, remembers the folder, and supports refresh', async () => {
  browse.mockImplementation(async (target: string) => target === `${root}/project`
    ? listing(target, ['src'])
    : listing(root, ['project']));
  const view = render(<FolderBrowserModal {...props} />);
  await screen.findByRole('button', { name: 'project' });
  expect(browse).toHaveBeenNthCalledWith(1, '');

  fireEvent.click(screen.getByRole('button', { name: 'project' }));
  await screen.findByRole('button', { name: 'src' });
  fireEvent.click(screen.getByRole('button', { name: '..' }));
  await screen.findByRole('button', { name: 'project' });
  expect(browse).toHaveBeenCalledTimes(2);

  view.rerender(<FolderBrowserModal {...props} isOpen={false} />);
  view.rerender(<FolderBrowserModal {...props} />);
  await screen.findByRole('button', { name: 'project' });
  expect(browse).toHaveBeenCalledTimes(2);

  fireEvent.click(screen.getByTitle('common:buttons.refresh'));
  await waitFor(() => expect(browse).toHaveBeenCalledTimes(3));
  expect(browse).toHaveBeenLastCalledWith(root);
});

test('starts at the existing workspace field when one has been entered', async () => {
  browse.mockResolvedValue(listing('/workspace/selected'));
  render(<FolderBrowserModal {...props} initialPath="/workspace/selected" />);
  await waitFor(() => expect(browse).toHaveBeenCalledWith('/workspace/selected'));
  await screen.findByText('/workspace/selected');
});

test('a request finishing after close and reopen cannot replace the current folder', async () => {
  let finishOld!: (value: ReturnType<typeof listing>) => void;
  browse.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  browse.mockResolvedValueOnce(listing(root, ['current-project']));
  const view = render(<FolderBrowserModal {...props} />);
  const useFolder = screen.getByRole('button', { name: 'folderBrowser.useThisFolder' }) as HTMLButtonElement;
  expect(useFolder.disabled).toBe(true);

  view.rerender(<FolderBrowserModal {...props} isOpen={false} />);
  view.rerender(<FolderBrowserModal {...props} />);
  await screen.findByRole('button', { name: 'current-project' });
  await act(async () => { finishOld(listing('/stale', ['stale-project'])); });
  expect(screen.queryByText('stale-project')).toBeNull();
  expect(screen.getByText(root)).toBeTruthy();
});
