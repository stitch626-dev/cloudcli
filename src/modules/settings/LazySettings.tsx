import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

import type SettingsComponent from '@/modules/settings/Settings';

const SettingsDialog = lazy(() => import('@/modules/settings/Settings'));

/** Used by sidebar to defer settings screens until the user opens the dialog. */
export default function LazySettings(props: ComponentProps<typeof SettingsComponent>) {
  if (!props.isOpen) return null;
  return (
    <Suspense fallback={<div className="fixed inset-0 z-50 animate-pulse bg-background/80" aria-busy="true" />}>
      <SettingsDialog {...props} />
    </Suspense>
  );
}
