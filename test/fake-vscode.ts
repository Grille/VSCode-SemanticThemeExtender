// A stand-in for the vscode module, installed before any extension code loads: just enough API for
// the extension, plus a scriptable language server (tokens, symbols, hovers, definitions, type
// hierarchy) over in-memory documents. Import it first in every test file.

import Module = require("module");
import * as path from "path";

export class Position {
  constructor(readonly line: number, readonly character: number) {}
  isBefore(o: Position) {
    return this.line < o.line || (this.line === o.line && this.character < o.character);
  }
  isEqual(o: Position) {
    return this.line === o.line && this.character === o.character;
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    if (typeof a === "number") {
      this.start = new Position(a, b as number);
      this.end = new Position(c!, d!);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
  contains(x: Position | Range): boolean {
    const r = x instanceof Range ? x : new Range(x, x);
    return !r.start.isBefore(this.start) && !this.end.isBefore(r.end);
  }
  isEqual(o: Range) {
    return this.start.isEqual(o.start) && this.end.isEqual(o.end);
  }
}

export class Uri {
  private constructor(readonly scheme: string, readonly path: string) {}
  static parse(s: string) {
    const m = /^([\w-]+):(?:\/\/)?(.*)$/.exec(s);
    return m ? new Uri(m[1], m[2].startsWith("/") ? m[2] : `/${m[2]}`) : new Uri("file", s);
  }
  static file(p: string) {
    return new Uri("file", p.replace(/\\/g, "/"));
  }
  static joinPath(base: Uri, ...parts: string[]) {
    return new Uri(base.scheme, [base.path.replace(/\/$/, ""), ...parts].join("/"));
  }
  get fsPath() {
    return this.path;
  }
  toString() {
    return `${this.scheme}://${this.path}`;
  }
}

const disposable = { dispose() {} };
const event = () => disposable;

/** A document of the fake workspace. */
export interface FakeDoc {
  uri: Uri;
  languageId: string;
  version: number;
  lines: string[];
  getText(r?: Range): string;
  lineAt(l: number): { text: string; lineNumber: number; firstNonWhitespaceCharacterIndex: number };
  positionAt(o: number): Position;
  isDirty: boolean;
}

/** One semantic token: the nth occurrence (from 0) of text on a line, its type and modifiers. */
export interface TokenSpec {
  line: number;
  text: string;
  type: string;
  modifiers?: string[];
  nth?: number;
}

export interface SymbolSpec {
  name: string;
  /** The name as the server reports it, if different: C# adds signatures ("Make() : Point"). */
  label?: string;
  kind: number;
  /** Lines (inclusive) the symbol spans; its name is looked up on nameLine. */
  from: number;
  to: number;
  nameLine: number;
  children?: SymbolSpec[];
}

export interface FileSpec {
  lines: string[];
  language?: string;
  tokens: TokenSpec[];
  symbols?: SymbolSpec[];
  /** Hover Markdown by token text. */
  hovers?: Record<string, string>;
}

const TOKEN_TYPES = ["class", "struct", "interface", "enum", "variable", "property", "method", "function", "parameter", "decorator", "selfParameter"];
const TOKEN_MODIFIERS = ["declaration", "readonly", "static", "classMember", "async"];

export const SymbolKind = { File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13, Struct: 22 };

/** Everything tests set up or inspect; reset() before each test. */
export const world = {
  files: new Map<string, FileSpec>(),
  docs: new Map<string, FakeDoc>(),
  /** Where each type or function is declared, for definitions and the type hierarchy. */
  declared: new Map<string, { uri: string; line: number }>(),
  /** Base types by type name. */
  bases: new Map<string, string[]>(),
  settings: {} as Record<string, any>,
  /** Every decoration a document got: options of the decoration type, then the texts it covers. */
  decorations: new Map<string, Map<string, string[]>>(),
  diagnostics: new Map<string, any[]>(),
  codeActionProviders: [] as any[],
  folders: [] as { uri: Uri; name: string; index: number }[],
  trusted: true,
  requests: { hover: 0, definition: 0, typeHierarchy: 0 },
  output: [] as string[],
};

export function reset() {
  world.files.clear();
  world.docs.clear();
  world.declared.clear();
  world.bases.clear();
  world.settings = { "workbench.colorTheme": "Test Dark" };
  world.decorations.clear();
  server = undefined;
  opener = undefined;
  world.diagnostics.clear();
  world.codeActionProviders = [];
  world.folders = [];
  world.trusted = true;
  world.requests = { hover: 0, definition: 0, typeHierarchy: 0 };
  world.output = [];
  window.visibleTextEditors.length = 0;
}

function makeDoc(uri: Uri, lines: string[], languageId: string): FakeDoc {
  return {
    uri,
    languageId,
    version: 1,
    lines,
    isDirty: false,
    getText(r?: Range) {
      if (!r) return lines.join("\n");
      return lines[r.start.line].slice(r.start.character, r.end.character);
    },
    lineAt(l: number) {
      return { text: lines[l], lineNumber: l, firstNonWhitespaceCharacterIndex: lines[l].search(/\S|$/) };
    },
    positionAt(o: number) {
      return new Position(0, o);
    },
  };
}

function column(spec: { line: number; text: string; nth?: number }, lines: string[]) {
  let at = -1;
  for (let k = 0; k <= (spec.nth ?? 0); k++) at = lines[spec.line].indexOf(spec.text, at + 1);
  if (at < 0) throw new Error(`'${spec.text}' not found on line ${spec.line}: ${lines[spec.line]}`);
  return at;
}

/** Adds a file to the fake workspace and returns its document. */
export function addFile(uri: string, spec: FileSpec): FakeDoc {
  const u = Uri.parse(uri);
  const doc = makeDoc(u, spec.lines, spec.language ?? "python");
  world.files.set(u.toString(), spec);
  world.docs.set(u.toString(), doc);
  return doc;
}

/** Shows a document in an editor, so the decorator draws it. */
export function show(doc: FakeDoc) {
  const key = doc.uri.toString();
  window.visibleTextEditors.push({
    document: doc,
    selection: { active: new Position(0, 0) },
    setDecorations(type: { options: any }, ranges: Range[]) {
      const all = world.decorations.get(key) ?? new Map<string, string[]>();
      world.decorations.set(key, all);
      all.set(JSON.stringify(type.options), ranges.map((r) => `${r.start.line}:${doc.getText(r)}`));
    },
  });
}

/** What a document shows: decoration options (as JSON) mapped to "line:text" of each range, empty ones left out. */
export function drawn(doc: FakeDoc): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of world.decorations.get(doc.uri.toString()) ?? []) if (v.length) out[k] = v;
  return out;
}

