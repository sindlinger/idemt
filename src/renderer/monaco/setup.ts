declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (moduleId: string, label: string) => Worker;
    };
  }
}

window.MonacoEnvironment = {
  getWorker() {
    return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker?worker", import.meta.url), {
      type: "module"
    });
  }
};
