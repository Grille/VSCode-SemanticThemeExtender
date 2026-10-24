// Evaluates a parsed rules file against the active theme.
//
// Two passes: a check pass evaluates every expression in every match arm (for diagnostics and
// swatches), and an apply pass walks only the arms that match the active theme to produce rules.
// Rules skip selectors the theme colors itself, unless they are inside an override block.
//
// A semantic selector (struct, variable.readonly) produces a semantic rule plus TextMate rules for
// the scopes VS Code falls back to, so the color also shows before the language server is ready.
// Any other name (string.quoted.docstring.python) is a TextMate scope and only produces that.
// colors.<id> (colors.editorBracketHighlight.foreground1) is a UI color of the theme.

import { Expr, Flag, matchesPattern, Problem, Range, RulesFile, Stmt, Value, VarDecl } from "./cfg";
import { Color, parseHex, toHex } from "./color";
import { CycleError, EvalContext, EvalError, evaluateColor, NoMatch } from "./rules";
import { isUiColor, ThemeResolver, UI_PREFIX } from "./theme";

export type StyleValue =
  | string
  | { foreground?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean };

export interface TextMateSettings {
  foreground?: string;
  fontStyle?: string;
}

export interface ColorSpan {
  range: Range;
  color: Color;
  /** True when the span is a literal hex color that a color picker may rewrite. */
  literal: boolean;
}

export interface CompileResult {
  rules: Record<string, StyleValue>;
  /** TextMate scope -> settings, for editor.tokenColorCustomizations. */
  textMate: Record<string, TextMateSettings>;
  /** UI color ID -> color, for workbench.colorCustomizations. */
  ui: Record<string, string>;
  log: string[];
  problems: Problem[];
  colors: ColorSpan[];
  variables: Map<string, Color>;
  flags: Set<Flag>;
}

const NONE = Symbol("none");

const FONT_STYLES = ["italic", "bold", "underline", "strikethrough"] as const;

// TextMate has a single fontStyle string, so style flags replace the whole style there.
function toTextMate(value: StyleValue): TextMateSettings {
  if (typeof value === "string") return { foreground: value };
  const settings: TextMateSettings = value.foreground ? { foreground: value.foreground } : {};
  if (FONT_STYLES.some((f) => value[f] !== undefined)) {
    settings.fontStyle = FONT_STYLES.filter((f) => value[f]).join(" ");
  }
  return settings;
}

