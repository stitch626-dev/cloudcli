import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

import type PrdEditorComponent from '@/modules/prd-editor/PRDEditor';

const Editor = lazy(() => import('@/modules/prd-editor/PRDEditor'));

/** Used by task-master to defer the document editor until a PRD is opened. */
export default function LazyPrdEditor(props: ComponentProps<typeof PrdEditorComponent>) {
  return (
    <Suspense fallback={<div className="fixed inset-0 z-50 animate-pulse bg-background/80" aria-busy="true" />}>
      <Editor {...props} />
    </Suspense>
  );
}
