// Parser for rules files.
//
//   ; comment
//   $name = color                      variable: top level only, assigned once, usable anywhere
//   selector = value                   rule; skipped where the theme colors the token itself
//   override rule | override { rules }  rules that also replace the theme's own colors
//   match $type { dark & contrast { rules } _ { rules } }      block: rules for matching themes
//
// Later rules in the file override earlier ones for the same selector.
//   value: color | style(color, bold | !italic) | $none | match $type { dark -> value  _ -> value }
//
// Keywords are only recognized where a token name could not stand: "match" must be followed by
// a $subject, "style" by "(", "override" by "{" or a statement, and a selector by "=".

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
  | { kind: "ref"; name: string; range: Range }
  | { kind: "num"; value: number; unit: NumUnit; decimal: boolean; range: Range }
  | { kind: "call"; fn: string; args: Expr[]; range: Range; nameRange: Range }
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

export interface Rule {
  kind: "rule";
  selector: string;
  selectorRange: Range;
  value: Value;
}

export interface Override {
  kind: "override";
  body: Stmt[];
  range: Range;
}

export interface Block {
  kind: "block";
  subject: Subject;
  arms: Arm<Stmt[]>[];
  range: Range;
}

export type Stmt = VarDecl | Rule | Block | Override;

export interface RulesFile {
  stmts: Stmt[];
  variables: Map<string, VarDecl>;
  problems: Problem[];
}

export type Flag = "dark" | "light" | "contrast";
export const FLAGS: Flag[] = ["dark", "light", "contrast"];
export const BUILTINS = new Set(["theme", "type", "none"]);
export const STYLE_NAMES = new Set(["bold", "italic", "underline", "strikethrough"]);
/** Color functions other than style(); kept in sync with FUNCTIONS in rules.ts. */
export const FUNCTION_NAMES = new Set(["emphasize", "soften", "lighten", "darken", "saturate", "desaturate", "hue", "mix", "alpha", "rgb", "rgba"]);

/** The four theme kinds as flag sets, for static pattern checks. */
export const THEME_KINDS: Set<Flag>[] = [
  new Set(["dark"]),
  new Set(["light"]),
  new Set(["dark", "contrast"]),
  new Set(["light", "contrast"]),
];

export function flagsForUiTheme(uiTheme: string): Set<Flag> {
  switch (uiTheme) {
    case "vs":
      return new Set(["light"]);
    case "hc-black":
      return new Set(["dark", "contrast"]);
    case "hc-light":
      return new Set(["light", "contrast"]);
    default:
      return new Set(["dark"]);
  }
}

