// Parser for rules files.
//
//   ; comment
//   $name = color                      variable: top level only, assigned once, usable anywhere
//   head += slotted, other             custom modifiers: matching tokens get them, as if the language
//                                      server had reported them; class.slotted selects them anywhere
//   @name => head                      a named selector expression, used as @name in heads:
//                                      @slots => contains(text("__slots__") variable.classMember)
//                                      @slots class = ...; top level only, assigned once, usable anywhere
//   selector = value                   rule; skipped where the theme has a rule for exactly that selector
//                                      semantic selectors (struct, variable.readonly) also set their
//                                      TextMate fallback scope; other dotted names are TextMate scopes
//   override rule | override { rules }  rules that also replace the theme's own colors
//   head = value | head { rules }      the head is a selector expression: struct, struct | enum,
//                                      language(python) selfParameter, text("__slots__") variable,
//                                      contains(text("__slots__") variable.classMember) class,
//                                      within(class) method, inherits(contains(...)) class;
//                                      side by side means &, also ! | and parentheses; a block's head
//                                      and the heads inside must all hold. Plain selectors go to
//                                      settings, anything else is drawn as decorations
//   ui | semantic | textmate rule or { rules }  say what kind of name a selector is, instead of
//                                      inferring it: token type, then UI color ID, then TextMate scope
//   match($type) { dark & contrast { rules } _ { rules } }      block: rules for matching themes
//
// Later rules in the file override earlier ones for the same selector.
//   value: color | style(color, bold | !italic) | $none | match($type) { dark -> value  _ -> value }
//
// Keywords are only recognized where a token name could not stand: "match" must be followed by
// "($subject)", "style" by "(", "override" / "ui" / "semantic" / "textmate" by "{" or a statement
// (or by a name, in values: ui editor.background), and a selector by "=".

import { Color, parseHex } from "./color";

export interface Pos {
  line: number;
  col: number;
}

export interface Range {
  start: Pos;
  end: Pos;
}

export interface Problem {
  range: Range;
  message: string;
  warning?: boolean;
  /** Shown faintly; for things that are often fine. */
  hint?: boolean;
}

export type Subject = "type" | "theme";

export type Pattern =
  | { kind: "any"; range: Range }
  | { kind: "flag"; flag: Flag; range: Range }
  | { kind: "name"; glob: string; range: Range }
  | { kind: "not"; operand: Pattern; range: Range }
  | { kind: "and" | "or"; left: Pattern; right: Pattern; range: Range };

export type Expr =
  | { kind: "color"; value: Color; range: Range }
  | { kind: "var"; name: string; range: Range }
  /** A theme color; kind is set when a keyword names it explicitly: ui editor.background. */
  | { kind: "ref"; name: string; target?: NameKind; range: Range }
  | { kind: "num"; value: number; unit: NumUnit; decimal: boolean; range: Range }
  | { kind: "call"; fn: string; args: Expr[]; range: Range; nameRange: Range }
  /** A $type condition like "light & !contrast", only valid where a function expects one. */
  | { kind: "condition"; pattern: Pattern; range: Range }
  | { kind: "match"; subject: Subject; arms: Arm<Expr>[]; range: Range };

/** "10%" is percent, "30deg" / "30°" degrees; decimal tells "1.0" from "1" (0-1 vs 0-255 in rgb). */
export type NumUnit = "none" | "percent" | "deg";

export interface StyleFlag {
  name: "bold" | "italic" | "underline" | "strikethrough";
  on: boolean;
}

export type Value =
  | { kind: "none"; range: Range }
  | { kind: "style"; color?: Expr; flags: StyleFlag[]; range: Range }
  | { kind: "match"; subject: Subject; arms: Arm<Value>[]; range: Range }
  | { kind: "expr"; expr: Expr; range: Range };

export interface Arm<T> {
  pattern: Pattern;
  body: T;
}

export interface VarDecl {
  kind: "var";
  name: string;
  nameRange: Range;
  value: Expr;
}

/** @name => head; uses of @name are replaced by the head when parsing ends. */
export interface ExpressionDecl {
  kind: "expression";
  name: string;
  nameRange: Range;
  cond: Cond;
}

export interface Rule {
  kind: "rule";
  /** The left side: struct, struct | enum, text("__slots__") variable.classMember, ... */
  head: Cond;
  /** The head as text, for messages; for a plain selector just its name. */
  selector: string;
  selectorRange: Range;
  /** Set inside ui / semantic / textmate; otherwise the kind is inferred from the name. */
  target?: NameKind;
  /** The heads of enclosing blocks; they and the rule's own head must all hold. */
  when?: Cond;
  value: Value;
}

/** head += slotted: custom modifiers for the tokens the head matches. */
export interface TagRule {
  kind: "tag";
  head: Cond;
  /** The head as text, for messages. */
  selector: string;
  selectorRange: Range;
  target?: NameKind;
  when?: Cond;
  modifiers: string[];
}

export interface Override {
  kind: "override";
  body: Stmt[];
  range: Range;
}

/** ui { rules }, semantic { rules }, textmate { rules }; the rules inside carry the kind. */
export interface Target {
  kind: "target";
  target: NameKind;
  body: Stmt[];
  range: Range;
}