function encode(spec: FileSpec): Uint32Array {
  const abs = spec.tokens
    .map((t) => ({ line: t.line, col: column(t, spec.lines), len: t.text.length, type: TOKEN_TYPES.indexOf(t.type), mods: t.modifiers ?? [] }))
    .sort((a, b) => a.line - b.line || a.col - b.col);
  const data: number[] = [];
  let pl = 0;
  let pc = 0;
  for (const t of abs) {
    if (t.type < 0) throw new Error("unknown token type in test");
    const bits = t.mods.reduce((b, m) => b | (1 << TOKEN_MODIFIERS.indexOf(m)), 0);
    data.push(t.line - pl, t.line === pl ? t.col - pc : t.col, t.len, t.type, bits);
    pl = t.line;
    pc = t.col;
  }
  return Uint32Array.from(data);
}

function symbolsOf(spec: FileSpec) {
  const sym = (s: SymbolSpec): any => {
    const at = spec.lines[s.nameLine].indexOf(s.name);
    return {
      name: s.label ?? s.name,
      kind: s.kind,
      range: new Range(s.from, 0, s.to, spec.lines[s.to].length),
      selectionRange: new Range(s.nameLine, at, s.nameLine, at + s.name.length),
      children: (s.children ?? []).map(sym),
    };
  };
  return (spec.symbols ?? []).map(sym);
}

// The word at a position, which is what the fake language server answers about.
function wordAt(uri: Uri, pos: Position) {
  const doc = world.docs.get(uri.toString());
  return doc && /^\w+/.exec(doc.lines[pos.line].slice(pos.character))?.[0];
}

