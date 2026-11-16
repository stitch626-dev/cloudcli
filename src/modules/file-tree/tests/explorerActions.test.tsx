import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import FileTreeHeader from '@/modules/file-tree/FileTreeHeader';
import FileTreeNode from '@/modules/file-tree/FileTreeNode';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback || key }),
}));
afterEach(cleanup);

test('explorer toolbar keeps file actions without view switches', () => {
  const refresh = vi.fn();
  render(<FileTreeHeader searchQuery="" onSearchQueryChange={vi.fn()} onRefresh={refresh} />);
  expect(screen.queryByLabelText('fileTree.compactView')).toBeNull();
  expect(screen.queryByLabelText('fileTree.detailedView')).toBeNull();
  fireEvent.click(screen.getByLabelText('Refresh'));
  expect(refresh).toHaveBeenCalledOnce();
});

test.each(['file', 'directory'] as const)('copying a %s path does not open it or trigger upload', (type) => {
  const item = { name: '中文 名称', path: '/项目/中文 名称', type };
  const onItemClick = vi.fn();
  const onCopyPath = vi.fn();
  const onUpload = vi.fn();
  render(<FileTreeNode item={item} level={0} expandedDirs={new Set()} onItemClick={onItemClick}
    renderFileIcon={() => null} onCopyPath={onCopyPath} onUpload={onUpload} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy Path' }));
  expect(onCopyPath).toHaveBeenCalledWith(item);
  expect(onItemClick).not.toHaveBeenCalled();
  expect(onUpload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText(item.name));
  expect(onItemClick).toHaveBeenCalledWith(item);
});
