"use strict";
/**
 * A deliberately faithful-enough stand-in for the extension host API surface.
 *
 * Anything the extension touches behaves for real rather than as a no-op, so a
 * failure here is a failure in the extension and not an artefact of the mock.
 * Event listeners are captured and re-firable, and the Call Hierarchy commands
 * are backed by a fixture table, which is what lets the headless suite exercise
 * the interprocedural engine and the context-key logic that gates the menus.
 */
class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
class Range {
  constructor(a, b, c, d) {
    if (typeof a === "object") {
      this.start = a;
      this.end = b;
    } else {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    }
  }
}
class Uri {
  constructor(v) {
    this.value = v;
    this.scheme = "file";
    this.path = v;
    this.fsPath = v;
  }
  static parse(v) {
    return new Uri(v);
  }
  static file(v) {
    return new Uri(v);
  }
  toString() {
    return this.value;
  }
}
class Location {
  constructor(uri, range) {
    this.uri = uri;
    this.range = range;
  }
}
class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}
class Diagnostic {
  constructor(range, message, severity) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}
class DiagnosticRelatedInformation {
  constructor(location, message) {
    this.location = location;
    this.message = message;
  }
}
class MarkdownString {
  constructor(value) {
    this.value = value || "";
  }
  appendMarkdown(v) {
    this.value += v;
    return this;
  }
}
class TreeItem {
  constructor(label, state) {
    this.label = label;
    this.collapsibleState = state;
  }
}
class Disposable {
  constructor(fn) {
    this._fn = fn;
  }
  dispose() {
    if (this._fn) this._fn();
  }
  static from(...d) {
    return new Disposable(() => d.forEach((x) => x.dispose && x.dispose()));
  }
}
class EventEmitter {
  constructor() {
    this._ls = [];
  }
  get event() {
    return (l) => {
      this._ls.push(l);
      return new Disposable(() => {
        const i = this._ls.indexOf(l);
        if (i >= 0) this._ls.splice(i, 1);
      });
    };
  }
  fire(v) {
    this._ls.slice().forEach((l) => l(v));
  }
  dispose() {
    this._ls.length = 0;
  }
}
class CancellationTokenSource {
  constructor() {
    this._e = new EventEmitter();
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: this._e.event,
    };
  }
  cancel() {
    this.token.isCancellationRequested = true;
    this._e.fire();
  }
  dispose() {
    this._e.dispose();
  }
}

const state = {
  commands: new Map(),
  contextKeys: new Map(),
  treeViews: [],
  documents: new Map(),
  messages: [],
  /** every executeCommand call, so tests can assert on built-ins we invoke */
  executed: [],
  /** listeners captured so tests can drive the editor lifecycle */
  activeEditorListeners: [],
  selectionListeners: [],
  /** uri string -> [{ fromUri, range }] used by the Call Hierarchy commands */
  incomingCalls: new Map(),
  quickPickAnswer: undefined,
  /** section.key -> value, so tests can flip settings on. */
  config: new Map(),
  diagnostics: new Map(),
  inputBoxAnswer: undefined,
};

const commands = {
  registerCommand(id, fn) {
    state.commands.set(id, fn);
    return new Disposable(() => state.commands.delete(id));
  },
  async executeCommand(id, ...args) {
    state.executed.push({ id, args });
    if (id === "setContext") {
      state.contextKeys.set(args[0], args[1]);
      return undefined;
    }

    // Minimal Call Hierarchy so the core's interprocedural engine can run.
    if (id === "vscode.prepareCallHierarchy") {
      const uri = args[0];
      return state.incomingCalls.has(uri.toString())
        ? [{ uri, name: "item", range: new Range(0, 0, 0, 1) }]
        : [];
    }
    if (id === "vscode.provideIncomingCalls") {
      const item = args[0];
      const entries = state.incomingCalls.get(item.uri.toString()) || [];
      return entries.map((e) => ({
        from: { uri: e.fromUri, name: "caller", range: e.range },
        fromRanges: [e.range],
      }));
    }

    const fn = state.commands.get(id);
    if (fn) return fn(...args);
    return undefined; // vscode.open, showReferences, etc.
  },
  async getCommands() {
    return [...state.commands.keys()];
  },
};

