import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { Project, FileTreeNode } from '@/shared/types';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  error: string | null;
  refreshFiles: () => void;
};

function replaceChildren(nodes: FileTreeNode[], directory: string, children: FileTreeNode[]): FileTreeNode[] {
  return nodes.map((node) => node.path === directory
    ? { ...node, children }
    : node.children ? { ...node, children: replaceChildren(node.children, directory, children) } : node);
}

function findDirectory(nodes: FileTreeNode[], directory: string): FileTreeNode | undefined {
  for (const node of nodes) {
    if (node.path === directory) return node;
    const found = node.children && findDirectory(node.children, directory);
    if (found) return found;
  }
}

/** Used by FileTree to load only its root and expanded directories, retaining loaded branches across tabs. */
export function useFileTreeData(selectedProject: Project | null, expandedDirs?: Set<string>): UseFileTreeDataResult {
  // Keep loaded branches so reopening a folder never repeats the same request.
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  // Only the initial root load replaces the tree with a loading state.
  const [loading, setLoading] = useState(false);
  // Surface server refusals with a retry action instead of an unexplained empty tree.
  const [error, setError] = useState<string | null>(null);
  // A refresh invalidates every loaded branch; expanded folders are then loaded again.
  const [refreshKey, setRefreshKey] = useState(0);
  const generationRef = useRef(0);
  const rootReadyRef = useRef(false);
  const pendingRef = useRef(new Map<string, AbortController>());
  const failedRef = useRef(new Set<string>());
  const projectId = selectedProject?.projectId;

  const refreshFiles = useCallback(() => setRefreshKey((key) => key + 1), []);

  const loadDirectory = useCallback(async (directory: string, generation: number) => {
    if (!projectId || pendingRef.current.has(directory) || failedRef.current.has(directory)) return;
    const controller = new AbortController();
    pendingRef.current.set(directory, controller);
    try {
      const response = await api.getFiles(projectId, { signal: controller.signal }, directory);
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || 'Unable to load this folder.');
      }
      const children = await response.json() as FileTreeNode[];
      if (generationRef.current !== generation) return;
      if (directory === '') {
        rootReadyRef.current = true;
        setFiles(children);
      } else {
        setFiles((previous) => replaceChildren(previous, directory, children));
      }
    } catch (loadError) {
      if (controller.signal.aborted || generationRef.current !== generation) return;
      failedRef.current.add(directory);
      setError(loadError instanceof Error ? loadError.message : 'Unable to load this folder.');
    } finally {
      if (generationRef.current === generation) {
        pendingRef.current.delete(directory);
        if (directory === '') setLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    const generation = ++generationRef.current;
    rootReadyRef.current = false;
    failedRef.current.clear();
    setFiles([]);
    setError(null);
    setLoading(Boolean(projectId));
    if (projectId) void loadDirectory('', generation);
    const pending = pendingRef.current;
    return () => {
      generationRef.current += 1;
      pending.forEach((controller) => controller.abort());
      pending.clear();
    };
  }, [projectId, refreshKey, loadDirectory]);

  useEffect(() => {
    if (!rootReadyRef.current) return;
    expandedDirs?.forEach((directory) => {
      const node = findDirectory(files, directory);
      if (node?.type === 'directory' && node.children === undefined) {
        void loadDirectory(directory, generationRef.current);
      }
    });
  }, [expandedDirs, files, loadDirectory]);

  return { files, loading, error, refreshFiles };
}
