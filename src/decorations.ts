// Rules whose head is more than a plain selector (text("__slots__") variable.classMember,
// contains(...) class, within(...), inherits(...), !, ...) are drawn over the language server's
// semantic tokens. VS Code uses a single semantic token provider per document, so instead of
// providing tokens this reads the existing ones, plus document symbols and the type hierarchy
// where a rule needs them, and draws editor decorations over matches. Rules from a project's rules
// file only apply to documents inside that workspace folder, and to library files they reach
// (a base type in builtins.pyi).
//
// Custom modifiers (head += slotted) are given to a document's tokens first, rule by rule in file
// order (global rules, then the project's), so later heads and every drawn rule can select them.
// In a document on screen, a token whose definition is in another workspace file also takes over
// the custom modifiers that definition got there, and contains() is answered for it there.
// doc() matches the prose of a token's hover, signature() its code blocks; hovers are asked for in
// that same second pass. from() asks where names are defined (go to definition), right away like
// inherits(), for the tokens the rest of the rule lets through.

import { AsyncLocalStorage } from "async_hooks";
import * as vscode from "vscode";
import { conditionText, fileMatcher, patternToRegExp, TokenCondition } from "./cfg";
import { MessageRule, StyleValue, TagRule, TextRule } from "./engine";
import { featureOf, serversFor, Support, unsupportedText } from "./support";
import { parseSelector, TokenRegistry } from "./theme";

// Redraw this long after an edit; a document that just came into view is drawn right away.
const REFRESH_MS = 400;
// A language server may not have tokens right after a file opens; ask again a few times.
const RETRY_MS = 1500;
const RETRIES = 4;
// inherits(): how far up the type hierarchy to look, and how many types per file to ask about.
const MAX_DEPTH = 12;
const MAX_TYPES = 300;
// Definitions asked for per document, to carry custom modifiers over from other files.
const MAX_REFS = 300;
// Language server requests sent at once.
const PARALLEL = 16;
// Token types that can name a type with a hierarchy.
const TYPE_TOKENS = ["class", "struct", "interface", "enum", "type"];

interface Matcher {
  type: string;
  modifiers: string[];
  language?: string;
}

/** A condition ready to evaluate: texts as regular expressions, selectors parsed. */
type Condition =
  | { kind: "language" | "server"; ids: string[] }
  /** Several patterns mean any of them. */
  | { kind: "text" | "doc" | "signature"; tests: RegExp[] }
  /** Tests for the path of the file a name is defined in. */
  | { kind: "from"; files: ((path: string) => boolean)[] }
  | { kind: "selector"; matcher: Matcher }
  | { kind: "contains" | "within" | "inherits" | "decorated"; inner: Condition }
  | { kind: "not"; operand: Condition }
  | { kind: "and" | "or"; left: Condition; right: Condition }
  /** What language() and server() fold to in a given document. */
  | { kind: "const"; value: boolean };

/** Switches for measuring: test/servers/benchmark.ts compares with folding off. */
export const tuning = { fold: true };

const TRUE: Condition = { kind: "const", value: true };
const FALSE: Condition = { kind: "const", value: false };

/**
 * c with what's fixed for a document decided: its language and its servers. In a Python file
 * language(csharp) & inherits(...) is false and never prepared (no type hierarchy requests), and
 * language(python) & text("foo") is text("foo"). Parts that don't change stay the same objects,
 * so answers cached by condition are shared.
 */
function fold(c: Condition, language: string, servers: string[]): Condition {
  if (!tuning.fold) return c;
  switch (c.kind) {
    case "language":
      return c.ids.includes(language) ? TRUE : FALSE;
    case "server":
      return c.ids.some((id) => servers.includes(id)) ? TRUE : FALSE;
    case "not": {
      const o = fold(c.operand, language, servers);
      if (o.kind === "const") return o.value ? FALSE : TRUE;
      return o === c.operand ? c : { kind: "not", operand: o };
    }
    case "and":
    case "or": {
      const l = fold(c.left, language, servers);
      const r = fold(c.right, language, servers);
      const and = c.kind === "and";
      // true & x is x, false & x is false; false | x is x, true | x is true.
      for (const [x, y] of [[l, r], [r, l]]) if (x.kind === "const") return x.value === and ? y : x;
      return l === c.left && r === c.right ? c : { kind: c.kind, left: l, right: r };
    }
    default:
      return c;
  }
}

/**
 * A rule to draw; one with a folder (a URI string) only applies to documents inside it. file names
 * its rules file for Inspect Token.
 */
export interface DrawRule extends TextRule {
  folder?: string;
  file: string;
}

/** Custom modifiers to give; likewise limited to a folder when it has one. */
export interface DrawTag extends TagRule {
  folder?: string;
  file: string;
}

/** A message rule; likewise limited to a folder when it has one. */
export interface DrawMessage extends MessageRule {
  folder?: string;
  file: string;
}

interface CompiledMessage {
  when: Condition;
  severity: vscode.DiagnosticSeverity;
  message: string;
  code?: string;
  folder?: string;
  source: string;
}

const DIAGNOSTIC_SOURCE = "Semantic Theme Extender";
/** Documents with code: files, unsaved files and notebook cells; not output panels and the like. */
const CODE_SCHEMES = ["file", "untitled", "vscode-notebook-cell"];
const IGNORE = /semantic-theme:\s*ignore\b(.*)/;

/**
 * Whether a marker silences the message for a token on this line: "semantic-theme: ignore" in a
 * comment on the same line, or on the line above when that line holds nothing but the comment.
 * Any comment syntax works, it's only text. Names after it limit it to those messages.
 */
function ignored(doc: vscode.TextDocument, line: number, code: string | undefined): boolean {
  const silences = (text: string, alone: boolean) => {
    const m = IGNORE.exec(text);
    if (!m || (alone && !/^\s*\S{0,3}\s*semantic-theme:/.test(text))) return false;
    const names = m[1].replace(/\*\/|-->/g, "").split(/[\s,]+/).filter(Boolean);
    return !names.length || (!!code && names.includes(code));
  };
  return silences(doc.lineAt(line).text, false) || (line > 0 && silences(doc.lineAt(line - 1).text, true));
}

// Line comments by language, for the quick fix that inserts a marker.
const LINE_COMMENTS: Record<string, string> = {};
for (const ids of [
  ["//", "c cpp csharp java javascript javascriptreact typescript typescriptreact go rust swift kotlin scala dart php fsharp jsonc groovy objective-c objective-cpp"],
  ["#", "python shellscript ruby perl r yaml toml coffeescript powershell makefile dockerfile julia elixir nim"],
  ["--", "lua sql haskell elm"],
  ["'", "vb"],
  [";", "clojure lisp scheme"],
]) {
  for (const id of ids[1].split(" ")) LINE_COMMENTS[id] = ids[0];
}

