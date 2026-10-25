// Rules whose head is more than a plain selector (text("__slots__") variable.classMember,
// contains(...) class, within(...), inherits(...), !, ...) are drawn over the language server's
// semantic tokens. VS Code uses a single semantic token provider per document, so instead of
// providing tokens this reads the existing ones, plus document symbols and the type hierarchy
// where a rule needs them, and draws editor decorations over matches. Rules from a project's rules
// file only apply to documents inside that workspace folder.

import * as vscode from "vscode";
import { globToRegExp, TokenCondition } from "./cfg";
import { StyleValue, TextRule } from "./engine";
import { parseSelector, TokenRegistry } from "./theme";

const REFRESH_MS = 400;
// A language server may not have tokens right after a file opens; ask again a few times.
const RETRY_MS = 1500;
const RETRIES = 4;
// inherits(): how far up the type hierarchy to look, and how many types per file to ask about.
const MAX_DEPTH = 12;
const MAX_TYPES = 300;
// Token types that can name a type with a hierarchy.
const TYPE_TOKENS = ["class", "struct", "interface", "enum", "type"];

interface Matcher {
  type: string;
  modifiers: string[];
  language?: string;
}

/** A condition ready to evaluate: texts as regular expressions, selectors parsed. */
type Condition =
  | { kind: "language"; ids: string[] }
  | { kind: "text"; text: RegExp }
  | { kind: "selector"; matcher: Matcher }
  | { kind: "contains" | "within" | "inherits"; inner: Condition }
  | { kind: "not"; operand: Condition }
  | { kind: "and" | "or"; left: Condition; right: Condition };

/** A rule to draw; one with a folder (a URI string) only applies to documents inside it. */
export interface DrawRule extends TextRule {
  folder?: string;
}

interface Compiled {
  when: Condition;
  style: StyleValue;
  specificity: number;
  folder?: string;
}

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
      return { kind: "language", ids: c.ids };
    case "text":
      // Several texts mean any of them.
      return { kind: "text", text: new RegExp(c.globs.map((g) => globToRegExp(g).source).join("|")) };
    case "selector": {
      const { type, modifiers, language } = parseSelector(c.selector);
      return { kind: "selector", matcher: { type, modifiers, language } };
    }
    case "contains":
    case "within":
    case "inherits":
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
 * condition (contains, within, inherits) adds a little. Only conditions that must hold count (not
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
    } else if (c.kind === "language") language = true;
    else if (c.kind === "text") text = Math.max(text, c.globs.some((g) => g.includes("*")) ? 1 : 2);
    else if (c.kind === "contains" || c.kind === "within" || c.kind === "inherits") symbols++;
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
  c.kind === "contains" || c.kind === "within" || c.kind === "inherits" ||
  (c.kind === "not" && needsSymbols(c.operand)) ||
  ((c.kind === "and" || c.kind === "or") && (needsSymbols(c.left) || needsSymbols(c.right)));

type Loader = (uri: vscode.Uri) => Promise<DocData | undefined>;

/**
 * One document's tokens and symbols, and the conditions evaluated on them. contains() and within()
 * are answered from this document alone; inherits() asks the type hierarchy and evaluates its
 * condition on each base type's name token, in whatever file that base type lives (loaded through
 * the shared loader, so each file is analyzed once per version).
 */
class DocData {
  private owners = new Map<Condition, Set<string>>();
  private inherited = new Map<Condition, Promise<Set<string>>>();
  private ready = new Map<Condition, Set<string>>();
  private names = new Map<Sym, Token | undefined>();

  constructor(
    readonly doc: vscode.TextDocument,
    readonly tokens: Token[],
    private readonly symbols: Sym[],
    private readonly load: Loader,
  ) {
    for (const s of symbols) this.names.set(s, s.nameRange && this.tokenAt(s.nameRange));
  }

  /** The token at the start of range, e.g. the name token of a symbol or a type hierarchy item. */
  tokenAt(range: vscode.Range): Token | undefined {
    return this.tokens.find((t) => t.range.contains(range.start) && t.range.start.line === range.start.line);
  }

  /** Answers the type hierarchy parts of c ahead of time, so test() can stay synchronous. */
  async prepare(c: Condition): Promise<void> {
    switch (c.kind) {
      case "inherits":
        await this.prepare(c.inner);
        if (!this.inherited.has(c)) this.inherited.set(c, this.computeInherits(c.inner));
        this.ready.set(c, await this.inherited.get(c)!);
        return;
      case "contains":
      case "within":
        return this.prepare(c.inner);
      case "not":
        return this.prepare(c.operand);
      case "and":
      case "or":
        await this.prepare(c.left);
        await this.prepare(c.right);
    }
  }

  test(c: Condition, t: Token): boolean {
    switch (c.kind) {
      case "language":
        return c.ids.includes(this.doc.languageId);
      case "text":
        return c.text.test(t.text);
      case "selector":
        return selects(c.matcher, t, this.doc.languageId);
      case "contains":
        return this.ownersOf(c.inner).has(t.text);
      case "within":
        return this.symbols.some((s) => {
          if (!s.range.contains(t.range) || s.nameRange?.contains(t.range)) return false;
          const name = this.names.get(s);
          return !!name && this.test(c.inner, name);
        });
      case "inherits":
        return this.ready.get(c)?.has(t.text) ?? false;
      case "not":
        return !this.test(c.operand, t);
      case "and":
        return this.test(c.left, t) && this.test(c.right, t);
      case "or":
        return this.test(c.left, t) || this.test(c.right, t);
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
      if (names.has(s.name)) continue;
      const nested = this.symbols.filter((o) => o !== s && SCOPES.has(o.kind) && inside(o.range, s.range));
      // A nested method's or class's name is a member of s; only its inside is not.
      const hidden = (t: Token) => nested.some((o) => o.range.contains(t.range) && !o.nameRange?.contains(t.range));
      if (hits.some((t) => s.range.contains(t.range) && !hidden(t))) names.add(s.name);
    }
    return names;
  }

