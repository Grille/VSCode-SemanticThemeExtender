// Evaluates a parsed rules file against the active theme.
//
// Two passes: a check pass evaluates every expression in every match arm (for diagnostics and
// swatches), and an apply pass walks only the arms that match the active theme to produce rules.
// Rules skip selectors the theme colors itself, unless they are inside an override block.
//
// A semantic selector (struct, variable.readonly) produces a semantic rule plus TextMate rules for
// the scopes VS Code falls back to, so the color also shows before the language server is ready.
// A UI color ID (editorBracketHighlight.foreground1) sets that color of the theme. Any other name
// (string.quoted.docstring.python) is a TextMate scope and only produces that. ui / semantic /
// textmate say the kind explicitly; an explicit semantic rule leaves the TextMate fallback alone.
//
// A project's rules file (.vscode/semantic-theme.str) only applies to its own window, so nothing
// from it goes to settings, which all windows share: plain semantic selectors are drawn as
// decorations like every other head, and UI colors and TextMate scopes are errors. It is meant for
// += (what tokens are); colors there are drawn but warned about, they belong in the global rules.

import { Cond, conditionText, Expr, Flag, matchesPattern, NameKind, Problem, Range, RulesFile, Stmt, stripCondition, TokenCondition, Value, VarDecl } from "./cfg";
import { planRule } from "./plan";
import { Color, parseHex, toHex } from "./color";
import { CycleError, EvalContext, EvalError, evaluateColor, NoMatch } from "./rules";
import { ThemeResolver } from "./theme";

export type StyleValue =
  | string
  | { foreground?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean };

export interface TextMateSettings {
  foreground?: string;
  fontStyle?: string;
}

/**
 * A rule drawn as editor decorations over the language server's tokens, not written to settings:
 * its head is more than a plain selector (text, contains, !, ...).
 */
export interface TextRule {
  when: TokenCondition;
  style: StyleValue;
  /** 1-based, for Inspect Token. */
  line: number;
}

/** head += slotted: custom modifiers given to matching tokens before any rule is drawn. */
export interface TagRule {
  when: TokenCondition;
  modifiers: string[];
  line: number;
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
  /** Text-filtered rules in file order; later ones win where several match a token. */
  textRules: TextRule[];
  /** Custom modifier assignments for the active theme, in file order. */
  tagRules: TagRule[];
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

export interface CompileOptions {
  /** A project's rules file: every rule is drawn as decorations, nothing goes to settings. */
  project?: boolean;
}

export function compile(file: RulesFile, resolver: ThemeResolver, options: CompileOptions = {}): CompileResult {
  const flags = resolver.flags;
  const result: CompileResult = { rules: {}, textMate: {}, ui: {}, textRules: [], tagRules: [], log: [], problems: [...file.problems], colors: [], variables: new Map(), flags };
  const registry = resolver.registry;
  const failed = new Set<string>();
  const resolving = new Set<string>();
  const warned = new Set<string>();
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
    ref(name, range, target) {
      let r;
      try {
        r = resolver.resolve(name, target);
      } catch (e) {
        throw new EvalError((e as Error).message, range);
      }
      const c = parseHex(r.color);
      if (!c) throw new EvalError(`Theme color for '${name}' is not a hex color: ${r.color}`, range);
      return c;
    },
    warn(message, range) {
      // Values are evaluated more than once (check and apply pass); report each spot once.
      const key = `${range.start.line}:${range.start.col}:${message}`;
      if (warned.has(key)) return;
      warned.add(key);
      result.problems.push({ range, message, warning: true });
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
    } finally {
      argSwatches(e);
    }
  };

  // Swatches for color arguments too, e.g. keyword in soften(keyword, 15%). Their errors were
  // already reported with the whole expression.
  const argSwatches = (e: Expr) => {
    if (e.kind !== "call") return;
    for (const a of e.args) {
      if (a.kind === "num" || a.kind === "condition" || a.kind === "match") continue;
      try {
        result.colors.push({ range: a.range, color: evaluateColor(a, ctx), literal: a.kind === "color" });
      } catch (err) {
        if (!(err instanceof EvalError) && !(err instanceof NoMatch)) throw err;
      }
      argSwatches(a);
    }
  };

