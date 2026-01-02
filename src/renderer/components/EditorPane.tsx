import { useEffect, useRef } from "react";
import MonacoEditor from "@monaco-editor/react";
import type * as monacoType from "monaco-editor";
import type { OpenFileState, ReviewChange } from "@state/store";
import { setupMqlLanguage } from "../monaco/mql";

export type EditorPaneProps = {
  files: OpenFileState[];
  activeFilePath?: string;
  reviewChange?: ReviewChange;
  onSelectTab: (path: string) => void;
  onChangeContent: (path: string, value: string) => void;
  onSelectionChange?: (selection: string) => void;
  navigationTarget?: { path: string; line: number; column: number } | null;
  onNavigationHandled: () => void;
};

const EditorPane = ({
  files,
  activeFilePath,
  reviewChange,
  onSelectTab,
  onChangeContent,
  onSelectionChange,
  navigationTarget,
  onNavigationHandled
}: EditorPaneProps) => {
  const editorRef = useRef<monacoType.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monacoType | null>(null);
  const decorationsRef = useRef<string[]>([]);

  const activeFile = files.find((file) => file.path === activeFilePath);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!reviewChange) {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
      return;
    }
    const monaco = monacoRef.current;
    if (!monaco) return;
    const decorations = reviewChange.changedLines.map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: "line-highlight",
        marginClassName: "line-highlight-margin"
      }
    }));
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, decorations);
  }, [reviewChange]);

  useEffect(() => {
    if (!navigationTarget) return;
    if (navigationTarget.path !== activeFilePath) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(navigationTarget.line);
    editor.setPosition({ lineNumber: navigationTarget.line, column: navigationTarget.column });
    editor.focus();
    onNavigationHandled();
  }, [navigationTarget, activeFilePath, onNavigationHandled]);

  return (
    <div className="editor-area">
      <div className="tabs">
        {files.map((file) => (
          <div
            key={file.path}
            className={`tab ${file.path === activeFilePath ? "active" : ""}`}
            onClick={() => onSelectTab(file.path)}
          >
            <span>{file.path.split(/[\\/]/).pop()}</span>
            {file.dirty ? <span className="dirty" /> : null}
          </div>
        ))}
      </div>
      <div className="editor-wrapper">
        {activeFile ? (
          <MonacoEditor
            path={activeFile.path}
            language={activeFile.language}
            value={activeFile.content}
            theme="mqlTheme"
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              wordWrap: "on",
              automaticLayout: true
            }}
            onMount={(editor, monaco) => {
              editorRef.current = editor;
              monacoRef.current = monaco;
              setupMqlLanguage(monaco);
              monaco.editor.setTheme("mqlTheme");
              editor.onDidChangeCursorSelection(() => {
                if (!onSelectionChange) return;
                const range = editor.getSelection();
                if (!range) return;
                const selection = editor.getModel()?.getValueInRange(range);
                onSelectionChange(selection ?? "");
              });
            }}
            onChange={(value) => {
              if (value !== undefined && activeFilePath) {
                onChangeContent(activeFilePath, value);
              }
            }}
          />
        ) : (
          <div style={{ padding: 20, color: "var(--muted)" }}>Open a file to start editing.</div>
        )}
      </div>
    </div>
  );
};

export default EditorPane;
