import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiErrorMessage } from '@/shared/api';
import { AUTH_SESSION_CLEARED_EVENT, AUTH_SESSION_EXPIRED_EVENT, getStoredAuthToken } from '@/shared/authToken';
import { FILE_TREE_CHANGED_EVENT } from '@/shared/constants';
import type { Project, FileTreeNode, FileTreeSnapshot } from '@/shared/types';

const CACHE_STORAGE_KEY = 'file-tree-cache:v1';
const CACHE_FRESH_MS = 30_000;
const CACHE_MAX_AGE_MS = 30 * 60_000;
const CACHE_MAX_PROJECTS = 6;
const CACHE_MAX_CHARACTERS = 2_000_000;
const MAX_PARALLEL_REQUESTS = 3;

type DirectoryListing = { children: FileTreeNode[]; updatedAt: number };
type CachedProject = { rootPath: string; directories: [string, DirectoryListing][]; updatedAt: number };
type TreeState = { key: string; files: FileTreeNode[]; loading: boolean; refreshing: boolean; error: string | null };
type UseFileTreeDataResult = Omit<TreeState, 'key'> & { refreshFiles: () => void };

// Metadata only, bounded across projects; file contents never enter this cache.
const projectCache = new Map<string, CachedProject>();
let storageHydrated = false;

function clearCache() {
  projectCache.clear();
  try { sessionStorage.removeItem(CACHE_STORAGE_KEY); } catch { /* Storage may be disabled. */ }
}

// Cache lifetime exceeds a mounted explorer: logout must also clear it while the panel is hidden.
if (typeof window !== 'undefined') {
  window.addEventListener(AUTH_SESSION_CLEARED_EVENT, clearCache);
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, clearCache);
  window.addEventListener('storage', (event) => {
    if (event.key === 'auth-token' && !event.newValue) clearCache();
  });
  window.addEventListener(FILE_TREE_CHANGED_EVENT, (event) => {
    const detail = (event as CustomEvent<{ filePath?: string }>).detail;
    // An editor can save while the explorer is hidden, so invalidation must outlive its hook.
    if (detail?.filePath) invalidateRelatedProjects(cacheScope(), detail.filePath);
  });
}

function cacheScope(): string | null {
  try {
    const token = getStoredAuthToken();
    if (!token) return null;
    const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    const userId = claims.userId ?? claims.sub ?? claims.username;
    return typeof userId === 'string' || typeof userId === 'number' ? String(userId) : null;
  } catch {
    // Unidentified sessions still work, but cannot share or persist private paths.
    return null;
  }
}

function readCache(key: string, scope: string | null): CachedProject | undefined {
  if (!scope) return undefined;
  if (!storageHydrated) {
    storageHydrated = true;
    try {
      const raw = sessionStorage.getItem(CACHE_STORAGE_KEY);
      if (raw && raw.length <= CACHE_MAX_CHARACTERS) {
        const cached = JSON.parse(raw) as [string, CachedProject][];
        if (Array.isArray(cached)) {
          cached.slice(-CACHE_MAX_PROJECTS).forEach(([storedKey, value]) => {
            if (typeof storedKey === 'string' && typeof value?.rootPath === 'string'
              && Array.isArray(value.directories) && value.directories.every((entry) => Array.isArray(entry)
                && typeof entry[0] === 'string' && Array.isArray(entry[1]?.children)
                && Number.isFinite(entry[1]?.updatedAt)) && Number.isFinite(value.updatedAt)) {
              projectCache.set(storedKey, value);
            }
          });
        }
      }
    } catch { clearCache(); }
  }
  const cached = projectCache.get(key);
  if (cached && Date.now() - cached.updatedAt < CACHE_MAX_AGE_MS) {
    projectCache.delete(key);
    projectCache.set(key, cached);
    return cached;
  }
  projectCache.delete(key);
  return undefined;
}