/** Offers "ignore here" on this extension's messages, as a comment line above the token. */
class IgnoreFix implements vscode.CodeActionProvider {
  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const comment = LINE_COMMENTS[doc.languageId];
    if (!comment) return [];
    return context.diagnostics
      .filter((d) => d.source === DIAGNOSTIC_SOURCE)
      .map((d) => {
        // Named messages have their name as code; others the rules file and line.
        const code = typeof d.code === "string" && /^[A-Za-z_][\w-]*$/.test(d.code) ? d.code : undefined;
        const line = doc.lineAt(d.range.start.line);
        const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
        const marker = `${comment} semantic-theme: ignore${code ? ` ${code}` : ""}`;
        const action = new vscode.CodeAction(`Ignore ${code ?? "this message"} here`, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [d];
        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(doc.uri, new vscode.Position(line.lineNumber, 0), `${indent}${marker}\n`);
        return action;
      });
  }
}

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warn: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

interface CompiledTag {
  when: Condition;
  modifiers: string[];
  folder?: string;
  /** Where the rule is, e.g. "global rules, line 12". */
  source: string;
}

const inFolder = (folder: string | undefined, uri: vscode.Uri) => {
  if (!folder) return true;
  return uri.toString().startsWith(folder.endsWith("/") ? folder : `${folder}/`);
};

interface Compiled {
  when: Condition;
  style: StyleValue;
  specificity: number;
  folder?: string;
  /** The head as written, and where the rule is: for Inspect Token. */
  text: string;
  source: string;
}

const sourceOf = (r: { file: string; line: number }) => `${r.file}, line ${r.line}`;

const messageFor = (m: { message: string }, t: Token) => m.message.replace(/\{text\}/g, t.text);

interface Token {
  range: vscode.Range;
  chain: string[];
  modifiers: string[];
  text: string;
}

interface Sym {
  name: string;
  kind: vscode.SymbolKind;
  range: vscode.Range;
  /** Where the symbol's name is; it belongs to the symbol around it, not to the symbol itself. */
  nameRange?: vscode.Range;
}

// Symbols whose insides are not direct members of the symbol around them: a method body isn't
// part of the class, a nested class's members aren't the outer class's.
const SCOPES = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Namespace,
  vscode.SymbolKind.Module,
]);

function decorationOptions(style: StyleValue): vscode.DecorationRenderOptions {
  if (typeof style === "string") return { color: style };
  const o: vscode.DecorationRenderOptions = {};
  if (style.foreground) o.color = style.foreground;
  if (style.bold !== undefined) o.fontWeight = style.bold ? "bold" : "normal";
  if (style.italic !== undefined) o.fontStyle = style.italic ? "italic" : "normal";
  const lines = [style.underline && "underline", style.strikethrough && "line-through"].filter(Boolean);
  if (style.underline !== undefined || style.strikethrough !== undefined) o.textDecoration = lines.length ? lines.join(" ") : "none";
  return o;
}

function compileCondition(c: TokenCondition): Condition {
  switch (c.kind) {
    case "language":
    case "server":
      return { kind: c.kind, ids: c.ids };
    case "text":
      return { kind: "text", tests: c.patterns.map((p) => patternToRegExp(p)) };
    case "doc":
    case "signature":
      // Hovers span lines and nobody remembers their capitalization; regular expressions say for themselves.
      return { kind: c.kind, tests: c.patterns.map((p) => patternToRegExp(p, "is")) };
    case "from":
      return { kind: "from", files: c.patterns.map(fileMatcher) };
    case "selector": {
      const { type, modifiers, language } = parseSelector(c.selector);
      return { kind: "selector", matcher: { type, modifiers, language } };
    }
    case "contains":
    case "within":
    case "inherits":
    case "decorated":
      return { kind: c.kind, inner: compileCondition(c.inner) };
    case "not":
      return { kind: "not", operand: compileCondition(c.operand) };
    default:
      return { kind: c.kind, left: compileCondition(c.left), right: compileCondition(c.right) };
  }
}

/**
 * How specific a rule is, ranked like VS Code ranks semantic rules: a token type beats *, then more
 * modifiers, then a language; after that, an exact text beats a wildcard text, and each symbol
 * condition (contains, within, inherits, from, ...) adds a little. Only conditions that must hold count (not
 * those under ! or |). Equally specific rules fall back to file order.
 */
function specificity(when: TokenCondition): number {
  let type = false;
  let modifiers = 0;
  let language = false;
  let text = 0;
  let symbols = 0;
  const walk = (c: TokenCondition) => {
    if (c.kind === "selector") {
      const s = parseSelector(c.selector);
      type ||= s.type !== "*";
      modifiers = Math.max(modifiers, s.modifiers.length);
      language ||= !!s.language;
    } else if (c.kind === "language" || c.kind === "server") language = true;
    else if (c.kind === "text") text = Math.max(text, c.patterns.some((p) => typeof p !== "string" || p.includes("*")) ? 1 : 2);
    else if (["contains", "within", "inherits", "decorated", "doc", "signature", "from"].includes(c.kind)) symbols++;
    else if (c.kind === "and") {
      walk(c.left);
      walk(c.right);
    }
  };
  walk(when);
  return (type ? 1e4 : 0) + Math.min(modifiers, 9) * 1e3 + (language ? 100 : 0) + text * 10 + Math.min(symbols, 9);
}

const selects = (m: Matcher, t: Token, language: string) =>
  (m.type === "*" || t.chain.includes(m.type)) && m.modifiers.every((x) => t.modifiers.includes(x)) && (!m.language || m.language === language);

const inside = (inner: vscode.Range, outer: vscode.Range) => outer.contains(inner) && !outer.isEqual(inner);

const needsSymbols = (c: Condition): boolean =>
  c.kind === "contains" || c.kind === "within" || c.kind === "inherits" || c.kind === "decorated" ||
  (c.kind === "not" && needsSymbols(c.operand)) ||
  ((c.kind === "and" || c.kind === "or") && (needsSymbols(c.left) || needsSymbols(c.right)));

const usesContains = (c: Condition): boolean =>
  c.kind === "contains" ||
  c.kind === "decorated" ||
  ((c.kind === "within" || c.kind === "inherits") && usesContains(c.inner)) ||
  (c.kind === "not" && usesContains(c.operand)) ||
  ((c.kind === "and" || c.kind === "or") && (usesContains(c.left) || usesContains(c.right)));

