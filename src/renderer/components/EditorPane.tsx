import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import iconMql from "../assets/icons/mql.svg";
import iconPython from "../assets/icons/python.svg";
import iconC from "../assets/icons/c.svg";
import iconCpp from "../assets/icons/cpp.svg";
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
  uiTheme?: "windows11" | "windowsClassic" | "macos";
  uiMode?: "dark" | "light";
  editorFontSize?: number;
  editorShowRulers?: boolean;
  editorRulers?: number[];
  editorShowCursorPosition?: boolean;
  onFontSizeChange?: (size: number) => void;
  onNewFile?: () => void;
  newFileExtension?: string;
  onNewFileExtensionChange?: (value: string) => void;
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
  editorShowCursorPosition,
  onFontSizeChange,
  onNewFile,
  newFileExtension,
  onNewFileExtensionChange
}: EditorPaneProps) => {
  const editorRef = useRef<monacoType.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monacoType | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const extMenuRef = useRef<HTMLDivElement | null>(null);
  const [cursorPos, setCursorPos] = useState({ line: 1, column: 1 });
  const [extMenuOpen, setExtMenuOpen] = useState(false);

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

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (!extMenuRef.current) return;
      if (!extMenuRef.current.contains(event.target as Node)) {
        setExtMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const themeName = getMqlThemeName({ uiTheme, uiMode });
  const fontFamily = getEditorFont({ uiTheme });
  const fontSize = getEditorFontSize({ uiTheme, editorFontSize });
  const rulers = editorShowRulers ? editorRulers ?? [80, 120] : [];

  const extensionOptions = [
    { id: "mq5", label: "MQL5", icon: iconMql },
    { id: "mq4", label: "MQL4", icon: iconMql },
    { id: "mqh", label: "MQL Header", icon: iconMql },
    { id: "py", label: "Python", icon: iconPython },
    { id: "c", label: "C", icon: iconC },
    { id: "cpp", label: "C++", icon: iconCpp }
  ];
  const currentExt =
    extensionOptions.find((option) => option.id === newFileExtension) ?? extensionOptions[0];

  return (
    <div className="editor-area">
      <div className="tabs">
        <div className="tab-actions">
          <button
            className="editor-plus"
            onClick={() => onNewFile?.()}
            title="New File"
            type="button"
          >
            <Plus size={12} />
          </button>
        </div>
        <div className="tab-list">
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
        <div className="tab-right">
          <div className="ext-dropdown" ref={extMenuRef}>
            <button
              className="ext-trigger"
              onClick={() => setExtMenuOpen((open) => !open)}
              type="button"
              title={`New file extension: .${currentExt.id}`}
            >
              <span className="ext-icon">
                <img className="ext-icon-img" src={currentExt.icon} alt={currentExt.label} />
              </span>
            </button>
            {extMenuOpen ? (
              <div className="ext-menu">
                {extensionOptions.map((option) => (
                  <button
                    key={option.id}
                    className={`ext-option ${
                      newFileExtension === option.id ? "active" : ""
                    }`}
                    onClick={() => {
                      onNewFileExtensionChange?.(option.id);
                      setExtMenuOpen(false);
                    }}
                    type="button"
                  >
                    <span className="ext-icon">
                      <img className="ext-icon-img" src={option.icon} alt={option.label} />
                    </span>
                    <span className="ext-label">{option.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
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
              scrollbar: {
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8,
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
                setCursorPos({
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
      {editorShowCursorPosition ? (
        <div className="editor-statusbar">
          <span>
            Ln {cursorPos.line}, Col {cursorPos.column}
          </span>
        </div>
      ) : null}
    </div>
  );
};

export default EditorPane;