/**
 * A selector expression, the head of a rule or block. Atoms: a selector (struct, *.static,
 * parameter:python), language(python, csharp), text("__slots__"), and three that look at symbols:
 * contains(x) for tokens naming a symbol that directly contains a match, within(x) for tokens inside
 * a symbol whose name matches, inherits(x) for tokens naming a type with a base type whose name
 * matches. Side by side means & (and), also | ! ( ). @name stands for a declared expression; it
 * only exists while parsing.
 */
export type Cond =
  | { kind: "selector"; selector: string; range: Range }
  | { kind: "language"; ids: string[]; range: Range }
  | { kind: "text"; globs: string[]; range: Range }
  | { kind: "contains" | "within" | "inherits"; inner: Cond; range: Range }
  | { kind: "not"; operand: Cond; range: Range }
  | { kind: "and" | "or"; left: Cond; right: Cond; range: Range }
  | { kind: "name"; name: string; range: Range };

/** A selector expression without source positions. */
export type TokenCondition =
  | { kind: "selector"; selector: string }
  | { kind: "language"; ids: string[] }
  | { kind: "text"; globs: string[] }
  | { kind: "contains" | "within" | "inherits"; inner: TokenCondition }
  | { kind: "not"; operand: TokenCondition }
  | { kind: "and" | "or"; left: TokenCondition; right: TokenCondition };

/** The expression as written (normalized), for messages and logs. */
export function conditionText(c: TokenCondition, parent?: TokenCondition["kind"]): string {
  switch (c.kind) {
    case "selector":
      return c.selector;
    case "language":
      return `language(${c.ids.join(", ")})`;
    case "text":
      return `text(${c.globs.map((g) => `"${g}"`).join(", ")})`;
    case "contains":
    case "within":
    case "inherits":
      return `${c.kind}(${conditionText(c.inner)})`;
    case "not":
      return `!${conditionText(c.operand, "not")}`;
    case "and": {
      const s = `${conditionText(c.left, "and")} ${conditionText(c.right, "and")}`;
      return parent === "not" ? `(${s})` : s;
    }
    case "or": {
      const s = `${conditionText(c.left, "or")} | ${conditionText(c.right, "or")}`;
      return parent && parent !== "or" ? `(${s})` : s;
    }
  }
}

/** Removes source positions. */
export function stripCondition(c: Cond): TokenCondition {
  switch (c.kind) {
    case "selector":
      return { kind: "selector", selector: c.selector };
    case "language":
      return { kind: "language", ids: c.ids };
    case "text":
      return { kind: "text", globs: c.globs };
    case "contains":
    case "within":
    case "inherits":
      return { kind: c.kind, inner: stripCondition(c.inner) };
    case "not":
      return { kind: "not", operand: stripCondition(c.operand) };
    case "name":
      // Only before names are resolved, for the text of a head: "@slots class".
      return { kind: "selector", selector: `@${c.name}` };
    default:
      return { kind: c.kind, left: stripCondition(c.left), right: stripCondition(c.right) };
  }
}

/** head { rules }, e.g. language(python) { ... }; the rules inside carry the head as a condition. */
export interface WhenBlock {
  kind: "when";
  cond: Cond;
  body: Stmt[];
  range: Range;
}

export interface Block {
  kind: "block";
  subject: Subject;
  arms: Arm<Stmt[]>[];
  range: Range;
}

export type Stmt = VarDecl | ExpressionDecl | Rule | TagRule | Block | Override | Target | WhenBlock;

export interface RulesFile {
  stmts: Stmt[];
  variables: Map<string, VarDecl>;
  expressions: Map<string, ExpressionDecl>;
  problems: Problem[];
}

/** What a name refers to: a semantic token selector, a TextMate scope or a UI color ID. */
export type NameKind = "semantic" | "textmate" | "ui";
export const NAME_KINDS: NameKind[] = ["semantic", "textmate", "ui"];
const isNameKind = (text: string): text is NameKind => (NAME_KINDS as string[]).includes(text);

/** "*" matches any run of characters; everything else is literal. */
export const globToRegExp = (glob: string, flags = "") =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, flags);

export type Flag = "dark" | "light" | "contrast";
export const FLAGS: Flag[] = ["dark", "light", "contrast"];
export const BUILTINS = new Set(["theme", "type", "none"]);
export const STYLE_NAMES = new Set(["bold", "italic", "underline", "strikethrough"]);
/** Color functions other than style(); kept in sync with FUNCTIONS in rules.ts. */
export const FUNCTION_NAMES = new Set(["emphasize", "soften", "offset", "lighten", "darken", "saturate", "desaturate", "hue", "mix", "alpha", "rgb", "rgba"]);

/** Function arguments that take a $type condition, by position: offset(c, base, target, light). */
export const CONDITION_ARGS: Record<string, number> = { offset: 3 };

/** The four theme kinds as flag sets, for static pattern checks. */
export const THEME_KINDS: Set<Flag>[] = [
  new Set(["dark"]),
  new Set(["light"]),
  new Set(["dark", "contrast"]),
  new Set(["light", "contrast"]),
];

/**
 * The single source for $type and every contrast-aware function: dark / light from what is
 * actually on screen (the editor background), contrast from the theme's declared kind, since
 * high contrast can't be measured reliably.
 */
