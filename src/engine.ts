// Evaluates a parsed rules file against the active theme.
//
// Two passes: a check pass evaluates every expression in every match arm (for diagnostics and
// swatches), and an apply pass walks only the arms that match the active theme to produce rules.
// Rules skip selectors the theme colors itself, unless they are inside an override block.

import { Expr, Flag, matchesPattern, Problem, Range, RulesFile, Stmt, Value, VarDecl } from "./cfg";
import { Color, parseHex, toHex } from "./color";
import { CycleError, EvalContext, EvalError, evaluateColor, NoMatch } from "./rules";
import { ThemeResolver } from "./theme";

export type StyleValue =
  | string
  | { foreground?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean };

export interface ColorSpan {
  range: Range;
  color: Color;
  /** True when the span is a literal hex color that a color picker may rewrite. */
  literal: boolean;
}

export interface CompileResult {
  rules: Record<string, StyleValue>;
  log: string[];
  problems: Problem[];
  colors: ColorSpan[];
  variables: Map<string, Color>;
  flags: Set<Flag>;
}

const NONE = Symbol("none");

export function compile(file: RulesFile, resolver: ThemeResolver): CompileResult {
  const flags = resolver.flags;
  const result: CompileResult = { rules: {}, log: [], problems: [...file.problems], colors: [], variables: new Map(), flags };
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

  const check = (stmts: Stmt[]) => {
    for (const st of stmts) {
      if (st.kind === "var") checkVariable(st);
      else if (st.kind === "rule") checkValue(st.value);
      else if (st.kind === "override") check(st.body);
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
      if (value === NONE) {
        delete result.rules[st.selector];
        result.log.push(`none  ${st.selector} (line ${line})`);
        continue;
      }
      if (!override) {
        const own = resolver.semanticRule(st.selector);
        if (own) {
          result.log.push(`skip  ${st.selector} (line ${line}): theme already defines it (${own.source}); use override { } to replace it`);
          continue;
        }
      }
      result.rules[st.selector] = value;
      result.log.push(`set   ${st.selector} = ${JSON.stringify(value)}  (line ${line})`);
    }
  };
  apply(file.stmts, false);

  for (const p of result.problems) {
    if (!p.warning) result.log.push(`error line ${p.range.start.line + 1}: ${p.message}`);
  }
  return result;
}