export function matchesPattern(p: Pattern, flags: Set<Flag>, themeId: string): boolean {
  switch (p.kind) {
    case "any":
      return true;
    case "flag":
      return flags.has(p.flag);
    case "name":
      return new RegExp(`^${p.glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i").test(themeId);
    case "not":
      return !matchesPattern(p.operand, flags, themeId);
    case "and":
      return matchesPattern(p.left, flags, themeId) && matchesPattern(p.right, flags, themeId);
    case "or":
      return matchesPattern(p.left, flags, themeId) || matchesPattern(p.right, flags, themeId);
  }
}

// ---------------------------------------------------------------------------------------------

type TokenType = "hex" | "var" | "ident" | "num" | "string" | "punct";

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
  /(#[0-9a-fA-F]+)|\$([\w-]*)|((?:\*(?=\.)|[A-Za-z_])(?:[\w.:]|-(?=\w))*)|([+-]?(?:\d+\.?\d*|\.\d+)(?:%|deg\b|°)?)|("[^"\n]*"?)|(\?=|->|[=(),!|&{}*])/y;

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
        problems.push({
          range: range(1),
          message: c === "@" ? "'@' is not needed: theme colors are plain names, e.g. 'class'" : `Unexpected character '${c}'`,
        });
        col++;
        continue;
      }
      const [all, hex, v, ident, num, str] = m;
      const type: TokenType =
        hex !== undefined ? "hex" : v !== undefined ? "var" : ident !== undefined ? "ident" : num !== undefined ? "num" : str !== undefined ? "string" : "punct";
      if (type === "string" && !all.endsWith('"') || all === '"') {
        problems.push({ range: range(all.length), message: "Unclosed string" });
      }
      tokens.push({ type, text: type === "var" ? v : type === "string" ? all.replace(/^"|"$/g, "") : all, range: range(all.length) });
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
  let i = 0;
  let depth = 0; // braces consumed so far, for error recovery
  let overrideDepth = 0;

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
  const isMatchStart = () => peek()?.type === "ident" && peek().text === "match" && peek(1)?.type === "var";

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
        if (!isPunct(peek(), "(")) {
          if (t.text === "_") fail("'_' is only valid as a match pattern", t);
          return { kind: "ref", name: t.text, range: t.range };
        }
        if (t.text === "style") fail("style() must wrap the whole value, e.g. style(mix(class, function), bold)", t);
        if (!FUNCTION_NAMES.has(t.text)) {
          const flagNext = peek(1) && (isPunct(peek(1), "!") || (peek(1).type === "ident" && STYLE_NAMES.has(peek(1).text)));
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
        unclosed();
        if (!isPunct(peek(), ")")) {
          args.push(parseExpr());
          while (isPunct(peek(), ",")) {
            next();
            unclosed();
            args.push(parseExpr());
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
    const subj = next();
    if (subj.text !== "type" && subj.text !== "theme") fail("match works on $type or $theme", subj);
    const subject = subj.text as Subject;
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
    const subj = next();
    if (subj.text !== "type" && subj.text !== "theme") fail("match works on $type or $theme", subj);
    const subject = subj.text as Subject;
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

  function parseStatement(topLevel: boolean): Stmt {
    const t = peek();
    if (t.type === "var" && isPunct(peek(1), "=")) {
      next();
      next();
      const value = parseExpr();
      const decl: VarDecl = { kind: "var", name: t.text, nameRange: t.range, value };
      if (!t.text) {
        problems.push({ range: t.range, message: "Expected a variable name after '$'" });
      } else if (BUILTINS.has(t.text)) {
        problems.push({ range: t.range, message: `$${t.text} is provided and can't be assigned` });
      } else if (!topLevel) {
        problems.push({ range: t.range, message: "Variables can only be declared at the top level; use a match value instead: $x = match $type { ... }" });
      } else if (variables.has(t.text)) {
        const first = variables.get(t.text)!;
        problems.push({ range: t.range, message: `$${t.text} is already assigned on line ${first.nameRange.start.line + 1}; variables can only be assigned once` });
      } else {
        variables.set(t.text, decl);
      }
      return decl;
    }
    if (isMatchStart()) return parseBlock();
    // "override { rules }" or "override <statement>"; "override = ..." is a rule for a token named override.
    if (t.type === "ident" && t.text === "override" && peek(1) && !isPunct(peek(1), "=") && !isPunct(peek(1), "?=")) {
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
    if (t.type === "ident" && isPunct(peek(1), "?=")) {
      fail("'?=' is not needed: '=' already only fills what the theme leaves; put rules that replace theme colors in override { }", peek(1));
    }
    if (t.type === "ident" && isPunct(peek(1), "=")) {
      next();
      next();
      if (!/^(\*|[A-Za-z_][\w-]*)(\.[A-Za-z_][\w-]*)*(:[\w-]+)?$/.test(t.text)) {
        problems.push({ range: t.range, message: "Selectors look like 'struct', 'variable.readonly', '*.static' or 'parameter:python'" });
      }
      return { kind: "rule", selector: t.text, selectorRange: t.range, value: parseValue() };
    }
    if (isPunct(t, "*") && isPunct(peek(1), "=")) {
      return fail("Selectors with '*' need a modifier, e.g. '*.static'");
    }
    const after = sameLine(t, peek(1)) ? peek(1) : t;
    if (t.type === "var") return fail(`Expected '=' after $${t.text}`, after);
    if (t.type === "ident") return fail(`Expected '=' after '${t.text}'`, after);
    return fail("Expected a rule (selector = value), a variable ($name = value), a match or an override block");
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
          const prev = seen.get(st.selector);
          if (prev) {
            problems.push({
              range: st.selectorRange,
              message: `'${st.selector}' is already set on line ${prev.selectorRange.start.line + 1} in this block; this one wins`,
              warning: true,
            });
          }
          seen.set(st.selector, st);
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

  const stmts = parseStatements(true);
  return { stmts, variables, problems };
}

export const DEFAULT_RULES = `; Semantic Theme Extender rules. Save (Ctrl+S) to apply; synced via Settings Sync.
;
;   selector = value         e.g. struct = hue(class, -35); skipped where the theme colors it itself
;   override rule            also replaces the theme's own color; override { rules } for several
;   $name = color            variable: top level, assigned once, use as $name
;
;   class, function, ...     the active theme's color for a semantic token type
;   variable.language        the active theme's color for a TextMate scope (names with a dot)
;   functions    emphasize soften (contrast to the background), lighten darken
;                saturate desaturate (amount in %), hue (degrees), mix(a, b, 0.5),
;                alpha(c, 50%), rgb(r, g, b[, a])
;   style(c, bold | !italic)  font styles; style(underline) keeps the color
;   $none                    no rule for this selector
;
;   match $type  { dark & contrast -> ...   light -> ...   _ -> ... }    flags: dark light contrast
;   match $theme { "Dark Modern" | "*Light*" { rules } }                 a block of rules
;   later rules override earlier ones for the same selector

struct        = hue(class, -35)
interface     = mix(class, function, 0.5)
enum          = mix(class, function, 0.5)
typeParameter = mix(class, function, 0.5)

selfParameter:python = variable.language
clsParameter:python  = variable.language
`;