  // Fills the variable cache, so variables used later aren't evaluated a second time.
  const checkVariable = (decl: VarDecl) => {
    const cached = result.variables.get(decl.name);
    if (cached && decl.value.kind !== "match") {
      // Already evaluated through a use earlier in the file; only the swatch is missing.
      result.colors.push({ range: decl.value.range, color: cached, literal: decl.value.kind === "color" });
      argSwatches(decl.value);
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

  // The rule's head together with the heads of enclosing blocks.
  const headOf = (st: { head: Cond; when?: Cond }): Cond => (st.when ? { kind: "and", left: st.when, right: st.head, range: st.head.range } : st.head);

  // Custom modifiers this file assigns, so using them doesn't get the might-be-a-typo hint.
  const assigned = new Set<string>();
  const collect = (stmts: Stmt[]) => {
    for (const st of stmts) {
      if (st.kind === "tag") st.modifiers.forEach((m) => assigned.add(m));
      else if (st.kind === "when" || st.kind === "override" || st.kind === "target") collect(st.body);
      else if (st.kind === "block") st.arms.forEach((a) => collect(a.body));
    }
  };
  collect(file.stmts);

  const check = (stmts: Stmt[]) => {
    for (const st of stmts) {
      if (st.kind === "var") checkVariable(st);
      else if (st.kind === "tag") {
        // Only semantic tokens have modifiers; checked like the head of a drawn rule.
        if (st.target && st.target !== "semantic") {
          result.problems.push({ range: st.selectorRange, message: "Modifiers can only be added to semantic tokens" });
        } else {
          result.problems.push(...planRule(headOf(st), "semantic", registry, assigned).problems);
        }
      } else if (st.kind === "rule") {
        const plan = planRule(headOf(st), st.target, registry, assigned);
        result.problems.push(...plan.problems);
        const notSemantic = options.project ? (plan.names ?? []).filter((n) => registry.classify(n, st.target) !== "semantic" && registry.classify(n, st.target)) : [];
        if (notSemantic.length) {
          result.problems.push({
            range: st.selectorRange,
            message: `Project rules only color semantic tokens; UI colors and TextMate scopes (${notSemantic.map((n) => `'${n}'`).join(", ")}) go in the global rules`,
          });
        } else if (options.project) {
          // Still drawn, but colors are better kept in one place for every project.
          result.problems.push({
            range: st.selectorRange,
            message: "Project files are for what tokens are (head += slotted); how they look belongs in the global rules (Open Rules), where your $variables are and it's the same in every project",
            warning: true,
          });
        } else if (plan.names?.some((n) => registry.classify(n, st.target) === "ui") && hasStyle(st.value)) {
          result.problems.push({ range: st.selectorRange, message: "UI colors take a color; style() only applies to tokens" });
        }
        checkValue(st.value);
      } else if (st.kind === "when" || st.kind === "override" || st.kind === "target") {
        check(st.body);
      } else if (st.kind === "block") {
        st.arms.forEach((a) => check(a.body));
      }
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
      if (st.kind === "target" || st.kind === "when") {
        apply(st.body, override);
        continue;
      }
      if (st.kind === "tag") {
        if (st.target && st.target !== "semantic") continue;
        const when = stripCondition(headOf(st));
        result.tagRules.push({ when, modifiers: st.modifiers, line: st.selectorRange.start.line + 1 });
        result.log.push(`tag   ${conditionText(when)} += ${st.modifiers.join(", ")}  (line ${st.selectorRange.start.line + 1})`);
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
      const plan = planRule(headOf(st), st.target, registry);
      if (plan.decoration) {
        addTextRule(stripCondition(plan.decoration), value, line);
        continue;
      }
      for (const name of plan.names ?? []) {
        if (options.project) applyProjectName(name, st.target, value, override, line);
        else applyName(name, st.target, value, override, line);
      }
    }
  };

  // A later rule with the same head replaces an earlier one.
  const addTextRule = (when: TokenCondition, value: StyleValue | typeof NONE, line: number) => {
    const key = JSON.stringify(when);
    const name = conditionText(when);
    result.textRules = result.textRules.filter((r) => JSON.stringify(r.when) !== key);
    if (value === NONE) {
      result.log.push(`none  ${name} (line ${line})`);
    } else {
      result.textRules.push({ when, style: value, line });
      result.log.push(`deco  ${name} = ${JSON.stringify(value)}  (line ${line})`);
    }
  };

  // A plain name in a project's rules: a semantic selector, drawn; it fills gaps like a settings rule.
  const applyProjectName = (selector: string, target: NameKind | undefined, value: StyleValue | typeof NONE, override: boolean, line: number) => {
    if (registry.classify(selector, target) !== "semantic") {
      result.log.push(`skip  ${selector} (line ${line}): project rules only color semantic tokens`);
      return;
    }
    const own = override || value === NONE ? undefined : resolver.exactSemanticRule(selector);
    if (own) {
      result.log.push(`skip  ${selector} (line ${line}): theme already defines it (${own.source}); use override to replace it`);
      return;
    }
    addTextRule({ kind: "selector", selector }, value, line);
  };

  // A rule for one plain name: a semantic selector (plus its TextMate fallback), a TextMate scope or a UI color.
  const applyName = (selector: string, target: NameKind | undefined, value: StyleValue | typeof NONE, override: boolean, line: number) => {
    const kind = registry.classify(selector, target);
    if (!kind) {
      result.log.push(`skip  ${selector} (line ${line}): ${registry.unknownNameMessage(selector, target)}`);
      return;
    }
    if (kind === "ui") {
      const id = selector;
      if (value === NONE) {
        delete result.ui[id];
        result.log.push(`none  ${selector} (line ${line})`);
      } else if (typeof value !== "string") {
        result.log.push(`error ${selector} (line ${line}): UI colors take a color, not style()`);
      } else if (!override && resolver.theme.colors[id] !== undefined) {
        result.log.push(`skip  ${selector} (line ${line}): theme already defines it (colors["${id}"]); use override to replace it`);
      } else {
        result.ui[id] = value;
        result.log.push(`set   ${selector} = ${value}  (line ${line})`);
      }
      return;
    }
    const semantic = kind === "semantic";
    // An explicit semantic rule is only the semantic rule.
    const scopes = !semantic ? [selector] : target ? [] : registry.ownScopes(selector);
    if (value === NONE) {
      delete result.rules[selector];
      scopes.forEach((s) => delete result.textMate[s]);
      result.log.push(`none  ${selector} (line ${line})`);
      return;
    }
    if (semantic) {
      const own = override ? undefined : resolver.exactSemanticRule(selector);
      if (own) {
        result.log.push(`skip  ${selector} (line ${line}): theme already defines it (${own.source}); use override to replace it`);
        return;
      }
      result.rules[selector] = value;
      result.log.push(`set   ${selector} = ${JSON.stringify(value)}  (line ${line})`);
    }
    for (const scope of scopes) {
      if (!override && resolver.hasTextMateRule(scope)) {
        result.log.push(`skip  TextMate ${scope} (line ${line}): theme colors this scope itself`);
        continue;
      }
      result.textMate[scope] = toTextMate(value);
      result.log.push(`set   TextMate ${scope} = ${JSON.stringify(result.textMate[scope])}  (line ${line})`);
    }
  };
  apply(file.stmts, false);

  // An expression used several times reports its problems once, at the declaration.
  const seen = new Set<string>();
  result.problems = result.problems.filter((p) => {
    const key = `${p.range.start.line}:${p.range.start.col}:${p.range.end.line}:${p.range.end.col}:${p.message}`;
    return !seen.has(key) && !!seen.add(key);
  });
  for (const p of result.problems) {
    if (!p.warning && !p.hint) result.log.push(`error line ${p.range.start.line + 1}: ${p.message}`);
  }
  return result;
}
