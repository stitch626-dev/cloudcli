import { Settings } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { ReleaseInfo } from '@/shared/types';

type SidebarFooterProps = {
  updateAvailable: boolean;
  restartRequired: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  t: TFunction;
};

/** Rendered by SidebarContent to keep workspace settings within reach. */
export default function SidebarFooter({ onShowSettings, t }: SidebarFooterProps) {
  return (
    <div className="shrink-0 border-t border-border/50 p-2" style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom, 0px))' }}>
      <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground" onClick={onShowSettings}>
        <Settings className="h-4 w-4" />
        {t('actions.settings')}
      </button>
    </div>
  );
}