export function themeFlags(darkBackground: boolean, uiTheme: string): Set<Flag> {
  const flags = new Set<Flag>([darkBackground ? "dark" : "light"]);
  if (uiTheme === "hc-black" || uiTheme === "hc-light") flags.add("contrast");
  return flags;
}

export function matchesPattern(p: Pattern, flags: Set<Flag>, themeId: string): boolean {
  switch (p.kind) {
    case "any":
      return true;
    case "flag":
      return flags.has(p.flag);
    case "name":
      return globToRegExp(p.glob, "i").test(themeId);
    case "not":
      return !matchesPattern(p.operand, flags, themeId);
    case "and":
      return matchesPattern(p.left, flags, themeId) && matchesPattern(p.right, flags, themeId);
    case "or":
      return matchesPattern(p.left, flags, themeId) || matchesPattern(p.right, flags, themeId);
  }
}

// ---------------------------------------------------------------------------------------------

type TokenType = "hex" | "var" | "at" | "ident" | "num" | "string" | "punct";

interface Token {
  type: TokenType;
  text: string;
  range: Range;
}

class ParseError extends Error {
  constructor(message: string, readonly range: Range) {
    super(message);
  }
}

const TOKEN_RE =
  /(#[0-9a-fA-F]+)|\$([\w-]*)|@([\w-]*)|((?:\*(?=[.:])|[A-Za-z_])(?:[\w.:]|-(?=\w))*)|([+-]?(?:\d+\.?\d*|\.\d+)(?:%|deg\b|°)?)|("[^"\n]*"?)|(->|=>|\+=|[=(),!|&{}*])/y;

function tokenize(text: string, problems: Problem[]): Token[] {
  const tokens: Token[] = [];
  text.split(/\r?\n/).forEach((lineText, line) => {
    let col = 0;
    while (col < lineText.length) {
      const c = lineText[col];
      if (c === ";") break;
      if (/\s/.test(c)) {
        col++;
        continue;
      }
      TOKEN_RE.lastIndex = col;
      const m = TOKEN_RE.exec(lineText);
      const range = (len: number): Range => ({ start: { line, col }, end: { line, col: col + len } });
      if (!m) {
        problems.push({ range: range(1), message: `Unexpected character '${c}'` });
        col++;
        continue;
      }
      const [all, hex, v, at, ident, num, str] = m;
      const type: TokenType =
        hex !== undefined ? "hex" : v !== undefined ? "var" : at !== undefined ? "at" : ident !== undefined ? "ident" : num !== undefined ? "num" : str !== undefined ? "string" : "punct";
      if (type === "string" && !all.endsWith('"') || all === '"') {
        problems.push({ range: range(all.length), message: "Unclosed string" });
      }
      tokens.push({ type, text: type === "var" ? v : type === "at" ? at : type === "string" ? all.replace(/^"|"$/g, "") : all, range: range(all.length) });
      col += all.length;
    }
  });
  return tokens;
}

const span = (a: Range, b: Range): Range => ({ start: a.start, end: b.end });

export function parseRulesFile(text: string): RulesFile {
  const problems: Problem[] = [];
  const tokens = tokenize(text, problems);
  const variables = new Map<string, VarDecl>();
  const expressions = new Map<string, ExpressionDecl>();
  let i = 0;
  let depth = 0; // braces consumed so far, for error recovery
  let overrideDepth = 0;
  let target: { kind: NameKind; range: Range } | undefined;
  let when: Cond | undefined;

  const peek = (k = 0) => tokens[i + k];
  const isPunct = (t: Token | undefined, p: string) => t?.type === "punct" && t.text === p;
  const next = () => {
    const t = tokens[i++];
    if (isPunct(t, "{")) depth++;
    if (isPunct(t, "}")) depth--;
    return t;
  };
  const endRange = (): Range => {
    const last = tokens[tokens.length - 1];
    return last ? { start: last.range.end, end: { line: last.range.end.line, col: last.range.end.col + 1 } } : { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } };
  };
  const fail = (message: string, t: Token | undefined = peek()): never => {
    throw new ParseError(message, t?.range ?? endRange());
  };
  const expect = (p: string, what = `'${p}'`) => {
    const t = peek();
    if (!isPunct(t, p)) fail(`Expected ${what}${t ? `, found '${t.text}'` : ""}`);
    return next();
  };
  const sameLine = (a: Token | undefined, b: Token | undefined) => !!a && !!b && a.range.end.line === b.range.start.line;
  const isMatchStart = () => peek()?.type === "ident" && peek().text === "match" && isPunct(peek(1), "(");

  // After a statement or arm, the next one must start on a new line (or after "," / before "}").
  const expectBreak = (allowComma: boolean) => {
    const prev = tokens[i - 1];
    const t = peek();
    if (!t || isPunct(t, "}")) return;
    if (allowComma && isPunct(t, ",")) {
      next();
      return;
    }
    if (sameLine(prev, t)) fail(`Unexpected '${t.text}': put each ${allowComma ? "arm" : "statement"} on its own line`);
  };

  // Skips to the next statement: the first token on a later line than the error, at the brace
  // depth the failed statement started at (or the "}" closing its block).
  function recover(startDepth: number, startIndex: number, errorLine: number) {
    if (i === startIndex) next();
    while (i < tokens.length) {
      const t = peek();
      if (depth < startDepth) return;
      const newLine = t.range.start.line > errorLine && !sameLine(tokens[i - 1], t);
      if (depth === startDepth && (isPunct(t, "}") || newLine)) return;
      next();
    }
  }

  // ---- patterns

  function parsePattern(subject: Subject): Pattern {
    let left = parseAnd(subject);
    while (isPunct(peek(), "|")) {
      next();
      const right = parseAnd(subject);
      left = { kind: "or", left, right, range: span(left.range, right.range) };
    }
    return left;
  }

  function parseAnd(subject: Subject): Pattern {
    let left = parseUnary(subject);
    while (isPunct(peek(), "&")) {
      next();
      const right = parseUnary(subject);
      left = { kind: "and", left, right, range: span(left.range, right.range) };
    }
    return left;
  }

  function parseUnary(subject: Subject): Pattern {
    if (isPunct(peek(), "!")) {
      const bang = next();
      const operand = parseUnary(subject);
      return { kind: "not", operand, range: span(bang.range, operand.range) };
    }
    if (isPunct(peek(), "(")) {
      next();
      const p = parsePattern(subject);
      expect(")");
      return p;
    }
    const t = peek();
    if (t?.type === "ident" && t.text === "_") {
      next();
      return { kind: "any", range: t.range };
    }
    if (subject === "type") {
      if (t?.type === "ident" && (FLAGS as string[]).includes(t.text)) {
        next();
        return { kind: "flag", flag: t.text as Flag, range: t.range };
      }
      fail(t?.type === "string" ? "$type is matched with flags: dark, light, contrast" : "Expected dark, light, contrast or _");
    }
    if (t?.type === "string") {
      next();
      return { kind: "name", glob: t.text, range: t.range };
    }
    return fail(t?.type === "ident" ? `Theme names are quoted: "${t.text}"` : 'Expected a theme name like "Dark Modern", or _');
  }

  // ---- selector expressions: struct, language(python), text(...), contains(...), @name, side by side, ! | ( )

  const isHeadStart = (t: Token | undefined) => t?.type === "ident" || t?.type === "at" || t?.type === "var" || isPunct(t, "*") || isPunct(t, "!") || isPunct(t, "(");

  function parseCond(): Cond {
    let left = parseCondAnd();
    while (isPunct(peek(), "|")) {
      next();
      const right = parseCondAnd();
      left = { kind: "or", left, right, range: span(left.range, right.range) };
    }
    return left;
  }

  function parseCondAnd(): Cond {
    let left = parseCondUnary();
    // Side by side on one line means both: text("__slots__") variable.classMember.
    const adjacent = () => isHeadStart(peek()) && sameLine(tokens[i - 1], peek());
    while (isPunct(peek(), "&") || adjacent()) {
      if (isPunct(peek(), "&")) next();
      const right = parseCondUnary();
      left = { kind: "and", left, right, range: span(left.range, right.range) };
    }
    return left;
  }

  // The comma-separated list inside language(...) / text(...), after the "(".
  function parseList(type: "ident" | "string", what: string): string[] {
    const items: string[] = [];
    do {
      const x = peek();
      if (x?.type !== type) fail(`Expected ${what}`);
      next();
      if (!x.text) problems.push({ range: x.range, message: `Expected ${what}` });
      else items.push(x.text);
    } while (isPunct(peek(), ",") && next());
    return items;
  }

  function parseCondUnary(): Cond {
    const t = peek();
    if (isPunct(t, "!")) {
      next();
      const operand = parseCondUnary();
      return { kind: "not", operand, range: span(t.range, operand.range) };
    }
    if (isPunct(t, "(")) {
      next();
      const c = parseCond();
      expect(")");
      return c;
    }
    if (t?.type === "at") {
      next();
      if (!t.text) fail("Expected an expression name after '@'", t);
      return { kind: "name", name: t.text, range: t.range };
    }
    if (t?.type === "var") fail(`$${t.text} is a color; named selector expressions start with @: @${t.text || "name"} => ...`, t);
    const call = (name: string) => t?.type === "ident" && t.text === name && isPunct(peek(1), "(");
    if (call("text")) {
      next();
      next();
      const globs = parseList("string", 'the token text in quotes, e.g. text("__slots__")');
      const close = expect(")", "')' to close text(...)");
      return { kind: "text", globs, range: span(t.range, close.range) };
    }
    if (call("language")) {
      next();
      next();
      const ids = parseList("ident", "a language id like python");
      const close = expect(")", "')' to close language(...)");
      return { kind: "language", ids, range: span(t.range, close.range) };
    }
    for (const kind of ["contains", "within", "inherits"] as const) {
      if (!call(kind)) continue;
      next();
      next();
      const inner = parseCond();
      const close = expect(")", `')' to close ${kind}(...)`);
      return { kind, inner, range: span(t.range, close.range) };
    }
    if (t?.type === "ident" || isPunct(t, "*")) {
      next();
      if (!/^(\*|[A-Za-z_][\w-]*)(\.[A-Za-z_][\w-]*)*(:[\w-]+)?$/.test(t.text)) {
        problems.push({ range: t.range, message: "Selectors look like 'struct', 'variable.readonly', '*.static' or 'parameter:python'" });
      }
      return { kind: "selector", selector: t.text, range: t.range };
    }
    return fail("Expected a selector, text(...), language(...), contains(...), within(...), inherits(...), @expression, '!' or '('");
  }

  // ---- color expressions

  function parseExpr(): Expr {
    const t = peek();
    if (!t) return fail("Expected a color");
    if (isMatchStart()) {
      return parseMatch<Expr>(parseExpr, (start, subject, arms, end) => ({ kind: "match", subject, arms, range: span(start, end) }));
    }
    switch (t.type) {
      case "hex": {
        next();
        const value = parseHex(t.text);
        if (!value) fail(`Invalid color '${t.text}'`, t);
        return { kind: "color", value: value!, range: t.range };
      }
      case "var":
        next();
        if (t.text === "none") fail("$none can only be used as a whole value, e.g. enum = $none", t);
        if (t.text === "theme" || t.text === "type") fail(`$${t.text} is not a color; use it with match`, t);
        if (!t.text) fail("Expected a variable name after '$'", t);
        return { kind: "var", name: t.text, range: t.range };
      case "num":
        next();
        return {
          kind: "num",
          value: parseFloat(t.text),
          unit: t.text.endsWith("%") ? "percent" : /deg$|°$/.test(t.text) ? "deg" : "none",
          decimal: t.text.includes("."),
          range: t.range,
        };
      case "ident": {
        next();
        // "ui editor.background": a name of an explicit kind.
        if (isNameKind(t.text) && peek()?.type === "ident" && sameLine(t, peek())) {
          const name = next();
          if (isPunct(peek(), "(")) fail(`${t.text} applies to a name, not to a function call`, t);
          return { kind: "ref", name: name.text, target: t.text, range: span(t.range, name.range) };
        }
        if (!isPunct(peek(), "(")) {
          if (t.text === "_") fail("'_' is only valid as a match pattern", t);
          return { kind: "ref", name: t.text, range: t.range };
        }
        if (t.text === "style") fail("style() must wrap the whole value, e.g. style(mix(class, function), bold)", t);
        if (!FUNCTION_NAMES.has(t.text)) {
          const flagNext = peek(1) && (isPunct(peek(1), "!") || (peek(1).type === "ident" && STYLE_NAMES.has(peek(1).text)));
          if (["text", "language", "contains", "within", "inherits"].includes(t.text)) {
            fail(`${t.text}(...) is part of a selector expression, not a color; name one with @name => ${t.text}(...)`, t);
          }
          fail(`Unknown function '${t.text}'${flagNext ? `. For font styles write style(${t.text}, ...)` : ""}`, t);
        }
        const open = next();
        // "mix(class," followed by a new statement: report the unclosed call, not the next line.
        const unclosed = () => {
          const n = peek();
          if (n && n.range.start.line > tokens[i - 1].range.end.line && isPunct(peek(1), "=")) {
            fail(`Unclosed '(' in ${t.text}()`, open);
          }
        };
        const args: Expr[] = [];
        // Arguments that are $type conditions ("light & !contrast") rather than colors.
        const parseArg = (): Expr => {
          if (CONDITION_ARGS[t.text] !== args.length) return parseExpr();
          const pattern = parsePattern("type");
          return { kind: "condition", pattern, range: pattern.range };
        };
        unclosed();
        if (!isPunct(peek(), ")")) {
          args.push(parseArg());
          while (isPunct(peek(), ",")) {
            next();
            unclosed();
            args.push(parseArg());
          }
        }
        unclosed();
        const close = expect(")");
        return { kind: "call", fn: t.text, args, range: span(t.range, close.range), nameRange: t.range };
      }
      default:
        return fail(`Unexpected '${t.text}'`);
    }
  }

  function parseFlags(): StyleFlag[] {
    const flags: StyleFlag[] = [];
    do {
      let on = true;
      if (isPunct(peek(), "!")) {
        next();
        on = false;
      }
      const t = peek();
      if (t?.type !== "ident" || !STYLE_NAMES.has(t.text)) fail("Expected a style: bold, italic, underline, strikethrough");
      next();
      flags.push({ name: t.text as StyleFlag["name"], on });
    } while (isPunct(peek(), "|") && next());
    return flags;
  }

  // ---- values (top level of a rule: may be $none, style(), match)

  function parseValue(): Value {
    const t = peek();
    if (!t) return fail("Expected a value");
    if (t.type === "var" && t.text === "none") {
      next();
      return { kind: "none", range: t.range };
    }
    if (isMatchStart()) {
      return parseMatch<Value>(parseValue, (start, subject, arms, end) => ({ kind: "match", subject, arms, range: span(start, end) }));
    }
    if (t.type === "ident" && t.text === "style" && isPunct(peek(1), "(")) {
      next();
      next();
      const isFlag = (x?: Token) => isPunct(x, "!") || (x?.type === "ident" && STYLE_NAMES.has(x.text) && !isPunct(peek(1), "("));
      let color: Expr | undefined;
      if (!isFlag(peek())) {
        color = parseExpr();
        if (color.kind === "num") fail("Expected a color, not a number", { ...t, range: color.range });
        if (isPunct(peek(), ")")) fail("style() needs styles after the color, e.g. style(class, bold)");
        expect(",");
      }
      const flags = parseFlags();
      const close = expect(")");
      return { kind: "style", color, flags, range: span(t.range, close.range) };
    }
    const expr = parseExpr();
    if (expr.kind === "num") fail("Expected a color, not a number", { ...t, range: expr.range });
    return { kind: "expr", expr, range: expr.range };
  }

  function parseMatch<T>(
    parseBody: () => T,
    build: (start: Range, subject: Subject, arms: Arm<T>[], end: Range) => T,
  ): T {
    const kw = next();
    next();
    const subj = next();
    if (subj?.type !== "var" || (subj.text !== "type" && subj.text !== "theme")) fail("match works on $type or $theme", subj);
    const subject = subj.text as Subject;
    expect(")", "')' after the match subject");
    expect("{");
    const arms: Arm<T>[] = [];
    while (peek() && !isPunct(peek(), "}")) {
      const pattern = parsePattern(subject);
      expect("->", "'->' and a value");
      arms.push({ pattern, body: parseBody() });
      expectBreak(true);
    }
    const close = expect("}", "'}' to close the match");
    if (!arms.length) problems.push({ range: span(kw.range, close.range), message: "match has no arms", warning: true });
    checkArms(subject, arms, true);
    return build(kw.range, subject, arms, close.range);
  }

  // ---- statements

  function parseBlock(): Block {
    const kw = next();
    next();
    const subj = next();
    if (subj?.type !== "var" || (subj.text !== "type" && subj.text !== "theme")) fail("match works on $type or $theme", subj);
    const subject = subj.text as Subject;
    expect(")", "')' after the match subject");
    expect("{");
    const arms: Arm<Stmt[]>[] = [];
    while (peek() && !isPunct(peek(), "}")) {
      const pattern = parsePattern(subject);
      expect("{", "'{' and rules for this arm");
      arms.push({ pattern, body: parseStatements(false) });
      expect("}", "'}' to close the arm");
      expectBreak(false);
    }
    const close = expect("}", "'}' to close the match");
    checkArms(subject, arms, false);
    return { kind: "block", subject, arms, range: span(kw.range, close.range) };
  }

  // $variables and @expressions; true when the name can be declared.
  function declare(t: Token, topLevel: boolean, what: "variable" | "expression"): boolean {
    const sigil = what === "variable" ? "$" : "@";
    const first = (what === "variable" ? variables : expressions).get(t.text)?.nameRange;
    if (!t.text) {
      problems.push({ range: t.range, message: `Expected a${what === "variable" ? "" : "n"} ${what} name after '${sigil}'` });
    } else if (what === "variable" && BUILTINS.has(t.text)) {
      problems.push({ range: t.range, message: `$${t.text} is provided and can't be assigned` });
    } else if (!topLevel) {
      problems.push({
        range: t.range,
        message: what === "variable"
          ? "Variables can only be declared at the top level; use a match value instead: $x = match($type) { ... }"
          : "Expressions can only be declared at the top level",
      });
    } else if (first) {
      problems.push({ range: t.range, message: `${sigil}${t.text} is already assigned on line ${first.start.line + 1}; ${what}s can only be assigned once` });
    } else {
      return true;
    }
    return false;
  }

  function parseStatement(topLevel: boolean): Stmt {
    const t = peek();
    if (t.type === "var" && isPunct(peek(1), "=")) {
      next();
      next();
      const value = parseExpr();
      const decl: VarDecl = { kind: "var", name: t.text, nameRange: t.range, value };
      if (declare(t, topLevel, "variable")) variables.set(t.text, decl);
      return decl;
    }
    // "@name => head"; "@name = value" and "@name head = value" are rules.
    if (t.type === "at" && isPunct(peek(1), "=>")) {
      next();
      next();
      const decl: ExpressionDecl = { kind: "expression", name: t.text, nameRange: t.range, cond: parseCond() };
      if (declare(t, topLevel, "expression")) expressions.set(t.text, decl);
      return decl;
    }
    if (isMatchStart()) return parseBlock();
    // "override { rules }" or "override <statement>"; "override = ..." is a rule for a token named override.
    if (t.type === "ident" && t.text === "override" && peek(1) && !isPunct(peek(1), "=")) {
      next();
      if (overrideDepth > 0) {
        problems.push({ range: t.range, message: "Already inside an override block", warning: true });
      }
      overrideDepth++;
      try {
        if (isPunct(peek(), "{")) {
          next();
          const body = parseStatements(false);
          const close = expect("}", "'}' to close the override block");
          return { kind: "override", body, range: span(t.range, close.range) };
        }
        if (!sameLine(t, peek())) fail("Expected '{' or a rule after override", t);
        const body = parseStatement(false);
        return { kind: "override", body: [body], range: t.range };
      } finally {
        overrideDepth--;
      }
    }
    // "ui { rules }" or "ui <statement>", likewise semantic and textmate.
    if (t.type === "ident" && isNameKind(t.text) && peek(1) && !isPunct(peek(1), "=")) {
      next();
      if (target && target.kind !== t.text) {
        fail(`Already inside ${target.kind} (line ${target.range.start.line + 1}); a name can only be one kind`, t);
      }
      if (target) problems.push({ range: t.range, message: `Already inside ${t.text}`, warning: true });
      const outer = target;
      target = { kind: t.text, range: t.range };
      try {
        if (isPunct(peek(), "{")) {
          next();
          const body = parseStatements(false);
          const close = expect("}", `'}' to close the ${t.text} block`);
          return { kind: "target", target: t.text, body, range: span(t.range, close.range) };
        }
        if (!sameLine(t, peek())) fail(`Expected '{' or a rule after ${t.text}`, t);
        return { kind: "target", target: t.text, body: [parseStatement(false)], range: t.range };
      } finally {
        target = outer;
      }
    }
    // "head = value" or "head { rules }"; a block's head and the heads inside must all hold.
    if (isHeadStart(t)) {
      const head = parseCond();
      const n = peek();
      if (isPunct(n, "{")) {
        next();
        const outer = when;
        when = outer ? { kind: "and", left: outer, right: head, range: head.range } : head;
        try {
          const body = parseStatements(false);
          const end = expect("}", "'}' to close the block");
          return { kind: "when", cond: head, body, range: span(head.range, end.range) };
        } finally {
          when = outer;
        }
      }
      if (isPunct(n, "=")) {
        next();
        return { kind: "rule", head, selector: conditionText(stripCondition(head)), selectorRange: head.range, target: target?.kind, when, value: parseValue() };
      }
      if (isPunct(n, "+=")) {
        next();
        const modifiers: string[] = [];
        do {
          const m = peek();
          if (m?.type !== "ident" || !sameLine(tokens[i - 1], m) || !/^[A-Za-z_][\w-]*$/.test(m.text)) {
            fail("Expected a modifier name like slotted", m && sameLine(tokens[i - 1], m) ? m : tokens[i - 1]);
          }
          next();
          modifiers.push(m.text);
        } while (isPunct(peek(), ",") && next());
        return { kind: "tag", head, selector: conditionText(stripCondition(head)), selectorRange: head.range, target: target?.kind, when, modifiers };
      }
      return fail(`Expected '=' or '+=' after '${conditionText(stripCondition(head))}'`, n && sameLine(tokens[i - 1], n) ? n : tokens[i - 1]);
    }
    return fail("Expected a rule (selector = value), a variable ($name = value), an expression (@name => head), a match, or an override / ui / semantic / textmate block");
  }

  function parseStatements(topLevel: boolean): Stmt[] {
    const stmts: Stmt[] = [];
    const seen = new Map<string, Rule>();
    while (peek() && !(isPunct(peek(), "}") && !topLevel)) {
      const startDepth = depth;
      const startIndex = i;
      try {
        if (topLevel && isPunct(peek(), "}")) fail("Unexpected '}'");
        const st = parseStatement(topLevel);
        stmts.push(st);
        if (st.kind === "rule") {
          const key = st.when ? `${conditionText(stripCondition(st.when))} ${st.selector}` : st.selector;
          const prev = seen.get(key);
          if (prev) {
            problems.push({
              range: st.selectorRange,
              message: `'${key}' is already set on line ${prev.selectorRange.start.line + 1} in this block; this one wins`,
              warning: true,
            });
          }
          seen.set(key, st);
        }
        expectBreak(false);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        problems.push({ range: e.range, message: e.message });
        recover(startDepth, startIndex, e.range.start.line);
      }
    }
    return stmts;
  }

  // Static checks for $type arms: impossible, unreachable, not exhaustive.
  function checkArms<T>(subject: Subject, arms: Arm<T>[], isValue: boolean) {
    if (subject !== "type") return;
    const covered = new Set<number>();
    for (const arm of arms) {
      const kinds = THEME_KINDS.map((f, k) => (matchesPattern(arm.pattern, f, "") ? k : -1)).filter((k) => k >= 0);
      if (!kinds.length) {
        problems.push({ range: arm.pattern.range, message: "This pattern can never match (a theme is either dark or light)", warning: true });
      } else if (kinds.every((k) => covered.has(k))) {
        problems.push({ range: arm.pattern.range, message: "Never reached: earlier arms already cover these themes", warning: true });
      }
      kinds.forEach((k) => covered.add(k));
    }
    if (isValue && arms.length && covered.size < THEME_KINDS.length) {
      const missing = THEME_KINDS.filter((_, k) => !covered.has(k)).map((f) => [...f].join(" & "));
      problems.push({
        range: arms[0].pattern.range,
        message: `Not all theme types are covered (${missing.join(", ")}); add '_ -> ...' or the value is skipped there`,
        warning: true,
      });
    }
  }

  // ---- @name in heads: replaced by the declared expression, which may come later in the file

  const resolved = new Map<string, Cond | undefined>();
  const resolving = new Set<string>();
  const used = new Set<string>();

  // The declaration's head with its names resolved, once per declaration.
  function lookup(decl: ExpressionDecl): Cond | undefined {
    if (!resolved.has(decl.name)) {
      resolving.add(decl.name);
      resolved.set(decl.name, resolve(decl.cond));
      resolving.delete(decl.name);
    }
    return resolved.get(decl.name);
  }

  // The head with every @name replaced; undefined (and reported) when a name can't be.
  function resolve(c: Cond): Cond | undefined {
    switch (c.kind) {
      case "name": {
        used.add(c.name);
        const decl = expressions.get(c.name);
        if (!decl) {
          problems.push({ range: c.range, message: `Unknown expression @${c.name}; declare it with @${c.name} => ...` });
          return undefined;
        }
        if (resolving.has(c.name)) {
          problems.push({ range: c.range, message: `@${c.name} refers to itself` });
          return undefined;
        }
        // Problems with the whole head point at the use; those of its parts at the declaration.
        const cond = lookup(decl);
        return cond && { ...cond, range: c.range };
      }
      case "contains":
      case "within":
      case "inherits": {
        const inner = resolve(c.inner);
        return inner && { ...c, inner };
      }
      case "not": {
        const operand = resolve(c.operand);
        return operand && { ...c, operand };
      }
      case "and":
      case "or": {
        const left = resolve(c.left);
        const right = resolve(c.right);
        return left && right && { ...c, left, right };
      }
      default:
        return c;
    }
  }

  // Statements whose head can't be resolved are dropped; the problem is already reported.
  function resolveAll(stmts: Stmt[]): Stmt[] {
    return stmts.flatMap((st): Stmt[] => {
      switch (st.kind) {
        case "rule":
        case "tag": {
          const head = resolve(st.head);
          const when = st.when && resolve(st.when);
          return head && (!st.when || when) ? [{ ...st, head, when }] : [];
        }
        case "when": {
          const cond = resolve(st.cond);
          return cond ? [{ ...st, cond, body: resolveAll(st.body) }] : [];
        }
        case "expression": {
          // A declaration that failed (assigned twice, not top level) is dropped.
          const cond = expressions.get(st.name) === st ? lookup(st) : undefined;
          return cond ? [{ ...st, cond }] : [];
        }
        case "override":
        case "target":
          return [{ ...st, body: resolveAll(st.body) }];
        case "block":
          return [{ ...st, arms: st.arms.map((a) => ({ ...a, body: resolveAll(a.body) })) }];
        default:
          return [st];
      }
    });
  }

  const stmts = resolveAll(parseStatements(true));
  for (const [name, decl] of expressions) {
    if (!used.has(name)) problems.push({ range: decl.nameRange, message: `@${name} is never used`, warning: true });
    const cond = resolved.get(name);
    if (cond) expressions.set(name, { ...decl, cond });
    else expressions.delete(name);
  }
  return { stmts, variables, expressions, problems };
}

