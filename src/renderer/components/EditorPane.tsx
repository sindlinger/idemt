import { useEffect, useRef } from "react";
import "../monaco/setup";
import MonacoEditor from "@monaco-editor/react";
import type * as monacoType from "monaco-editor";
import type { OpenFileState, ReviewChange } from "@state/store";
import {
  getEditorFont,
  getEditorFontSize,
  getMqlThemeName,
  setupMqlLanguage
} from "../monaco/mql";

export type EditorPaneProps = {
  files: OpenFileState[];
  activeFilePath?: string;
  reviewChange?: ReviewChange;
  onSelectTab: (path: string) => void;
  onChangeContent: (path: string, value: string) => void;
  onSelectionChange?: (selection: string) => void;
  navigationTarget?: { path: string; line: number; column: number } | null;
  onNavigationHandled: () => void;
  uiTheme?: "windows11" | "windowsClassic" | "macos" | "metatrader";
  uiMode?: "dark" | "light";
  editorFontSize?: number;
  editorShowRulers?: boolean;
  editorRulers?: number[];
  onFontSizeChange?: (size: number) => void;
  onCursorPositionChange?: (pos: { line: number; column: number }) => void;
};

const EditorPane = ({
  files,
  activeFilePath,
  reviewChange,
  onSelectTab,
  onChangeContent,
  onSelectionChange,
  navigationTarget,
  onNavigationHandled,
  uiTheme,
  uiMode,
  editorFontSize,
  editorShowRulers,
  editorRulers,
  onFontSizeChange,
  onCursorPositionChange,
}: EditorPaneProps) => {
  const editorRef = useRef<monacoType.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monacoType | null>(null);
  const decorationsRef = useRef<string[]>([]);

  const activeFile = files.find((file) => file.path === activeFilePath);

  useEffect(() => {
    if (!activeFilePath && files.length > 0) {
      onSelectTab(files[0].path);
    }
  }, [activeFilePath, files, onSelectTab]);

  useEffect(() => {
    if (!activeFile) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
  }, [activeFile]);

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

  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    const theme = getMqlThemeName({ uiTheme, uiMode });
    monaco.editor.setTheme(theme);
  }, [uiTheme, uiMode]);

  const themeName = getMqlThemeName({ uiTheme, uiMode });
  const fontFamily = getEditorFont({ uiTheme });
  const fontSize = getEditorFontSize({ uiTheme, editorFontSize });
  const rulers = editorShowRulers ? editorRulers ?? [80, 120] : [];

  return (
    <div className="editor-area">
      <div className="editor-wrapper">
        {activeFile ? (
          <MonacoEditor
            path={activeFile.path}
            language={activeFile.language}
            value={activeFile.content}
            theme={themeName}
            options={{
              fontSize,
              fontFamily,
              minimap: { enabled: false },
              wordWrap: "on",
              lineNumbers: "on",
              lineNumbersMinChars: 3,
              lineDecorationsWidth: 6,
              glyphMargin: false,
              scrollbar: {
                verticalScrollbarSize: 6,
                horizontalScrollbarSize: 6,
                useShadows: false
              },
              mouseWheelZoom: true,
              rulers,
              automaticLayout: true
            }}
            onMount={(editor, monaco) => {
              editorRef.current = editor;
              monacoRef.current = monaco;
              setupMqlLanguage(monaco);
              monaco.editor.setTheme(themeName);
              editor.onDidChangeCursorPosition((event) => {
                onCursorPositionChange?.({
                  line: event.position.lineNumber,
                  column: event.position.column
                });
              });
              editor.onDidChangeCursorSelection(() => {
                if (!onSelectionChange) return;
                const range = editor.getSelection();
                if (!range) return;
                const selection = editor.getModel()?.getValueInRange(range);
                onSelectionChange(selection ?? "");
              });
              editor.onDidChangeConfiguration((event) => {
                if (!onFontSizeChange || !monacoRef.current) return;
                if (event.hasChanged(monaco.editor.EditorOption.fontSize)) {
                  const nextSize = editor.getOption(monaco.editor.EditorOption.fontSize);
                  onFontSizeChange(nextSize);
                }
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