export function compile(file: RulesFile, resolver: ThemeResolver): CompileResult {
  const flags = resolver.flags;
  const result: CompileResult = { rules: {}, textMate: {}, ui: {}, log: [], problems: [...file.problems], colors: [], variables: new Map(), flags };
  const registry = resolver.registry;
  const failed = new Set<string>();
  const resolving = new Set<string>();
  const themeId = resolver.theme.id;

  const ctx: EvalContext = {
    flags,
    themeId,
    variable(name, range) {
      const known = result.variables.get(name);
      if (known) return known;
      const decl = file.variables.get(name);
      if (!decl) throw new EvalError(`Unknown variable '$${name}'`, range);
      if (failed.has(name)) throw new EvalError(`$${name} has an error`, range);
      if (resolving.has(name)) throw new CycleError(`$${name} refers to itself`, range);
      resolving.add(name);
      try {
        const c = evaluateColor(decl.value, ctx);
        result.variables.set(name, c);
        return c;
      } catch (e) {
        failed.add(name);
        if (e instanceof CycleError) throw e;
        if (e instanceof NoMatch) throw new EvalError(`$${name} has no value for '${themeId}' (no match arm applies)`, range);
        throw new EvalError(`$${name} has an error`, range);
      } finally {
        resolving.delete(name);
      }
    },
    ref(name, range) {
      let r;
      try {
        r = resolver.resolve(name);
      } catch (e) {
        throw new EvalError((e as Error).message, range);
      }
      const c = parseHex(r.color);
      if (!c) throw new EvalError(`Theme color for '${name}' is not a hex color: ${r.color}`, range);
      return c;
    },
    background() {
      return parseHex(resolver.background) ?? parseHex(resolver.theme.dark ? "#1E1E1E" : "#FFFFFF")!;
    },
  };

  const report = (e: unknown) => {
    if (e instanceof EvalError) result.problems.push({ range: e.range, message: e.message });
    else if (!(e instanceof NoMatch)) throw e;
  };

  // ---- check pass

  // Evaluates every arm (for swatches and errors) and returns the value for the active theme.
  const checkExpr = (e: Expr): Color | undefined => {
    if (e.kind === "match") {
      const values = e.arms.map((a) => checkExpr(a.body));
      const active = e.arms.findIndex((a) => matchesPattern(a.pattern, flags, themeId));
      return active >= 0 ? values[active] : undefined;
    }
    try {
      const color = evaluateColor(e, ctx);
      result.colors.push({ range: e.range, color, literal: e.kind === "color" });
      return color;
    } catch (err) {
      report(err);
      return undefined;
    }
  };

  // Fills the variable cache, so variables used later aren't evaluated a second time.
  const checkVariable = (decl: VarDecl) => {
    const cached = result.variables.get(decl.name);
    if (cached && decl.value.kind !== "match") {
      // Already evaluated through a use earlier in the file; only the swatch is missing.
      result.colors.push({ range: decl.value.range, color: cached, literal: decl.value.kind === "color" });
      return;
    }
    const color = checkExpr(decl.value);
    // Only the registered definition counts; repeated assignments are already errors.
    if (color && file.variables.get(decl.name) === decl && !cached) {
      result.variables.set(decl.name, color);
    }
  };

  const checkValue = (v: Value) => {
    if (v.kind === "style") v.color && checkExpr(v.color);
    else if (v.kind === "match") v.arms.forEach((a) => checkValue(a.body));
    else if (v.kind === "expr") checkExpr(v.expr);
  };

  const hasStyle = (v: Value): boolean => v.kind === "style" || (v.kind === "match" && v.arms.some((a) => hasStyle(a.body)));

  const check = (stmts: Stmt[]) => {
    for (const st of stmts) {
      if (st.kind === "var") checkVariable(st);
      else if (st.kind === "rule") {
        if (!registry.isValidName(st.selector)) {
          const message = registry.unknownNameMessage(st.selector);
          result.problems.push({
            range: st.selectorRange,
            message: message.startsWith("Unknown token type")
              ? `${message}: this rule has no effect. TextMate scopes contain a dot, e.g. string.quoted`
              : `${message}; this rule has no effect`,
            warning: true,
          });
        }
        if (isUiColor(st.selector) && hasStyle(st.value)) {
          result.problems.push({ range: st.selectorRange, message: "UI colors take a color; style() only applies to tokens" });
        }
        checkValue(st.value);
      } else if (st.kind === "override") check(st.body);
      else st.arms.forEach((a) => check(a.body));
    }
  };
  check(file.stmts);

  // ---- apply pass

  const evalValue = (v: Value): StyleValue | typeof NONE | undefined => {
    switch (v.kind) {
      case "none":
        return NONE;
      case "match": {
        const arm = v.arms.find((a) => matchesPattern(a.pattern, flags, themeId));
        return arm ? evalValue(arm.body) : undefined;
      }
      case "expr":
        return toHex(evaluateColor(v.expr, ctx));
      case "style": {
        const s: Exclude<StyleValue, string> = v.color ? { foreground: toHex(evaluateColor(v.color, ctx)) } : {};
        for (const f of v.flags) s[f.name] = f.on;
        return s;
      }
    }
  };

  const apply = (stmts: Stmt[], override: boolean) => {
    for (const st of stmts) {
      if (st.kind === "block") {
        const arm = st.arms.find((a) => matchesPattern(a.pattern, flags, themeId));
        if (arm) apply(arm.body, override);
        continue;
      }
      if (st.kind === "override") {
        apply(st.body, true);
        continue;
      }
      if (st.kind !== "rule") continue;
      const line = st.selectorRange.start.line + 1;
      let value;
      try {
        value = evalValue(st.value);
      } catch (e) {
        if (!(e instanceof EvalError) && !(e instanceof NoMatch)) throw e;
        result.log.push(`error ${st.selector} (line ${line}): ${e instanceof EvalError ? e.message : "no match arm applies"}`);
        continue;
      }
      if (value === undefined) {
        result.log.push(`skip  ${st.selector} (line ${line}): no match arm applies to this theme`);
        continue;
      }
      if (!registry.isValidName(st.selector)) {
        result.log.push(`skip  ${st.selector} (line ${line}): unknown token type`);
        continue;
      }
      if (isUiColor(st.selector)) {
        const id = st.selector.slice(UI_PREFIX.length);
        if (value === NONE) {
          delete result.ui[id];
          result.log.push(`none  ${st.selector} (line ${line})`);
        } else if (typeof value !== "string") {
          result.log.push(`error ${st.selector} (line ${line}): UI colors take a color, not style()`);
        } else if (!override && resolver.theme.colors[id] !== undefined) {
          result.log.push(`skip  ${st.selector} (line ${line}): theme already defines it (colors["${id}"]); use override to replace it`);
        } else {
          result.ui[id] = value;
          result.log.push(`set   ${st.selector} = ${value}  (line ${line})`);
        }
        continue;
      }
      const semantic = registry.isSemantic(st.selector);
      const scopes = semantic ? registry.ownScopes(st.selector) : [st.selector];
      if (value === NONE) {
        delete result.rules[st.selector];
        scopes.forEach((s) => delete result.textMate[s]);
        result.log.push(`none  ${st.selector} (line ${line})`);
        continue;
      }
      if (semantic) {
        const own = override ? undefined : resolver.exactSemanticRule(st.selector);
        if (own) {
          result.log.push(`skip  ${st.selector} (line ${line}): theme already defines it (${own.source}); use override to replace it`);
          continue;
        }
        result.rules[st.selector] = value;
        result.log.push(`set   ${st.selector} = ${JSON.stringify(value)}  (line ${line})`);
      }
      for (const scope of scopes) {
        if (!override && resolver.hasTextMateRule(scope)) {
          result.log.push(`skip  TextMate ${scope} (line ${line}): theme colors this scope itself`);
          continue;
        }
        result.textMate[scope] = toTextMate(value);
        result.log.push(`set   TextMate ${scope} = ${JSON.stringify(result.textMate[scope])}  (line ${line})`);
      }
    }
  };
  apply(file.stmts, false);

  for (const p of result.problems) {
    if (!p.warning) result.log.push(`error line ${p.range.start.line + 1}: ${p.message}`);
  }
  return result;
}