const window = {
  activeTextEditor: undefined,
  createTreeView(id, opts) {
    const v = {
      id,
      opts,
      treeDataProvider: opts && opts.treeDataProvider,
      dispose() {},
    };
    state.treeViews.push(v);
    return v;
  },
  registerTreeDataProvider() {
    return new Disposable(() => {});
  },
  onDidChangeActiveTextEditor(l) {
    state.activeEditorListeners.push(l);
    return new Disposable(() => {});
  },
  onDidChangeTextEditorSelection(l) {
    state.selectionListeners.push(l);
    return new Disposable(() => {});
  },
  async withProgress(_opts, task) {
    return task({ report() {} }, new CancellationTokenSource().token);
  },
  showInformationMessage(m) {
    state.messages.push(["info", m]);
    return Promise.resolve(undefined);
  },
  showWarningMessage(m) {
    state.messages.push(["warn", m]);
    return Promise.resolve(undefined);
  },
  showErrorMessage(m) {
    state.messages.push(["error", m]);
    return Promise.resolve(undefined);
  },
  showQuickPick() {
    return Promise.resolve(state.quickPickAnswer);
  },
  showInputBox() {
    return Promise.resolve(state.inputBoxAnswer);
  },
  createStatusBarItem() {
    return { show() {}, hide() {}, dispose() {} };
  },
};

const workspace = {
  workspaceFolders: [{ uri: Uri.parse("file:///"), name: "root", index: 0 }],
  /** file:// URIs count as workspace code; anything else reads as a library. */
  getWorkspaceFolder(uri) {
    return String(uri).startsWith("file://")
      ? workspace.workspaceFolders[0]
      : undefined;
  },
  getConfiguration(section) {
    return {
      get: (key, fallback) => {
        const v = state.config.get(section ? `${section}.${key}` : key);
        return v === undefined ? fallback : v;
      },
    };
  },
  async openTextDocument(uri) {
    const key = typeof uri === "string" ? uri : uri.toString();
    const doc = state.documents.get(key);
    if (!doc) throw new Error("no mock document for " + key);
    return doc;
  },
  onDidChangeTextDocument() {
    return new Disposable(() => {});
  },
};

const extensions = {
  all: [],
  getExtension() {
    return undefined;
  },
};

const languages = {
  createDiagnosticCollection(name) {
    const store = state.diagnostics;
    return {
      name,
      set(uri, diags) {
        store.set(String(uri), diags);
      },
      delete(uri) {
        store.delete(String(uri));
      },
      clear() {
        store.clear();
      },
      dispose() {
        store.clear();
      },
    };
  },
};

/** Build a minimal TextDocument backed by a string. */
function makeDocument(uriString, text, languageId) {
  const uri = Uri.parse(uriString);
  const doc = {
    uri,
    languageId: languageId || "plaintext",
    version: 1,
    getText: () => text,
    offsetAt: (p) => {
      const lines = text.split("\n");
      let o = 0;
      for (let i = 0; i < p.line && i < lines.length; i++)
        o += lines[i].length + 1;
      return o + p.character;
    },
    positionAt: (offset) => {
      const before = text.slice(0, offset).split("\n");
      return new Position(before.length - 1, before[before.length - 1].length);
    },
    lineAt: (line) => ({ range: new Range(line, 0, line, 0) }),
  };
  state.documents.set(uriString, doc);
  return doc;
}

/** Drive the editor lifecycle so context-key logic runs. */
async function setActiveEditor(document, line) {
  const editor = {
    document,
    selection: { active: new Position(line || 0, 0) },
  };
  window.activeTextEditor = editor;
  for (const l of state.activeEditorListeners) await l(editor);
  for (const l of state.selectionListeners) await l({ textEditor: editor });
  return editor;
}

const env = {
  clipboard: {
    text: "",
    async writeText(t) {
      env.clipboard.text = t;
    },
    async readText() {
      return env.clipboard.text;
    },
  },
};

module.exports = {
  Position,
  Range,
  Uri,
  Location,
  ThemeIcon,
  TreeItem,
  Disposable,
  EventEmitter,
  MarkdownString,
  CancellationTokenSource,
  env,
  languages,
  Diagnostic,
  DiagnosticRelatedInformation,
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ProgressLocation: { Notification: 15, Window: 10 },
  commands,
  window,
  workspace,
  extensions,
  __state: state,
  __makeDocument: makeDocument,
  __setActiveEditor: setActiveEditor,
};