export const DEFAULT_RULES = `; Semantic Theme Extender rules. Save (Ctrl+S) to apply; synced via Settings Sync.
;
;   selector = value         e.g. struct = hue(class, -35); skipped where the theme has a rule for exactly it
;                            semantic selectors also set their TextMate fallback scope;
;                            other dotted names are TextMate scopes: string.quoted.docstring.python = #6A9955
;   editorCursor.foreground  UI color IDs are UI colors: editorBracketHighlight.foreground1 = soften(keyword)
;   struct | enum = ...                 several selectors; language(python) x means x:python
;   text("__slots__") variable.classMember = ...   only tokens with that text, * as wildcard
;   contains(text("__slots__") variable.classMember) class = ...   classes with such a member
;   language(python, csharp) { rules }  semantic rules per language; inside, * alone means every type
;   ui | semantic | textmate say the kind instead of inferring it: textmate comment = #6A9955,
;                            semantic struct = ... (no TextMate fallback), ui { rules }, ui editor.background
;   override rule            also replaces the theme's own color; override { rules } for several
;   $name = color            variable: top level, assigned once, use as $name
;   head += slotted          custom modifiers for matching tokens; class.slotted = ... colors them,
;                            in any rules file (variable, string, comment, keyword: *.slotted)
;   @name => head            a named selector expression, used in heads: @name class = ...
;
;   class, function, ...     the active theme's color for a semantic token type
;   variable.language        the active theme's color for a TextMate scope (names with a dot)
;   editor.background        the active theme's UI color
;   functions    offset(c, base, target[, condition]): apply the change from base to target;
;                the lightness change flips where the condition holds, e.g. light
;                emphasize soften (contrast to the background), lighten darken
;                saturate desaturate (amount in %), hue (degrees), mix(a, b, 0.5),
;                alpha(c, 50%), rgb(r, g, b[, a])
;   style(c, bold | !italic)  font styles; style(underline) keeps the color
;   $none                    no rule for this selector
;
;   match($type)  { dark & contrast -> ...   light -> ...   _ -> ... }    flags: dark light contrast
;   match($theme) { "Dark Modern" | "*Light*" { rules } }                 a block of rules
;   later rules override earlier ones for the same selector

; Visual Studio's relation between class and the other type colors, measured on its dark theme:
; exact on Dark Modern / Dark+, carried over to any other theme, flipped in lightness on light ones.
struct        = offset(class, #4EC9B0, #86C691, light)
interface     = offset(class, #4EC9B0, #B8D7A3, light)
enum          = offset(class, #4EC9B0, #B8D7A3, light)
typeParameter = offset(class, #4EC9B0, #B8D7A3, light)

selfParameter:python = variable.language
clsParameter:python  = variable.language
`;