function storeCache(key: string, scope: string | null, cached: CachedProject) {
  if (!scope) return;
  projectCache.delete(key);
  projectCache.set(key, cached);
  while (projectCache.size > CACHE_MAX_PROJECTS) projectCache.delete(projectCache.keys().next().value!);
  let serialized = JSON.stringify([...projectCache]);
  while (serialized.length > CACHE_MAX_CHARACTERS && projectCache.size) {
    projectCache.delete(projectCache.keys().next().value!);
    serialized = JSON.stringify([...projectCache]);
  }
  try { sessionStorage.setItem(CACHE_STORAGE_KEY, serialized); } catch { /* Memory cache remains usable. */ }
}

function pathsOverlap(left: string, right: string): boolean {
  const first = left.replace(/\\/g, '/').replace(/\/+$/, '');
  const second = right.replace(/\\/g, '/').replace(/\/+$/, '');
  return first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}

function invalidateRelatedProjects(scope: string | null, projectPath: string) {
  if (!scope || !projectPath) return;
  projectCache.forEach((cached, storedKey) => {
    if (storedKey.startsWith(`[${JSON.stringify(scope)},`) && pathsOverlap(cached.rootPath, projectPath)) projectCache.delete(storedKey);
  });
  try { sessionStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify([...projectCache])); } catch { /* Optional cache. */ }
}

function buildTree(root: string, directories: Map<string, DirectoryListing>, failures = new Map<string, string>(), visited = new Set<string>()): FileTreeNode[] {
  if (visited.has(root)) return [];
  const listing = directories.get(root);
  if (!listing) return [];
  const nextVisited = new Set(visited).add(root);
  return listing.children.map((node) => {
    if (node.type !== 'directory') return node;
    if (failures.has(node.path)) return { ...node, loadError: failures.get(node.path) };
    return directories.has(node.path) ? { ...node, children: buildTree(node.path, directories, failures, nextVisited) } : node;
  });
}

