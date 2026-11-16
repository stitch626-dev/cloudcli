import { useCallback, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { FileTree } from '@/modules/file-tree';
import { FolderBrowserModal } from '@/modules/project-creation-wizard';
import { api } from '@/shared/api';
import type { DirectoryRevealRequest, Project } from '@/shared/types';

type WorkspaceExplorerProps = {
  project: Project;
  onFileOpen: (path: string) => void;
  onProjectSelect: (project: Project) => void;
  onProjectsRefresh: () => void;
  revealDirectory: DirectoryRevealRequest | null;
};

/** Used by WorkspaceMain to keep file navigation available alongside chat and terminal. */
export default function WorkspaceExplorer({ project, onFileOpen, onProjectSelect, onProjectsRefresh, revealDirectory }: WorkspaceExplorerProps) {
  const { t } = useTranslation();
  // The folder picker can navigate outside the active project without changing it until selection.
  const [browsing, setBrowsing] = useState(false);
  // Keep folder-switch failures visible without removing the current explorer.
  const [error, setError] = useState<string | null>(null);
  // Disable duplicate selections while the existing project is looked up or registered.
  const [opening, setOpening] = useState(false);

  const openFolder = useCallback(async (folderPath: string) => {
    setBrowsing(false);
    setOpening(true);
    setError(null);
    try {
      const response = await api.projects();
      if (!response.ok) throw new Error('Unable to load projects.');
      const projects = await response.json() as Project[];
      let next = projects.find((candidate) => (candidate.path || candidate.fullPath) === folderPath);
      if (!next) {
        const created = await api.createProject({ path: folderPath });
        const data = await created.json() as { project?: Project; error?: string | { message?: string } };
        if (!created.ok || !data.project) {
          throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || 'Unable to open folder.');
        }
        next = data.project;
        onProjectsRefresh();
      }
      onProjectSelect(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to open folder.');
    } finally {
      setOpening(false);
    }
  }, [onProjectSelect, onProjectsRefresh]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/60 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t('workspaceExplorer.title', 'Explorer')}</span>
          <button disabled={opening} onClick={() => setBrowsing(true)} title={t('workspaceExplorer.openFolder', 'Open folder')} aria-label={t('workspaceExplorer.openFolder', 'Open folder')} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
            <FolderOpen className="h-4 w-4" />
          </button>
        </div>
        <button onClick={() => setBrowsing(true)} className="mt-1 block w-full truncate text-left text-xs text-foreground/80 hover:text-primary" title={project.path || project.fullPath}>
          {project.path || project.fullPath}
        </button>
        {error && <p role="alert" className="mt-2 break-words text-xs text-destructive">{error}</p>}
      </div>
      <div className="min-h-0 flex-1">
        <FileTree key={project.projectId} selectedProject={project} onFileOpen={onFileOpen} revealDirectory={revealDirectory} />
      </div>
      <FolderBrowserModal isOpen={browsing} initialPath={project.path || project.fullPath} autoAdvanceOnSelect={false} onClose={() => setBrowsing(false)} onFolderSelected={(path) => { void openFolder(path); }} />
    </div>
  );
}
