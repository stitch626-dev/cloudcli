import { useCallback, useEffect, useRef, useState } from 'react';

import { prepareHtmlPreview } from '@/modules/code-editor/utils/prepareHtmlPreview';

type UseHtmlPreviewDocumentParams = {
  content: string;
  filePath: string;
  fileName: string;
  projectId?: string;
  projectPath?: string;
  enabled: boolean;
};

export function useHtmlPreviewDocument({ content, filePath, fileName, projectId, projectPath, enabled }: UseHtmlPreviewDocumentParams) {
  // Retain the packaged document with its source identity so a late asset fetch
  // can never render the previous file or an earlier edit in the current pane.
  const [prepared, setPrepared] = useState<{ key: string; srcDoc: string; missingResources: number; requiresDevelopmentServer: boolean } | null>(null);
  const popupControllerRef = useRef<AbortController | null>(null);
  const key = JSON.stringify([projectId, projectPath, filePath, content]);

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    void prepareHtmlPreview(content, filePath, projectId, projectPath, controller.signal).then((result) => {
      if (!controller.signal.aborted) setPrepared({ key, ...result });
    }).catch(() => {
      // Cancellation belongs to a previous file or preview mode; it is silent.
    });
    return () => controller.abort();
  }, [content, enabled, filePath, key, projectId, projectPath]);

  useEffect(() => () => popupControllerRef.current?.abort(), [filePath, projectId]);

  const current = prepared?.key === key ? prepared : null;
  const openInNewTab = useCallback(() => {
    // Open synchronously in the click handler so browsers do not block it as a
    // popup after resource loading; user HTML only enters the sandboxed iframe.
    const previewWindow = window.open('', '_blank');
    if (!previewWindow) return;
    previewWindow.opener = null;
    previewWindow.document.title = fileName;
    previewWindow.document.body.style.margin = '0';
    const frame = previewWindow.document.createElement('iframe');
    frame.title = fileName;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:white';
    previewWindow.document.body.appendChild(frame);
    if (current) {
      frame.srcdoc = current.srcDoc;
      return;
    }
    popupControllerRef.current?.abort();
    const controller = new AbortController();
    popupControllerRef.current = controller;
    void prepareHtmlPreview(content, filePath, projectId, projectPath, controller.signal).then((result) => {
      if (!controller.signal.aborted && !previewWindow.closed) frame.srcdoc = result.srcDoc;
    }).catch(() => {
      if (!previewWindow.closed) previewWindow.close();
    });
  }, [content, current, fileName, filePath, projectId, projectPath]);

  return {
    srcDoc: current?.srcDoc,
    missingResources: current?.missingResources ?? 0,
    requiresDevelopmentServer: current?.requiresDevelopmentServer ?? false,
    openInNewTab,
  };
}