const usesDoc = (c: Condition): boolean =>
  c.kind === "doc" ||
  c.kind === "signature" ||
  ((c.kind === "contains" || c.kind === "within" || c.kind === "inherits" || c.kind === "decorated") && usesDoc(c.inner)) ||
  (c.kind === "not" && usesDoc(c.operand)) ||
  ((c.kind === "and" || c.kind === "or") && (usesDoc(c.left) || usesDoc(c.right)));

interface HoverText {
  /** The documentation: Markdown outside code blocks. */
  prose: string;
  /** Signatures and types: the code blocks, without their fences. */
  code: string;
}

function hoverText(hovers: vscode.Hover[]): HoverText {
  const prose: string[] = [];
  const code: string[] = [];
  for (const c of hovers.flatMap((h) => h.contents)) {
    if (typeof c !== "string" && "language" in c) {
      code.push(c.value);
      continue;
    }
    const md = typeof c === "string" ? c : c.value;
    prose.push(md.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, block: string) => (code.push(block.trim()), "")));
  }
  // Markdown separators (Pylance puts --- between signature and docs) aren't documentation, and
  // would keep doc(/^.../) from ever matching the first words.
  const text = prose.join("\n").replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, "");
  // Backslash escapes are Markdown, not documentation: C# writes "marker\." for "marker.".
  return { prose: text.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1").trim(), code: code.join("\n") };
}

type Loader = (uri: vscode.Uri) => Promise<DocData | undefined>;

// The documents the current chain of calls is giving custom modifiers to: inherits() and
// definitions in other files load documents, which get theirs first.
const taggingChain = new AsyncLocalStorage<Set<DocData>>();
// How long to wait for a document another chain is tagging.
const CROSS_WAIT_MS = 2000;
type Log = (line: string) => void;

/** Every kind of atom in c. */
function kindsOf(c: Condition, out: Set<Exclude<Condition["kind"], "const">>) {
  if (c.kind !== "const") out.add(c.kind);
  if ("inner" in c) kindsOf(c.inner, out);
  else if (c.kind === "not") kindsOf(c.operand, out);
  else if (c.kind === "and" || c.kind === "or") {
    kindsOf(c.left, out);
    kindsOf(c.right, out);
  }
}

const fileName = (uri: vscode.Uri) => uri.path.slice(uri.path.lastIndexOf("/") + 1);

const targetOf = (d: vscode.Location | vscode.LocationLink) => ("targetUri" in d ? d.targetUri : d.uri);

/** Runs f over items, a few at a time. */
async function inBatches<T>(items: T[], f: (x: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += PARALLEL) await Promise.all(items.slice(i, i + PARALLEL).map(f));
}

// VS Code keeps the answers of the last 10 prepareTypeHierarchy calls only; the supertypes of an
// older one come back empty. So hierarchy lookups go a few at a time, and each step of a walk up
// the bases is looked up anew, its supertypes asked right after.
const HIERARCHY_PARALLEL = 4;
let hierarchyBusy = 0;
const hierarchyQueue: (() => void)[] = [];

async function inHierarchy<T>(f: () => Thenable<T>): Promise<T> {
  if (hierarchyBusy < HIERARCHY_PARALLEL) hierarchyBusy++;
  else await new Promise<void>((r) => hierarchyQueue.push(r));
  try {
    return await f();
  } finally {
    // The slot goes on to the next in line, or is freed.
    const next = hierarchyQueue.shift();
    if (next) next();
    else hierarchyBusy--;
  }
}

const prepareHierarchy = (uri: vscode.Uri, at: vscode.Position) =>
  vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.prepareTypeHierarchy", uri, at).then(
    (r) => r ?? [],
    () => [],
  );

const typesAt = (uri: vscode.Uri, at: vscode.Position) => inHierarchy(() => prepareHierarchy(uri, at));

/** The base types of the type named at uri:at. */
const supertypesAt = (uri: vscode.Uri, at: vscode.Position) =>
  inHierarchy(async () => {
    const bases: vscode.TypeHierarchyItem[] = [];
    for (const item of await prepareHierarchy(uri, at)) {
      bases.push(
        ...(await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.provideSupertypes", item).then(
          (r) => r ?? [],
          () => [],
        )),
      );
    }
    return bases;
  });

/** Decided from a token alone, without asking the language server. */
const isCheap = (c: Condition): boolean =>
  c.kind === "selector" || c.kind === "text" || c.kind === "const" || c.kind === "language" || c.kind === "server" ||
  (c.kind === "not" && isCheap(c.operand)) ||
  ((c.kind === "and" || c.kind === "or") && isCheap(c.left) && isCheap(c.right));

/** a & b & c as [a, b, c]. */
const conjuncts = (c: Condition): Condition[] => (c.kind === "and" ? [...conjuncts(c.left), ...conjuncts(c.right)] : [c]);


/**
 * One document's tokens and symbols, and the conditions evaluated on them. within() is answered from
 * this document alone; contains() also for names defined in another file (once those are looked
 * up), in that file; inherits() asks the type hierarchy and evaluates its condition on each base
 * type's name token, in whatever file that base type lives (loaded through the shared loader, so
 * each file is analyzed once per version).
 */
class DocData {
  private owners = new Map<Condition, Set<string>>();
  /** inherits(): the type names asked about so far (their answers on the way), and those that do. */
  private inherited = new Map<Condition, Map<string, Promise<void>>>();
  private ready = new Map<Condition, Set<string>>();
  private names = new Map<Sym, Token | undefined>();
  /** Where each token's custom modifiers came from, for Inspect Token. */
  private origins = new Map<Token, Map<string, string>>();
  private tagging?: Promise<void>;
  private taggingNow = false;
  /** In a library file: the tokens given their custom modifiers so far, or on the way. */
  private tokenTagging = new Map<Token, Promise<void>>();
  private importing?: Promise<void>;
  /** Names used here and defined in another workspace file: their definitions' name tokens. */
  private definitions = new Map<string, { data: DocData; token: Token }[]>();
  /** Hover text by token text, for doc() and signature(). */
  private hovers = new Map<string, HoverText>();
  /** from(): the paths of the files each name is defined in, by token text, and the lookups on the way. */
  private files = new Map<string, string[]>();
  private locating = new Map<string, Promise<void>>();
  private located = 0;
  private declaredNames?: Set<string>;
  /** Set in the second pass of a document on screen: from then on doc() asks about every name. */
  private allDocs = false;
  /** True once definitions in other files are looked up. */
  imported = false;
  /** Where symbols' names start ("line:char"): those tokens declare something. */
  private declared = new Set<string>();
  private probedHierarchy = false;
  private folded = new Map<Condition, Condition>();

