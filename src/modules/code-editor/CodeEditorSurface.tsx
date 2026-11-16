import { useEffect, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import type { Extension } from '@codemirror/state';

import type { CodeEditorGotoTarget } from '@/shared/types';
import MarkdownPreview from '@/modules/code-editor/markdown/MarkdownPreview';

type CodeEditorSurfaceProps = {
  content: string;
  onChange: (value: string) => void;
  previewEnabled: boolean;
  isHtmlFile?: boolean;
  htmlSrcDoc?: string;
  htmlTitle?: string;
  htmlMissingResources?: number;
  htmlRequiresDevelopmentServer?: boolean;
  previewLoadingLabel?: string;
  previewResourceWarning?: string;
  previewDevelopmentServerWarning?: string;
  isMarkdownFile: boolean;
  isDarkMode: boolean;
  fontSize: number;
  showLineNumbers: boolean;
  extensions: Extension[];
  // Line to reveal once the document is loaded (`path:line` references).
  gotoTarget?: CodeEditorGotoTarget | null;
};

/** Rendered by CodeEditor inside the code-editor module to show either the CodeMirror editing surface or the Markdown/HTML preview. */
export default function CodeEditorSurface({
  content,
  onChange,
  previewEnabled,
  isHtmlFile = false,
  htmlSrcDoc,
  htmlTitle,
  htmlMissingResources = 0,
  htmlRequiresDevelopmentServer = false,
  previewLoadingLabel,
  previewResourceWarning,
  previewDevelopmentServerWarning,
  isMarkdownFile,
  isDarkMode,
  fontSize,
  showLineNumbers,
  extensions,
  gotoTarget = null,
}: CodeEditorSurfaceProps) {
  // Tracked as state, not a ref: the editor view is created after the first
  // render, and a ref would not re-run the effect once it lands.
  const [view, setView] = useState<EditorView | null>(null);

  // The last request already jumped to. `content` is the editor's own state and
  // changes on every keystroke, so without this the caret would be dragged back
  // to the requested line while the file is being edited.
  const jumpedToRef = useRef<CodeEditorGotoTarget | null>(null);

  // Content arrives asynchronously, so the jump waits for both the view and the
  // document; each request is then applied exactly once.
  useEffect(() => {
    if (!view || !gotoTarget || !content || jumpedToRef.current === gotoTarget) {
      return;
    }
    jumpedToRef.current = gotoTarget;
    const target = Math.min(Math.max(gotoTarget.line, 1), view.state.doc.lines);
    const line = view.state.doc.line(target);
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
  }, [view, gotoTarget, content]);

  if (previewEnabled && isMarkdownFile) {
    return (
      <div className="h-full overflow-y-auto bg-white dark:bg-gray-900">
        <div className="prose prose-sm mx-auto max-w-4xl px-8 py-6 dark:prose-invert prose-headings:font-semibold prose-a:text-blue-600 prose-code:text-sm prose-pre:bg-gray-900 prose-img:rounded-lg dark:prose-a:text-blue-400">
          <MarkdownPreview content={content} />
        </div>
      </div>
    );
  }

  if (previewEnabled && isHtmlFile) {
    return (
      <div className="flex h-full flex-col bg-white">
        {(htmlRequiresDevelopmentServer || htmlMissingResources > 0) && (
          <div role="status" className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
            {htmlRequiresDevelopmentServer ? previewDevelopmentServerWarning : previewResourceWarning}
          </div>
        )}
        {htmlSrcDoc === undefined ? (
          <div role="status" className="p-4 text-sm text-gray-500">{previewLoadingLabel}</div>
        ) : (
          <iframe
            title={htmlTitle}
            srcDoc={htmlSrcDoc}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="h-full min-h-0 w-full flex-1 border-0 bg-white"
          />
        )}
      </div>
    );
  }

  return (
    <CodeMirror
      onCreateEditor={setView}
      value={content}
      onChange={onChange}
      extensions={extensions}
      theme={isDarkMode ? oneDark : undefined}
      height="100%"
      style={{
        fontSize: `${fontSize}px`,
        height: '100%',
      }}
      basicSetup={{
        lineNumbers: showLineNumbers,
        foldGutter: true,
        dropCursor: false,
        allowMultipleSelections: false,
        indentOnInput: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: true,
        highlightSelectionMatches: true,
        searchKeymap: true,
      }}
    />
  );
}