  /**
   * Names of types in this document with a base type (directly or further up) whose name token
   * meets inner. Asked once per distinct type name, matched by text like contains().
   */
  private async computeInherits(inner: Condition): Promise<Set<string>> {
    const names = new Set<string>();
    const seen = new Set<string>();
    const candidates = this.tokens.filter((t) => t.chain.some((c) => TYPE_TOKENS.includes(c)) && !seen.has(t.text) && seen.add(t.text));
    for (const t of candidates.slice(0, MAX_TYPES)) {
      const items = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.prepareTypeHierarchy", this.doc.uri, t.range.start).then(
        (r) => r ?? [],
        () => [],
      );
      if (await this.anyBase(items, inner)) names.add(t.text);
    }
    return names;
  }

  private async anyBase(start: vscode.TypeHierarchyItem[], inner: Condition): Promise<boolean> {
    const seen = new Set<string>();
    let level = start;
    for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
      const next: vscode.TypeHierarchyItem[] = [];
      for (const item of level) {
        const bases = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.provideSupertypes", item).then(
          (r) => r ?? [],
          () => [],
        );
        for (const base of bases) {
          const key = `${base.uri.toString()}#${base.selectionRange.start.line}:${base.selectionRange.start.character}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const data = await this.load(base.uri);
          const name = data?.tokenAt(base.selectionRange);
          if (data && name) {
            await data.prepare(inner);
            if (data.test(inner, name)) return true;
          }
          next.push(base);
        }
      }
      level = next;
    }
    return false;
  }
}

export class TokenDecorator implements vscode.Disposable {
  private rules: Compiled[] = [];
  private types: vscode.TextEditorDecorationType[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  /** Analyzed documents by URI, valid for one document version. */
  private cache = new Map<string, { version: number; data: Promise<DocData | undefined> }>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly registry: () => TokenRegistry | undefined,
    private readonly skipLanguage: string,
  ) {
    this.subscriptions = [
      vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => this.schedule(e.document))),
      vscode.workspace.onDidChangeTextDocument((e) => {
        // A base type may have changed: other documents' inherits() answers may be stale too.
        if (this.rules.some((r) => needsSymbols(r.when))) this.cache.clear();
        else this.cache.delete(e.document.uri.toString());
        this.schedule(e.document);
      }),
    ];
  }

  /** New rules (after a rules or theme change): rebuild decoration types and redraw. */
  update(rules: DrawRule[]) {
    this.types.forEach((t) => t.dispose());
    this.types = rules.map((r) => vscode.window.createTextEditorDecorationType(decorationOptions(r.style)));
    this.rules = rules.map((r) => ({ when: compileCondition(r.when), style: r.style, specificity: specificity(r.when), folder: r.folder }));
    this.cache.clear();
    vscode.window.visibleTextEditors.forEach((e) => this.schedule(e.document));
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
    const uri = doc.uri.toString();
    const applies = (r: Compiled) => !r.folder || uri.startsWith(r.folder.endsWith("/") ? r.folder : `${r.folder}/`);
    const order = this.rules
      .map((_, i) => i)
      .filter((i) => applies(this.rules[i]))
      .sort((a, b) => this.rules[a].specificity - this.rules[b].specificity || a - b);
    const ranges: vscode.Range[][] = this.rules.map(() => []);
    if (order.length) {
      const version = doc.version;
      const data = await this.load(doc.uri);
      if (!data) {
        this.cache.delete(doc.uri.toString());
        if (attempt < RETRIES) this.schedule(doc, attempt + 1, RETRY_MS);
        return;
      }
      for (const k of order) await data.prepare(this.rules[k].when);
      // The document changed while this was computed; a newer refresh is on its way.
      if (doc.version !== version) return;
      for (const token of data.tokens) {
        // The most specific matching rule wins; among equals the later one.
        for (let k = order.length - 1; k >= 0; k--) {
          if (!data.test(this.rules[order[k]].when, token)) continue;
          ranges[order[k]].push(token.range);
          break;
        }
      }
    }
    for (const editor of editors) {
      this.types.forEach((t, i) => editor.setDecorations(t, ranges[i]));
    }
  }

  /** Tokens and symbols of a document, also one that isn't open (a base type's file). */
  private load: Loader = async (uri) => {
    const key = uri.toString();
    const doc = await vscode.workspace.openTextDocument(uri).then(
      (d) => d,
      () => undefined,
    );
    if (!doc) return undefined;
    const hit = this.cache.get(key);
    if (hit && hit.version === doc.version) return hit.data;
    const data = this.analyze(doc);
    this.cache.set(key, { version: doc.version, data });
    return data;
  };

  private async analyze(doc: vscode.TextDocument): Promise<DocData | undefined> {
    const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>("vscode.provideDocumentSemanticTokensLegend", doc.uri);
    const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>("vscode.provideDocumentSemanticTokens", doc.uri);
    if (!legend || !tokens) return undefined;
    const symbols = this.rules.some((r) => needsSymbols(r.when)) ? await this.symbols(doc) : [];
    return new DocData(doc, this.decode(doc, legend, tokens.data), symbols, this.load);
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
    this.timers.forEach((t) => clearTimeout(t));
    this.types.forEach((t) => t.dispose());
    this.subscriptions.forEach((s) => s.dispose());
  }
}