  constructor(
    readonly doc: vscode.TextDocument,
    readonly tokens: Token[],
    private readonly symbols: Sym[],
    private readonly load: Loader,
    private readonly tags: CompiledTag[],
    /** Every custom modifier some += assigns, in any folder: the ones worth carrying over. */
    private readonly custom: Set<string>,
    /** Some rule uses contains(), so definitions elsewhere are worth looking up even without modifiers. */
    private readonly follow: boolean,
    /** Some rule uses doc(). */
    private readonly docs: boolean,
    private readonly log: Log,
    private readonly support: Support,
    /** The extensions that may be this document's language server, lowercase. */
    readonly servers: string[],
    /** Loaded for another document, from outside the workspace: see ensureTagsOn(). */
    private readonly library = false,
  ) {
    for (const s of symbols) {
      this.names.set(s, s.nameRange && this.tokenAt(s.nameRange));
      if (s.nameRange) this.declared.add(`${s.nameRange.start.line}:${s.nameRange.start.character}`);
    }
  }

  /** Whether the token names something declared here: the server says so, or a symbol's name is there. */
  declares(t: Token): boolean {
    return t.modifiers.includes("declaration") || this.declared.has(`${t.range.start.line}:${t.range.start.character}`);
  }

  /**
   * Whether the language server has a type hierarchy, asked once at a type declaration: any server
   * that has one answers there.
   */
  private async probeHierarchy() {
    const language = this.doc.languageId;
    if (this.probedHierarchy || this.support.known(language, "typeHierarchy")) return;
    this.probedHierarchy = true;
    const t = this.tokens.find((t) => t.chain.some((c) => TYPE_TOKENS.includes(c)) && this.declares(t));
    if (!t) return;
    const items = await typesAt(this.doc.uri, t.range.start);
    this.support.report(language, "typeHierarchy", items.length > 0, fileName(this.doc.uri));
  }

  /**
   * Gives the tokens their custom modifiers, once. A document this same chain of calls is already
   * tagging is used as it is: inherits() may come back to it (a base type in the same file, or files
   * whose types derive from each other's), and waiting there would never end. One that a parallel
   * chain is tagging (two types walking up to the same base) is waited for, but not forever, in case
   * that chain in turn waits for this one.
   */
  ensureTags(): Promise<void> {
    if (this.library || taggingChain.getStore()?.has(this)) return Promise.resolve();
    const elsewhere = this.taggingNow;
    if (!this.tagging) {
      const chain = new Set(taggingChain.getStore()).add(this);
      this.tagging = taggingChain.run(chain, () => this.applyTags());
    }
    return elsewhere ? Promise.race([this.tagging, new Promise<void>((r) => setTimeout(r, CROSS_WAIT_MS))]) : this.tagging;
  }

  private async applyTags() {
    this.taggingNow = true;
    try {
      for (const tag of this.tags) {
        await this.prepare(tag.when);
        const hits = this.tokens.filter((t) => this.test(tag.when, t));
        for (const t of hits) this.give(t, tag.modifiers, tag.source);
        // Answers computed before these modifiers existed may be out of date now.
        this.owners.clear();
      }
    } finally {
      this.taggingNow = false;
    }
  }

  /**
   * Gives these tokens their custom modifiers. In a library file only these, when first asked about:
   * such files are large (builtins.pyi), and only a base type's name in them matters. Its
   * contains() and within() still look at the whole file, without the custom modifiers of the rest.
   */
  async ensureTagsOn(tokens: Token[]): Promise<void> {
    if (!this.library) return this.ensureTags();
    const todo = tokens.filter((t) => !this.tokenTagging.has(t));
    if (todo.length) {
      const run = this.tagOnly(todo);
      for (const t of todo) this.tokenTagging.set(t, run);
    }
    await Promise.all(tokens.map((t) => this.tokenTagging.get(t)));
  }

  private async tagOnly(tokens: Token[]) {
    for (const tag of this.tags) {
      // inherits(), doc() and from() ask the language server about these tokens alone.
      await this.prepareFolded(this.simplified(tag.when), tokens, tokens);
      for (const t of tokens) if (this.test(tag.when, t)) this.give(t, tag.modifiers, tag.source);
      this.owners.clear();
    }
  }

  /**
   * For a document on screen: tokens whose definition is in another workspace file take over the
   * custom modifiers the definition got there (Slotted in class Child(Slotted), from base.py), matched
   * by text like contains(), and contains() asks the definition's file about them. Then this
   * document's own assignments run again, to build on both.
   * Library files are left out: a document uses many library names, and their files are large.
   * Types are also looked up in the type hierarchy: go to definition on Slotted() may answer with
   * __init__, the hierarchy always with the class.
   */
  ensureImports(): Promise<void> {
    return (this.importing ??= this.importTags().finally(() => (this.imported = true)));
  }

  private async importTags() {
    await this.ensureTags();
    // Hovers are slow; the first pass is drawn without them. From now on doc() asks for them, for
    // the tokens the rest of each rule lets through (prepare).
    if (this.docs) this.allDocs = true;
    if (!this.custom.size && !this.follow) {
      if (this.docs) await this.applyTags();
      return;
    }
    const start = Date.now();
    const seen = new Set<string>();
    const refs = this.tokens.filter((t) => !t.modifiers.includes("declaration") && !seen.has(t.text) && seen.add(t.text)).slice(0, MAX_REFS);
    const found = new Map<string, Set<string>>();
    const fromFile = new Map<string, string>();
    const sources = new Map<string, string>();
    await inBatches(refs, async (t) => {
      const ask = <T>(command: string) =>
        vscode.commands.executeCommand<T[]>(command, this.doc.uri, t.range.start).then(
          (r) => r ?? [],
          () => [] as T[],
        );
      const [definitions, types] = await Promise.all([
        ask<vscode.Location | vscode.LocationLink>("vscode.executeDefinitionProvider"),
        t.chain.some((c) => TYPE_TOKENS.includes(c)) ? typesAt(this.doc.uri, t.range.start) : [],
      ]);
      // Also the answer from() needs; it won't ask again.
      if (!this.locating.has(t.text)) {
        this.files.set(t.text, definitions.map((d) => targetOf(d).path));
        this.locating.set(t.text, Promise.resolve());
      }
      const targets = [
        ...definitions.map((d) => ("targetUri" in d ? { uri: d.targetUri, range: d.targetSelectionRange ?? d.targetRange } : { uri: d.uri, range: d.range })),
        ...types.map((i) => ({ uri: i.uri, range: i.selectionRange })),
      ];
      for (const { uri, range } of targets) {
        if (uri.toString() === this.doc.uri.toString() || !vscode.workspace.getWorkspaceFolder(uri)) continue;
        const data = await this.load(uri);
        const name = data?.tokenAt(range);
        if (!data || !name) continue;
        this.definitions.set(t.text, [...(this.definitions.get(t.text) ?? []), { data, token: name }]);
        for (const m of name.modifiers) {
          if (!this.custom.has(m)) continue;
          found.set(t.text, (found.get(t.text) ?? new Set()).add(m));
          fromFile.set(t.text, `from the definition in ${vscode.workspace.asRelativePath(uri)}`);
          sources.set(t.text, fileName(uri));
        }
      }
    });
    const summary = [...found].map(([text, mods]) => `${text} <- ${sources.get(text)}: ${[...mods].join(", ")}`);
    this.log(
      `${fileName(this.doc.uri)}: asked about ${refs.length} names in ${Date.now() - start} ms; ${this.definitions.size} defined in other files; ` +
        `modifiers from there: ${summary.join("; ") || "none"}`,
    );
    if (!found.size && !this.definitions.size && !this.docs) return;
    for (const t of this.tokens) this.give(t, [...(found.get(t.text) ?? [])], fromFile.get(t.text) ?? "");
    this.owners.clear();
    await this.applyTags();
  }

