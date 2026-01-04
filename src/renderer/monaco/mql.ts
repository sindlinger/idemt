import type * as monacoType from "monaco-editor";

const KEYWORDS = [
  "input",
  "extern",
  "const",
  "void",
  "int",
  "double",
  "float",
  "string",
  "bool",
  "datetime",
  "color",
  "struct",
  "class",
  "enum",
  "if",
  "else",
  "switch",
  "case",
  "default",
  "for",
  "while",
  "do",
  "return",
  "break",
  "continue",
  "new",
  "delete",
  "this",
  "true",
  "false",
  "NULL",
  "OnInit",
  "OnTick",
  "OnDeinit",
  "OnCalculate",
  "OnTimer"
];

export const setupMqlLanguage = (monaco: typeof monacoType) => {
  monaco.languages.register({
    id: "mql",
    extensions: [".mq4", ".mq5", ".mqh"],
    aliases: ["MQL", "mql"]
  });

  monaco.languages.setMonarchTokensProvider("mql", {
    keywords: KEYWORDS,
    tokenizer: {
      root: [
        [/\b\w+\b/, {
          cases: {
            "@keywords": "keyword",
            "@default": "identifier"
          }
        }],
        [/[{}()\[\]]/, "delimiter"],
        [/\d*\.?\d+([eE][+-]?\d+)?/, "number"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"]
      ],
      comment: [
        [/[^\/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/\//, "comment"]
      ]
    }
  });

  monaco.editor.defineTheme("mqlDark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "4dd4ff" },
      { token: "number", foreground: "f5d76e" },
      { token: "string", foreground: "f58b7a" },
      { token: "comment", foreground: "6b7280", fontStyle: "italic" }
    ],
    colors: {
      "editor.background": "#0e1016",
      "editor.lineHighlightBackground": "#131a24",
      "editorLineNumber.foreground": "#394150",
      "editorGutter.background": "#0e1016",
      "editorIndentGuide.background": "#1f2937",
      "editorCursor.foreground": "#f5f6fa"
    }
  });

  monaco.editor.defineTheme("mqlLight", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "1f86ff" },
      { token: "number", foreground: "c58f1d" },
      { token: "string", foreground: "d9534f" },
      { token: "comment", foreground: "6b7280", fontStyle: "italic" }
    ],
    colors: {
      "editor.background": "#f8fafc",
      "editor.lineHighlightBackground": "#eef2f7",
      "editorLineNumber.foreground": "#6b7280",
      "editorGutter.background": "#f1f5f9",
      "editorIndentGuide.background": "#d6dbe6",
      "editorCursor.foreground": "#1e2431"
    }
  });

  monaco.editor.defineTheme("mqlClassic", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "1a3a75" },
      { token: "number", foreground: "9a6b00" },
      { token: "string", foreground: "7a2b26" },
      { token: "comment", foreground: "4b4b4b", fontStyle: "italic" }
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.lineHighlightBackground": "#e1e1e1",
      "editorLineNumber.foreground": "#2d2d2d",
      "editorGutter.background": "#e1e1e1",
      "editorIndentGuide.background": "#8b8b8b",
      "editor.selectionBackground": "#c0c0c0",
      "editorCursor.foreground": "#111111"
    }
  });

  monaco.editor.defineTheme("mqlMetaTrader", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "7ad7a6" },
      { token: "number", foreground: "f0c36b" },
      { token: "string", foreground: "f29b8b" },
      { token: "comment", foreground: "6c788a", fontStyle: "italic" }
    ],
    colors: {
      "editor.background": "#0f141c",
      "editor.lineHighlightBackground": "#14202b",
      "editorLineNumber.foreground": "#4a5566",
      "editorGutter.background": "#0f141c",
      "editorIndentGuide.background": "#223042",
      "editor.selectionBackground": "#21404a",
      "editorCursor.foreground": "#e6ebf5"
    }
  });
};

export const getMqlThemeName = (options: {
  uiTheme?: "windows11" | "windowsClassic" | "macos" | "metatrader";
  uiMode?: "dark" | "light";
}) => {
  if (options.uiTheme === "metatrader") return "mqlMetaTrader";
  if (options.uiTheme === "windowsClassic") return "mqlClassic";
  if (options.uiMode === "light") return "mqlLight";
  return "mqlDark";
};

export const getEditorFont = (options: {
  uiTheme?: "windows11" | "windowsClassic" | "macos" | "metatrader";
}) => {
  if (options.uiTheme === "macos") {
    return 'SF Mono, Menlo, Monaco, "Courier New", monospace';
  }
  if (options.uiTheme === "windowsClassic") {
    return '"Courier New", "MS Sans Serif", monospace';
  }
  return '"Cascadia Code", "JetBrains Mono", "Fira Code", monospace';
};

export const getEditorFontSize = (options: {
  uiTheme?: "windows11" | "windowsClassic" | "macos" | "metatrader";
  editorFontSize?: number;
}) => {
  if (options.editorFontSize) return options.editorFontSize;
  if (options.uiTheme === "windowsClassic") return 12;
  if (options.uiTheme === "macos") return 13;
  if (options.uiTheme === "metatrader") return 13;
  return 13;
};
