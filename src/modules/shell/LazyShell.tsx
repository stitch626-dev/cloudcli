import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

import type ShellComponent from '@/modules/shell/Shell';

const Terminal = lazy(() => import('@/modules/shell/Shell'));

/** Used by standalone-shell and task-master to load terminal code only when a terminal is mounted. */
export default function LazyShell(props: ComponentProps<typeof ShellComponent>) {
  return (
    <Suspense fallback={<div className="h-full w-full animate-pulse bg-muted/30" aria-busy="true" />}>
      <Terminal {...props} />
    </Suspense>
  );
}