  private give(t: Token, modifiers: string[], origin: string) {
    for (const m of modifiers) {
      if (t.modifiers.includes(m)) continue;
      t.modifiers.push(m);
      const origins = this.origins.get(t) ?? new Map<string, string>();
      this.origins.set(t, origins.set(m, origin));
    }
  }

  /** Custom modifiers of a token and where each came from. */
  originsOf(t: Token): Map<string, string> {
    return this.origins.get(t) ?? new Map();
  }

  /** The token at the start of range, e.g. the name token of a symbol or a type hierarchy item. */
  tokenAt(range: vscode.Range): Token | undefined {
    return this.tokens.find((t) => t.range.contains(range.start) && t.range.start.line === range.start.line);
  }

  /** Hover prose for these tokens' names, asked once per name. */
  private async fetchDocs(tokens: Token[]) {
    const seen = new Set<string>();
    const todo = tokens.filter((t) => !this.hovers.has(t.text) && !seen.has(t.text) && seen.add(t.text)).slice(0, MAX_REFS);
    if (!todo.length) return;
    const start = Date.now();
    let answered = false;
    await inBatches(todo, async (t) => {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", this.doc.uri, t.range.start).then(
        (r) => r ?? [],
        () => [],
      );
      answered ||= hovers.length > 0;
      this.hovers.set(t.text, hoverText(hovers));
    });
    // Any server with hovers has one for a declaration.
    if (answered || todo.some((t) => this.declares(t))) this.support.report(this.doc.languageId, "hovers", answered, fileName(this.doc.uri));
    if (todo.length > 1) this.log(`${fileName(this.doc.uri)}: ${todo.length} hovers for doc() / signature() in ${Date.now() - start} ms`);
  }

  /**
   * For from(): where these tokens' names are defined, asked once per name. A name declared here is
   * defined here, without asking (matched by text, like contains()): also a base type's name in its
   * own file, for inherits(from(...)).
   */
  private async locate(tokens: Token[]) {
    const here = (this.declaredNames ??= new Set(this.tokens.filter((t) => this.declares(t)).map((t) => t.text)));
    const seen = new Set<string>();
    const todo = tokens.filter((t) => !this.locating.has(t.text) && !seen.has(t.text) && seen.add(t.text));
    const ask: Token[] = [];
    for (const t of todo) {
      if (here.has(t.text)) {
        this.files.set(t.text, [this.doc.uri.path]);
        this.locating.set(t.text, Promise.resolve());
      } else if (this.located < MAX_REFS) {
        this.located++;
        ask.push(t);
      }
    }
    if (ask.length) {
      const start = Date.now();
      const run = inBatches(ask, async (t) => {
        const definitions = await vscode.commands
          .executeCommand<(vscode.Location | vscode.LocationLink)[]>("vscode.executeDefinitionProvider", this.doc.uri, t.range.start)
          .then(
            (r) => r ?? [],
            () => [],
          );
        this.files.set(t.text, definitions.map((d) => targetOf(d).path));
      });
      for (const t of ask) this.locating.set(t.text, run);
      run.then(() => ask.length > 1 && this.log(`${fileName(this.doc.uri)}: ${ask.length} definitions for from() in ${Date.now() - start} ms`));
    }
    await Promise.all(new Set(tokens.map((t) => this.locating.get(t.text)).filter((p): p is Promise<void> => !!p)));
  }

  /**
   * Answers the type hierarchy and documentation parts of c ahead of time, so test() can stay
   * synchronous. doc() needs hovers: for scope only (a base type's name), or, once this document is
   * on screen and past its first pass, for every name.
   */
  async prepare(c: Condition, scope?: Token[]): Promise<void> {
    return this.prepareFolded(this.simplified(c), scope);
  }

  /** Whether a type token's type has a base type whose name token meets inner. */
  private inheritsAt(t: Token, inner: Condition): Promise<boolean> {
    return this.anyBase(this.doc.uri, t.range.start, inner);
  }

  /** c as it is in this document: see fold(). */
  simplified(c: Condition): Condition {
    let s = this.folded.get(c);
    if (!s) this.folded.set(c, (s = fold(c, this.doc.languageId, this.servers)));
    return s;
  }

  /**
   * among: the tokens the cheap parts of an enclosing & let through, the only ones the language
   * server needs to be asked about: for doc("*x*") class, the hovers of classes, not of every name.
   */
  private async prepareFolded(c: Condition, scope?: Token[], among?: Token[]): Promise<void> {
    switch (c.kind) {
      case "doc":
      case "signature":
        if (scope) await this.fetchDocs(scope);
        else if (this.allDocs) await this.fetchDocs(among ?? this.tokens);
        return;
      case "from":
        return this.locate(scope ?? among ?? this.tokens);
      case "inherits": {
        await this.probeHierarchy();
        await this.prepare(c.inner);
        // Asked per type name as needed: tokens the cheap parts let through may grow, e.g. once
        // custom modifiers arrive. At most MAX_TYPES names per file.
        let asked = this.inherited.get(c);
        if (!asked) this.inherited.set(c, (asked = new Map()));
        let yes = this.ready.get(c);
        if (!yes) this.ready.set(c, (yes = new Set()));
        const seen = new Set<string>();
        const types = (among ?? this.tokens).filter((t) => t.chain.some((x) => TYPE_TOKENS.includes(x)) && !seen.has(t.text) && seen.add(t.text));
        const todo = types.filter((t) => !asked!.has(t.text)).slice(0, Math.max(0, MAX_TYPES - asked.size));
        const found = yes;
        const run = inBatches(todo, async (t) => {
          if (await this.inheritsAt(t, c.inner)) found.add(t.text);
        });
        for (const t of todo) asked.set(t.text, run);
        await Promise.all(new Set(types.map((t) => asked!.get(t.text)).filter((p): p is Promise<void> => !!p)));
        return;
      }
      case "contains":
      case "decorated": {
        await this.prepare(c.inner);
        const elsewhere = new Set([...this.definitions.values()].flatMap((list) => list.map((d) => d.data)));
        for (const data of elsewhere) await data.prepare(c.inner);
        return;
      }
      case "within":
        return this.prepare(c.inner);
      case "not":
        return this.prepareFolded(c.operand, scope, among);
      case "and": {
        const parts = conjuncts(c);
        const cheap = parts.filter(isCheap);
        const through = cheap.length ? (among ?? this.tokens).filter((t) => cheap.every((p) => this.testFolded(p, t))) : among;
        for (const p of parts) if (!isCheap(p)) await this.prepareFolded(p, scope, through);
        return;
      }
      case "or":
        await this.prepareFolded(c.left, scope, among);
        await this.prepareFolded(c.right, scope, among);
    }
  }

  test(c: Condition, t: Token): boolean {
    return this.testFolded(this.simplified(c), t);
  }

  private testFolded(c: Condition, t: Token): boolean {
    switch (c.kind) {
      case "const":
        return c.value;
      case "language":
        return c.ids.includes(this.doc.languageId);
      case "server":
        return c.ids.some((id) => this.servers.includes(id));
      case "text":
        return c.tests.some((r) => r.test(t.text));
      case "doc":
        return c.tests.some((r) => r.test(this.hovers.get(t.text)?.prose ?? ""));
      case "signature":
        return c.tests.some((r) => r.test(this.hovers.get(t.text)?.code ?? ""));
      case "from":
        return (this.files.get(t.text) ?? []).some((path) => c.files.some((f) => f(path)));
      case "selector":
        return selects(c.matcher, t, this.doc.languageId);
      case "contains":
        return this.ownersOf(c.inner).has(t.text) || !!this.definitions.get(t.text)?.some((d) => d.data.ownersOf(c.inner).has(d.token.text));
      case "decorated":
        return this.decoratedBy(c).has(t.text) || !!this.definitions.get(t.text)?.some((d) => d.data.decoratedBy(c).has(d.token.text));
      case "within":
        return this.symbols.some((s) => {
          if (!s.range.contains(t.range) || s.nameRange?.contains(t.range)) return false;
          const name = this.names.get(s);
          return !!name && this.test(c.inner, name);
        });
      case "inherits":
        return this.ready.get(c)?.has(t.text) ?? false;
      case "not":
        return !this.testFolded(c.operand, t);
      case "and":
        return this.testFolded(c.left, t) && this.testFolded(c.right, t);
      case "or":
        return this.testFolded(c.left, t) || this.testFolded(c.right, t);
    }
  }

  /**
   * Names of symbols that directly contain a token meeting inner: inside the symbol, but not
   * inside a nested class, function or similar. Tokens naming such a symbol are then matched by
   * text, so uses elsewhere in the file count too (two same-named symbols in one file can't be told apart).
   */
  private ownersOf(inner: Condition): Set<string> {
    let names = this.owners.get(inner);
    if (names) return names;
    names = new Set<string>();
    this.owners.set(inner, names);
    const hits = this.tokens.filter((t) => this.test(inner, t));
    for (const s of this.symbols) {
      if (names.has(this.nameOf(s))) continue;
      const nested = this.symbols.filter((o) => o !== s && SCOPES.has(o.kind) && inside(o.range, s.range));
      // A nested method's or class's name is a member of s; only its inside is not.
      const hidden = (t: Token) => nested.some((o) => o.range.contains(t.range) && !o.nameRange?.contains(t.range));
      if (hits.some((t) => s.range.contains(t.range) && !hidden(t))) names.add(this.nameOf(s));
    }
    return names;
  }

  /** What tokens naming the symbol say: C# symbol names carry signatures ("Make() : Point"). */
  private nameOf(s: Sym): string {
    return this.names.get(s)?.text ?? s.name;
  }

  /**
   * Names of symbols with a decorator or attribute meeting c's condition: a token in the part of
   * the symbol before its name (Python @decorators, C# [Attributes], Java @annotations, where the
   * language server's symbol range includes them), or on the lines right above it that start
   * with @, [ or #[ (Rust; where it doesn't). Matched by text like contains(); cached under c itself, so it
   * is cleared along with contains() answers.
   */
  private decoratedBy(c: Condition & { inner: Condition }): Set<string> {
    let names = this.owners.get(c);
    if (names) return names;
    names = new Set<string>();
    this.owners.set(c, names);
    for (const s of this.symbols) {
      if (!s.nameRange || names.has(this.nameOf(s))) continue;
      let first = s.range.start.line;
      while (first > 0 && /^\s*(?:[@[]|#\[)/.test(this.doc.lineAt(first - 1).text)) first--;
      const name = s.nameRange.start;
      const header = (t: Token) =>
        t.range.start.isBefore(name) && (s.range.contains(t.range) || (t.range.start.line >= first && t.range.start.line < s.range.start.line));
      if (this.tokens.some((t) => header(t) && this.test(c.inner, t))) names.add(this.nameOf(s));
    }
    return names;
  }

  private async anyBase(uri: vscode.Uri, at: vscode.Position, inner: Condition): Promise<boolean> {
    const seen = new Set<string>();
    let level = [{ uri, at }];
    for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
      const next: typeof level = [];
      for (const type of level) {
        for (const base of await supertypesAt(type.uri, type.at)) {
          const key = `${base.uri.toString()}#${base.selectionRange.start.line}:${base.selectionRange.start.character}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const data = await this.load(base.uri);
          const name = data?.tokenAt(base.selectionRange);
          if (data && name) {
            await data.ensureTagsOn([name]);
            await data.prepare(inner, [name]);
            if (data.test(inner, name)) return true;
          }
          next.push({ uri: base.uri, at: base.selectionRange.start });
        }
      }
      level = next;
    }
    return false;
  }
}

export class TokenDecorator implements vscode.Disposable {
  private rules: Compiled[] = [];
  private tags: CompiledTag[] = [];
  private messages: CompiledMessage[] = [];
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("semantic-theme-extender");
  private types: vscode.TextEditorDecorationType[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  /** Analyzed documents by URI, valid for one document version. */
  private cache = new Map<string, { version: number; data: Promise<DocData | undefined> }>();
  private readonly subscriptions: vscode.Disposable[];
  /** What each language's server turned out to provide, for warnings on conditions that can't match. */
  readonly support = new Support();

  constructor(
    private readonly registry: () => TokenRegistry | undefined,
    private readonly skipLanguage: string,
    private readonly log: Log = () => undefined,
  ) {
    this.subscriptions = [
      vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => this.schedule(e.document, 0, 0))),
      vscode.workspace.onDidChangeTextDocument((e) => {
        // Output panels and the like change all the time; only edits to code matter.
        if (!e.contentChanges.length || !CODE_SCHEMES.includes(e.document.uri.scheme)) return;
        // A base type may have changed: other documents' inherits() answers may be stale too.
        if (this.needsSymbols()) this.cache.clear();
        else this.cache.delete(e.document.uri.toString());
        this.schedule(e.document);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.diagnostics.delete(doc.uri)),
      vscode.languages.registerCodeActionsProvider(CODE_SCHEMES.map((scheme) => ({ scheme })), new IgnoreFix(), {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
    ];
  }

  /** New rules (after a rules or theme change): rebuild decoration types and redraw. */
  update(rules: DrawRule[], tags: DrawTag[] = [], messages: DrawMessage[] = []) {
    this.types.forEach((t) => t.dispose());
    this.types = rules.map((r) => vscode.window.createTextEditorDecorationType(decorationOptions(r.style)));
    this.rules = rules.map((r) => ({
      when: compileCondition(r.when),
      style: r.style,
      specificity: specificity(r.when),
      folder: r.folder,
      text: conditionText(r.when),
      source: sourceOf(r),
    }));
    this.tags = tags.map((t) => ({ when: compileCondition(t.when), modifiers: t.modifiers, folder: t.folder, source: sourceOf(t) }));
    this.messages = messages.map((m) => ({
      when: compileCondition(m.when),
      severity: SEVERITY[m.severity],
      message: m.message,
      code: m.code,
      folder: m.folder,
      source: sourceOf(m),
    }));
    this.diagnostics.clear();
    this.cache.clear();
    vscode.window.visibleTextEditors.forEach((e) => this.schedule(e.document, 0, 0));
  }

  /**
   * What this extension knows about the token at pos: its type and modifiers (custom ones with their
   * origin), the drawn rule that wins there and the others that match. Waits for cross-file lookups.
   */
  async inspect(doc: vscode.TextDocument, pos: vscode.Position): Promise<string[]> {
    const data = await this.load(doc.uri);
    if (!data) return ["No semantic tokens for this file: the language server hasn't provided any (yet)."];
    await data.ensureImports();
    // At "base::|Shape" both touch the cursor; the one it's before wins, the one it's after if alone.
    const token = data.tokens.find((t) => t.range.contains(pos) && !t.range.end.isEqual(pos)) ?? data.tokens.find((t) => t.range.contains(pos));
    if (!token) return ["No semantic token at the cursor."];
    const rules = this.rules.map((r, i) => ({ r, i })).filter(({ r }) => inFolder(r.folder, doc.uri));
    for (const { r } of rules) await data.prepare(r.when);
    // Most specific first; among equals the later rule, as drawn.
    const matching = rules.filter(({ r }) => data.test(r.when, token)).sort((a, b) => b.r.specificity - a.r.specificity || b.i - a.i);

    const origins = data.originsOf(token);
    const [type, ...supers] = token.chain;
    const lines = [
      `'${token.text}'  ${type}${supers.length ? ` (a kind of ${supers.join(", ")})` : ""}, ${doc.languageId}`,
      `  modifiers from the language server: ${token.modifiers.filter((m) => !origins.has(m)).join(", ") || "none"}`,
      `  servers: ${data.servers.join(", ") || "none known"}  (server(...) matches these)`,
    ];
    for (const [m, origin] of origins) lines.push(`  custom modifier ${m}: ${origin}`);
    if (!matching.length) {
      lines.push("  drawn: nothing; its color comes from the theme and settings (Developer: Inspect Editor Tokens and Scopes)");
    }
    matching.forEach(({ r }, k) => {
      lines.push(`  ${k === 0 ? "drawn:" : "also matches:"} ${r.text} = ${JSON.stringify(r.style)}  (${r.source})`);
    });
    for (const m of this.messages.filter((m) => inFolder(m.folder, doc.uri))) {
      await data.prepare(m.when);
      if (!data.test(m.when, token)) continue;
      const silenced = ignored(doc, token.range.start.line, m.code) ? " [ignored here]" : "";
      lines.push(`  message${m.code ? ` ${m.code}` : ""}: ${messageFor(m, token)}  (${m.source})${silenced}`);
    }
    const kinds = new Set<Exclude<Condition["kind"], "const">>();
    for (const r of [...rules.map(({ r }) => r), ...this.tags, ...this.messages]) if (inFolder(r.folder, doc.uri)) kindsOf(data.simplified(r.when), kinds);
    for (const kind of kinds) {
      const feature = featureOf(kind);
      if (feature && this.support.lacks(doc.languageId, feature)) lines.push(`  ${unsupportedText(kind, doc.languageId)}`);
    }
    return lines;
  }

  private schedule(doc: vscode.TextDocument, attempt = 0, delay = REFRESH_MS) {
    if (doc.languageId === this.skipLanguage || !vscode.window.visibleTextEditors.some((e) => e.document === doc)) return;
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.refresh(doc, attempt).catch(() => undefined);
      }, delay),
    );
  }

  private async refresh(doc: vscode.TextDocument, attempt: number) {
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document === doc);
    if (!editors.length) return;
    // This document's rules, least specific first, so the most specific match is found from the end.
    const order = this.rules
      .map((_, i) => i)
      .filter((i) => inFolder(this.rules[i].folder, doc.uri))
      .sort((a, b) => this.rules[a].specificity - this.rules[b].specificity || a - b);
    const ranges: vscode.Range[][] = this.rules.map(() => []);
    const messages = this.messages.filter((m) => inFolder(m.folder, doc.uri));
    const diagnostics: vscode.Diagnostic[] = [];
    if (order.length || messages.length) {
      const version = doc.version;
      const data = await this.load(doc.uri);
      if (!data) {
        this.cache.delete(doc.uri.toString());
        if (attempt < RETRIES) this.schedule(doc, attempt + 1, RETRY_MS);
        return;
      }
      for (const k of order) await data.prepare(this.rules[k].when);
      for (const m of messages) await data.prepare(m.when);
      // The document changed while this was computed; a newer refresh is on its way.
      if (doc.version !== version) return;
      for (const m of messages) {
        for (const token of data.tokens) {
          if (!data.test(m.when, token) || ignored(doc, token.range.start.line, m.code)) continue;
          const d = new vscode.Diagnostic(token.range, messageFor(m, token), m.severity);
          d.source = DIAGNOSTIC_SOURCE;
          d.code = m.code ?? m.source;
          diagnostics.push(d);
        }
      }
      for (const token of data.tokens) {
        // The most specific matching rule wins; among equals the later one.
        for (let k = order.length - 1; k >= 0; k--) {
          if (!data.test(this.rules[order[k]].when, token)) continue;
          ranges[order[k]].push(token.range);
          break;
        }
      }
      // Draw what this file says on its own now; modifiers from other files follow in a second pass.
      if (!data.imported) {
        data.ensureImports().then(
          () => this.schedule(doc, 0, 0),
          (e) => this.log(`${fileName(doc.uri)}: ${(e as Error)?.stack ?? e}`),
        );
      }
    }
    for (const editor of editors) {
      this.types.forEach((t, i) => editor.setDecorations(t, ranges[i]));
    }
    this.diagnostics.set(doc.uri, diagnostics);
  }

  private needsSymbols() {
    return [...this.rules, ...this.tags, ...this.messages].some((r) => needsSymbols(r.when));
  }

  /**
   * Tokens (with custom modifiers) and symbols of a document, also one that isn't open (a base type's
   * file). A file outside the workspace, a library's, gets the project rules of the document it's
   * loaded for: builtins.pyi's tuple is a struct in a project that says so. projects names their
   * folders, so it's analyzed once for each.
   */
  private load = async (uri: vscode.Uri, projects?: string): Promise<DocData | undefined> => {
    const doc = await vscode.workspace.openTextDocument(uri).then(
      (d) => d,
      () => undefined,
    );
    if (!doc) return undefined;
    const own = projects === undefined || !!vscode.workspace.getWorkspaceFolder(uri);
    if (own) projects = this.projectsOf(uri);
    const key = own ? uri.toString() : `${uri.toString()} ${projects}`;
    let hit = this.cache.get(key);
    if (!hit || hit.version !== doc.version) {
      hit = { version: doc.version, data: this.analyze(doc, projects!, !own) };
      this.cache.set(key, hit);
    }
    const data = await hit.data;
    await data?.ensureTags();
    return data;
  };

  /** The folders whose project rules apply to a document, as a key. */
  private projectsOf(uri: vscode.Uri): string {
    return [...new Set(this.tags.map((t) => t.folder).filter((f): f is string => !!f && inFolder(f, uri)))].join(" ");
  }

  private async analyze(doc: vscode.TextDocument, projects: string, library: boolean): Promise<DocData | undefined> {
    const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>("vscode.provideDocumentSemanticTokensLegend", doc.uri);
    const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>("vscode.provideDocumentSemanticTokens", doc.uri);
    if (!legend || !tokens) return undefined;
    const decoded = this.decode(doc, legend, tokens.data);
    const servers = serversFor(doc.languageId);
    // What this document's language and servers leave of the rules decides what's worth asking for.
    // Not limited to its folder: it may be another folder's base type file.
    const here = [...this.rules, ...this.tags, ...this.messages].map((r) => fold(r.when, doc.languageId, servers));
    const wantsSymbols = here.some(needsSymbols);
    const symbols = wantsSymbols ? await this.symbols(doc) : [];
    // Any server with symbols has some for a file that declares something.
    if (wantsSymbols && (symbols.length || decoded.some((t) => t.modifiers.includes("declaration")))) {
      this.support.report(doc.languageId, "symbols", symbols.length > 0, fileName(doc.uri));
    }
    const folders = projects.split(" ");
    const tags = this.tags.filter((t) => !t.folder || folders.includes(t.folder));
    const custom = new Set(this.tags.flatMap((t) => t.modifiers));
    const follow = here.some(usesContains);
    const docs = here.some(usesDoc);
    // Library files it reaches get the same project rules.
    const load: Loader = (uri) => this.load(uri, projects);
    return new DocData(doc, decoded, symbols, load, tags, custom, follow, docs, this.log, this.support, servers, library);
  }

  /** All symbols of the document, flattened; providers return either a tree or a flat list. */
  private async symbols(doc: vscode.TextDocument): Promise<Sym[]> {
    const raw = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>("vscode.executeDocumentSymbolProvider", doc.uri);
    const out: Sym[] = [];
    const walk = (list: (vscode.DocumentSymbol | vscode.SymbolInformation)[]) => {
      for (const s of list ?? []) {
        if ("children" in s) {
          out.push({ name: s.name, kind: s.kind, range: s.range, nameRange: s.selectionRange });
          walk(s.children);
        } else {
          out.push({ name: s.name, kind: s.kind, range: s.location.range });
        }
      }
    };
    walk(raw ?? []);
    return out;
  }

  // Semantic tokens come as groups of five numbers: line delta, start delta, length, type, modifier bits.
  private decode(doc: vscode.TextDocument, legend: vscode.SemanticTokensLegend, data: Uint32Array): Token[] {
    const registry = this.registry();
    const chains = new Map<number, string[]>();
    const chainOf = (t: number) => {
      let c = chains.get(t);
      if (!c) chains.set(t, (c = registry ? registry.chain(legend.tokenTypes[t]) : [legend.tokenTypes[t]]));
      return c;
    };
    const tokens: Token[] = [];
    let line = 0;
    let char = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
      line += data[i];
      char = data[i] === 0 ? char + data[i + 1] : data[i + 1];
      const range = new vscode.Range(line, char, line, char + data[i + 2]);
      const bits = data[i + 4];
      tokens.push({
        range,
        chain: chainOf(data[i + 3]),
        modifiers: legend.tokenModifiers.filter((_, m) => bits & (1 << m)),
        text: doc.getText(range),
      });
    }
    return tokens;
  }

  dispose() {
    this.support.dispose();
    this.diagnostics.dispose();
    this.timers.forEach((t) => clearTimeout(t));
    this.types.forEach((t) => t.dispose());
    this.subscriptions.forEach((s) => s.dispose());
  }
}
