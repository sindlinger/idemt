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

  monaco.editor.defineTheme("mqlTheme", {
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
      "editorLineNumber.foreground": "#394150",
      "editorGutter.background": "#0e1016"
    }
  });
};