function declarationItem(name: string) {
  const at = world.declared.get(name);
  if (!at) return undefined;
  const lines = world.files.get(at.uri)!.lines;
  const col = lines[at.line].indexOf(name);
  return { name, uri: Uri.parse(at.uri), selectionRange: new Range(at.line, col, at.line, col + name.length) };
}

type Handlers = Record<string, (...args: any[]) => any>;

const scripted: Handlers = {
  "vscode.provideDocumentSemanticTokensLegend": () => ({ tokenTypes: TOKEN_TYPES, tokenModifiers: TOKEN_MODIFIERS }),
  "vscode.provideDocumentSemanticTokens": (uri: Uri) => {
    const spec = world.files.get(uri.toString());
    return spec && { data: encode(spec) };
  },
  "vscode.executeDocumentSymbolProvider": (uri: Uri) => {
    const spec = world.files.get(uri.toString());
    return spec ? symbolsOf(spec) : [];
  },
  "vscode.executeHoverProvider": (uri: Uri, pos: Position) => {
    world.requests.hover++;
    const word = wordAt(uri, pos);
    const md = word && world.files.get(uri.toString())?.hovers?.[word];
    return md ? [{ contents: [{ value: md }] }] : [];
  },
  "vscode.executeDefinitionProvider": (uri: Uri, pos: Position) => {
    world.requests.definition++;
    const word = wordAt(uri, pos);
    const item = word && declarationItem(word);
    return item ? [{ uri: item.uri, range: item.selectionRange }] : [];
  },
  "vscode.prepareTypeHierarchy": (uri: Uri, pos: Position) => {
    world.requests.typeHierarchy++;
    const word = wordAt(uri, pos);
    const item = word && declarationItem(word);
    return item ? [item] : [];
  },
  "vscode.provideSupertypes": (item: { name: string }) => {
    world.requests.typeHierarchy++;
    return (world.bases.get(item.name) ?? []).map(declarationItem).filter(Boolean);
  },
};

// A real language server's answers instead of the scripted ones, and how to open files for it.
let server: Handlers | undefined;
let opener: ((uri: Uri) => FakeDoc | undefined) | undefined;

/** Routes the language server commands to these handlers; documents not added yet come from open(). */
export function useLanguageServer(handlers: Handlers, open: (uri: Uri) => FakeDoc | undefined) {
  server = handlers;
  opener = open;
}

/** A document for a file's text, e.g. one read from disk for a real language server. */
export function addDocument(uri: Uri, text: string, languageId: string): FakeDoc {
  const doc = makeDoc(uri, text.split(/\r?\n/), languageId);
  world.docs.set(uri.toString(), doc);
  return doc;
}

let decorationTypes = 0;

export const window = {
  visibleTextEditors: [] as any[],
  activeTextEditor: undefined as any,
  activeColorTheme: { kind: 2 },
  onDidChangeVisibleTextEditors: event,
  onDidChangeActiveColorTheme: event,
  onDidChangeWindowState: event,
  createTextEditorDecorationType: (options: any) => ({ key: ++decorationTypes, options, dispose() {} }),
  createOutputChannel: () => ({ appendLine: (l: string) => world.output.push(l), show() {}, dispose() {} }),
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showWorkspaceFolderPick: async () => undefined,
  showTextDocument: async () => undefined,
};

