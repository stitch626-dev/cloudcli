import { useDeferredValue, useEffect, useMemo, useState } from 'react';

import { collectExpandedDirectoryPaths, filterFileTree } from '@/modules/file-tree/utils/fileTreeUtils';
import type { FileTreeNode } from '@/shared/types';

type UseFileTreeSearchArgs = {
  files: FileTreeNode[];
  expandDirectories: (paths: string[]) => void;
};

type UseFileTreeSearchResult = {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  filteredFiles: FileTreeNode[];
};

export function useFileTreeSearch({
  files,
  expandDirectories,
}: UseFileTreeSearchArgs): UseFileTreeSearchResult {
  // Keep typing immediate while a large prefetched tree is being filtered.
  const [searchQuery, setSearchQuery] = useState('');
  const deferredQuery = useDeferredValue(searchQuery);

  // Derived, not stored: mirroring the filter into state made every keystroke
  // (and every tree refresh) cost an extra render, and left `filteredFiles` one
  // render behind `files`.
  const filteredFiles = useMemo(() => {
    const query = deferredQuery.trim().toLowerCase();
    return query ? filterFileTree(files, query) : files;
  }, [files, deferredQuery]);

  useEffect(() => {
    if (!deferredQuery.trim()) {
      return;
    }
    // Keep search results visible by opening every matching ancestor directory once per query update.
    expandDirectories(collectExpandedDirectoryPaths(filteredFiles));
  }, [expandDirectories, filteredFiles, deferredQuery]);

  return {
    searchQuery,
    setSearchQuery,
    filteredFiles,
  };
}