/** Used by FileTree to show cached projects immediately and preload bounded directory batches. */
export function useFileTreeData(selectedProject: Project | null, expandedDirs?: Set<string>): UseFileTreeDataResult {
  const projectId = selectedProject?.projectId;
  const projectPath = selectedProject?.path || selectedProject?.fullPath || '';
  const scope = cacheScope();
  const key = JSON.stringify([scope, projectId, projectPath]);
  // Tag displayed data with its owner so switching projects cannot flash the previous tree.
  const [state, setState] = useState<TreeState>(() => {
    const cached = readCache(key, scope);
    return { key, files: cached ? buildTree(cached.rootPath, new Map(cached.directories)) : [], loading: Boolean(projectId && !cached), refreshing: false, error: null };
  });
  // A refresh creates a new request generation while leaving the displayed tree usable.
  const [refreshKey, setRefreshKey] = useState(0);
  const generationRef = useRef(0);
  const rootRef = useRef('');
  const directoriesRef = useRef(new Map<string, DirectoryListing>());
  const pendingRef = useRef(new Map<string, AbortController>());
  const failedRef = useRef(new Map<string, string>());
  const forceRefreshRef = useRef(false);
  const rootReadyRef = useRef(false);

  const refreshFiles = useCallback(() => {
    // A nested workspace can also be present inside its parent's cached tree.
    invalidateRelatedProjects(scope, projectPath);
    forceRefreshRef.current = true;
    setRefreshKey((value) => value + 1);
  }, [scope, projectPath]);

  const loadDirectory = useCallback(async (directory: string, generation: number, force = false) => {
    if (!projectId || pendingRef.current.has(directory) || failedRef.current.has(directory)
      || pendingRef.current.size >= MAX_PARALLEL_REQUESTS) return;
    const controller = new AbortController();
    pendingRef.current.set(directory, controller);
    try {
      const response = await api.getFileTreeSnapshot(projectId, { signal: controller.signal }, directory, force);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(readApiErrorMessage(body) || 'Unable to load this folder.');
      }
      const snapshot = await response.json() as FileTreeSnapshot;
      if (controller.signal.aborted || generationRef.current !== generation) return;
      if (!snapshot.directories.some((entry) => entry.path === snapshot.rootPath)) {
        throw new Error('Unable to load this folder.');
      }
      const now = Date.now();
      failedRef.current.delete(directory);
      snapshot.directories.forEach(({ path, children }) => {
        directoriesRef.current.set(path, { children, updatedAt: now });
        failedRef.current.delete(path);
      });
      if (!directory) {
        rootRef.current = snapshot.rootPath;
        rootReadyRef.current = true;
      }
      const files = buildTree(rootRef.current, directoriesRef.current, failedRef.current);
      storeCache(key, scope, {
        rootPath: rootRef.current,
        directories: [...directoriesRef.current],
        updatedAt: directoriesRef.current.get(rootRef.current)?.updatedAt ?? now,
      });
      setState((previous) => ({ ...previous, key, files, error: failedRef.current.values().next().value ?? null }));
    } catch (error) {
      if (controller.signal.aborted || generationRef.current !== generation) return;
      const message = error instanceof Error ? error.message : 'Unable to load this folder.';
      failedRef.current.set(directory, message);
      setState((previous) => ({
        ...previous,
        files: directory ? buildTree(rootRef.current, directoriesRef.current, failedRef.current) : previous.files,
        error: message,
      }));
    } finally {
      if (generationRef.current === generation) {
        pendingRef.current.delete(directory);
        // Updating after releasing the slot lets queued expanded folders run next.
        setState((previous) => ({ ...previous, loading: false, refreshing: pendingRef.current.has('') }));
      }
    }
  }, [projectId, key, scope]);

  useEffect(() => {
    const generation = ++generationRef.current;
    const force = forceRefreshRef.current;
    forceRefreshRef.current = false;
    const cached = readCache(key, scope);
    const fresh = cached && Date.now() - cached.updatedAt < CACHE_FRESH_MS && !force;
    rootReadyRef.current = Boolean(fresh);
    rootRef.current = cached?.rootPath || '';
    directoriesRef.current = fresh ? new Map(cached.directories) : new Map();
    failedRef.current.clear();
    setState((previous) => ({
      key,
      files: cached ? buildTree(cached.rootPath, new Map(cached.directories)) : previous.key === key ? previous.files : [],
      loading: Boolean(projectId && !cached && (previous.key !== key || previous.files.length === 0)),
      refreshing: Boolean(projectId && !fresh),
      error: null,
    }));
    if (projectId && !fresh) void loadDirectory('', generation, force);
    const pending = pendingRef.current;
    return () => {
      generationRef.current += 1;
      pending.forEach((controller) => controller.abort());
      pending.clear();
      // Auth removes its token before unmounting the workspace on logout.
      if (!cacheScope()) clearCache();
    };
  }, [key, scope, projectId, refreshKey, loadDirectory]);

  useEffect(() => {
    if (!rootReadyRef.current) return;
    const visibleDirectories = new Set<string>();
    const collect = (nodes: FileTreeNode[]) => nodes.forEach((node) => {
      if (node.type !== 'directory') return;
      visibleDirectories.add(node.path);
      if (node.children) collect(node.children);
    });
    collect(state.files);
    expandedDirs?.forEach((directory) => {
      const loaded = directoriesRef.current.get(directory);
      if (visibleDirectories.has(directory) && (!loaded || Date.now() - loaded.updatedAt >= CACHE_FRESH_MS)) {
        void loadDirectory(directory, generationRef.current);
      }
    });
  }, [expandedDirs, state, loadDirectory]);

  useEffect(() => {
    const onFocus = () => {
      const root = directoriesRef.current.get(rootRef.current);
      if (root && Date.now() - root.updatedAt >= CACHE_FRESH_MS && !pendingRef.current.has('')) {
        setRefreshKey((value) => value + 1);
      }
    };
    const onFileChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; filePath?: string }>).detail;
      if (detail?.projectId === projectId || (detail?.filePath && pathsOverlap(projectPath, detail.filePath))) refreshFiles();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener(FILE_TREE_CHANGED_EVENT, onFileChanged);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(FILE_TREE_CHANGED_EVENT, onFileChanged);
    };
  }, [projectId, projectPath, scope, refreshFiles]);

  if (state.key !== key) {
    const cached = readCache(key, scope);
    return { files: cached ? buildTree(cached.rootPath, new Map(cached.directories)) : [], loading: Boolean(projectId && !cached), refreshing: false, error: null, refreshFiles };
  }
  return { ...state, refreshFiles };
}