const vscode = {
  Position,
  Range,
  Uri,
  SymbolKind,
  EventEmitter: class {
    private listeners: ((e: any) => void)[] = [];
    event = (l: (e: any) => void) => (this.listeners.push(l), disposable);
    fire(e: any) {
      this.listeners.forEach((l) => l(e));
    }
    dispose() {}
  },
  Disposable: class {
    constructor(private readonly f: () => void) {}
    dispose() {
      this.f();
    }
  },
  Diagnostic: class {
    source?: string;
    code?: string;
    constructor(readonly range: Range, readonly message: string, readonly severity: number) {}
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  CodeAction: class {
    diagnostics?: any[];
    edit?: any;
    constructor(readonly title: string, readonly kind: string) {}
  },
  CodeActionKind: { QuickFix: "quickfix" },
  WorkspaceEdit: class {
    inserts: { uri: Uri; at: Position; text: string }[] = [];
    insert(uri: Uri, at: Position, text: string) {
      this.inserts.push({ uri, at, text });
    }
    replace() {}
  },
  MarkdownString: class {
    constructor(public value = "") {}
    appendMarkdown(s: string) {
      this.value += s;
      return this;
    }
  },
  CompletionItem: class {
    constructor(readonly label: string, readonly kind?: number) {}
  },
  CompletionItemKind: {},
  Hover: class {
    constructor(readonly contents: any, readonly range?: Range) {}
  },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  FileType: { File: 1, Directory: 2 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  FileSystemError: { FileNotFound: () => new Error("FileNotFound"), NoPermissions: () => new Error("NoPermissions") },
  ThemeColor: class {
    constructor(readonly id: string) {}
  },
  extensions: {
    all: [] as any[],
    onDidChange: event,
  },
  window,
  workspace: {
    get workspaceFolders() {
      return world.folders;
    },
    get isTrusted() {
      return world.trusted;
    },
    textDocuments: [] as FakeDoc[],
    getConfiguration: (section?: string) => {
      const key = (k: string) => (section ? `${section}.${k}` : k);
      return {
        get: (k: string) => world.settings[key(k)],
        inspect: (k: string) => ({ globalValue: world.settings[key(k)] }),
        update: async (k: string, v: any) => {
          world.settings[key(k)] = v;
        },
      };
    },
    openTextDocument: async (uri: Uri) => {
      const doc = world.docs.get(uri.toString()) ?? opener?.(uri);
      if (!doc) throw new Error(`No such document: ${uri}`);
      return doc;
    },
    getWorkspaceFolder: (uri: Uri) => world.folders.find((f) => uri.toString().startsWith(`${f.uri.toString()}/`)),
    asRelativePath: (uri: Uri) => {
      const f = world.folders.find((f) => uri.toString().startsWith(`${f.uri.toString()}/`));
      return f ? uri.path.slice(f.uri.path.length + 1) : uri.path;
    },
    fs: {
      readFile: async (uri: Uri) => {
        const doc = world.docs.get(uri.toString());
        if (!doc) throw new Error("FileNotFound");
        return Buffer.from(doc.lines.join("\n"));
      },
      writeFile: async () => undefined,
      stat: async () => ({}),
    },
    createFileSystemWatcher: () => ({ onDidChange: event, onDidCreate: event, onDidDelete: event, dispose() {} }),
    registerFileSystemProvider: () => disposable,
    onDidChangeConfiguration: event,
    onDidChangeTextDocument: event,
    onDidOpenTextDocument: event,
    onDidCloseTextDocument: event,
    onDidChangeWorkspaceFolders: event,
    onDidGrantWorkspaceTrust: event,
    applyEdit: async () => true,
  },
  languages: {
    createDiagnosticCollection: () => ({
      set: (uri: Uri, ds: any[]) => world.diagnostics.set(uri.toString(), ds),
      delete: (uri: Uri) => world.diagnostics.delete(uri.toString()),
      clear: () => world.diagnostics.clear(),
      dispose() {},
    }),
    registerCodeActionsProvider: (_selector: unknown, provider: unknown) => (world.codeActionProviders.push(provider), disposable),
    registerHoverProvider: () => disposable,
    registerCompletionItemProvider: () => disposable,
    registerColorProvider: () => disposable,
    setTextDocumentLanguage: async () => undefined,
  },
  commands: {
    executeCommand: async (command: string, ...args: any[]) => (server ?? scripted)[command]?.(...args),
    registerCommand: () => disposable,
  },
};

// Themes, languages and a language server's token types come from small extensions in
// test/fixtures, never from an installed VS Code.
for (const name of ["themes", "language-server"]) {
  addExtension(path.join(__dirname, "..", "..", "test", "fixtures", name));
}

/** Makes an extension's contributions known, e.g. an installed language extension's token types. */
export function addExtension(dir: string) {
  vscode.extensions.all.push({ extensionPath: dir, packageJSON: require(path.join(dir, "package.json")) });
}

const load = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  return request === "vscode" ? vscode : load.call(this, request, ...rest);
};

reset();
