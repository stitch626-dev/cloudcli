import { Settings, PanelLeftOpen } from 'lucide-react';
import type { TFunction } from 'i18next';

type SidebarCollapsedProps = {
  onExpand: () => void;
  onShowSettings: () => void;
  updateAvailable: boolean;
  restartRequired: boolean;
  onShowVersionModal: () => void;
  t: TFunction;
};

/** Rendered by Sidebar for compact workspace navigation and settings. */
export default function SidebarCollapsed({ onExpand, onShowSettings, t }: SidebarCollapsedProps) {
  return (
    <div className="flex h-full w-12 flex-col items-center gap-2 bg-background/80 py-3">
      <button onClick={onExpand} className="rounded-lg p-2 hover:bg-accent" aria-label={t('common:versionUpdate.ariaLabels.showSidebar')}>
        <PanelLeftOpen className="h-4 w-4 text-muted-foreground" />
      </button>
      <button onClick={onShowSettings} className="mt-auto rounded-lg p-2 hover:bg-accent" aria-label={t('actions.settings')}>
        <Settings className="h-4 w-4 text-muted-foreground" />
      </button>
    </div>
  );
}
