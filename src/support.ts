// What the language servers can do, per language, as found out from the documents seen; and the
// conditions in a rules file that can't match because of it.

import * as vscode from "vscode";
import { Cond, MessageRule, Problem, Rule, RulesFile, Stmt, TagRule } from "./cfg";

/** Language server features some conditions need, beyond semantic tokens. */
export type Feature = "typeHierarchy" | "symbols" | "hovers";

const NEEDS: Partial<Record<Cond["kind"], Feature>> = {
  inherits: "typeHierarchy",
  contains: "symbols",
  within: "symbols",
  decorated: "symbols",
  doc: "hovers",
  signature: "hovers",
};

const DESCRIBE: Record<Feature, string> = {
  typeHierarchy: "no type hierarchy",
  symbols: "no document symbols",
  hovers: "no hovers",
};

/** A language whose server lacks a feature, and the file that showed it. */
export interface Missing {
  language: string;
  feature: Feature;
  file: string;
}

/**
 * Collects what language servers turned out to provide. Only a clear sign counts as missing (no
 * answer where any server with the feature gives one, e.g. no type hierarchy at a class
 * declaration), and one answer anywhere is enough to count as there, for good.
 */
export class Support implements vscode.Disposable {
  private readonly answers = new Map<string, Missing | true>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  report(language: string, feature: Feature, has: boolean, file: string) {
    const key = `${language}:${feature}`;
    const before = this.answers.get(key);
    if (before === true || (before && !has)) return;
    this.answers.set(key, has || { language, feature, file });
    if (before || !has) this.changed.fire();
  }

  /** Whether it's known either way. */
  known(language: string, feature: Feature): boolean {
    return this.answers.has(`${language}:${feature}`);
  }

  /** Whether the language is known to lack the feature. */
  lacks(language: string, feature: Feature): boolean {
    const k = this.answers.get(`${language}:${feature}`);
    return !!k && k !== true;
  }

  missing(): Missing[] {
    return [...this.answers.values()].filter((k): k is Missing => k !== true);
  }

  dispose() {
    this.changed.dispose();
  }
}

/**
 * The languages an extension starts for (onLanguage:python) or brings itself with code to serve
 * them: rust-analyzer starts on workspaceContains:Cargo.toml and contributes the rust language.
 * Grammar-only extensions (VS Code's own vscode.python) contribute languages too, but run nothing.
 */
function startsFor(e: vscode.Extension<unknown>): string[] {
  const pkg = e.packageJSON as { activationEvents?: unknown; main?: unknown; browser?: unknown; contributes?: { languages?: unknown } } | undefined;
  const events = Array.isArray(pkg?.activationEvents) ? pkg.activationEvents : [];
  const runs = pkg?.main !== undefined || pkg?.browser !== undefined;
  const contributed = runs && Array.isArray(pkg?.contributes?.languages) ? pkg.contributes.languages : [];
  const ids = [
    ...events.filter((a): a is string => typeof a === "string" && a.startsWith("onLanguage:")).map((a) => a.slice("onLanguage:".length)),
    ...contributed.map((l: { id?: unknown }) => l?.id).filter((id): id is string => typeof id === "string"),
  ];
  return [...new Set(ids)];
}

/**
 * The active extensions that start for this language: the candidates for its language server, as
 * server(...) sees them. VS Code doesn't say which extension answered a request, so with two
 * servers for one language both count.
 */
export function serversFor(language: string): string[] {
  return vscode.extensions.all.filter((e) => e.isActive && startsFor(e).includes(language)).map((e) => e.id.toLowerCase());
}

/** The languages an installed extension starts for; undefined when it isn't installed. */
export function languagesOfServer(id: string): string[] | undefined {
  const e = vscode.extensions.getExtension(id);
  return e && startsFor(e);
}

/** The text Inspect Token and the rules file show for a condition that can't match. */
export function unsupportedText(kind: Cond["kind"], language: string, file?: string): string | undefined {
  const feature = NEEDS[kind];
  return feature && `${kind}() can't match in ${language}: its language server provides ${DESCRIBE[feature]}${file ? ` (seen in ${file})` : ""}`;
}

export const featureOf = (kind: Cond["kind"]): Feature | undefined => NEEDS[kind];

/**
 * Warnings on the conditions in the file that need a feature some language lacks, where the rule
 * can apply to that language: language(python) { inherits(...) ... } is fine for typescript.
 */
export function unsupported(file: RulesFile, missing: Missing[], serverLanguages: (id: string) => string[] | undefined = () => undefined): Problem[] {
  const out = new Map<string, Problem>();
  if (!missing.length) return [];
  const atoms = (c: Cond, scope: string[] | undefined) => {
    const feature = NEEDS[c.kind];
    if (feature) {
      for (const m of missing) {
        if (m.feature !== feature || (scope && !scope.includes(m.language))) continue;
        const message = unsupportedText(c.kind, m.language, m.file)!;
        out.set(`${c.range.start.line}:${c.range.start.col}:${message}`, { range: c.range, message, warning: true });
      }
    }
    switch (c.kind) {
      case "contains":
      case "within":
      case "inherits":
      case "decorated":
        return atoms(c.inner, scope);
      case "not":
        return atoms(c.operand, scope);
      case "and":
      case "or":
        atoms(c.left, scope);
        atoms(c.right, scope);
    }
  };
  forEachRule(file.stmts, (st) => {
    const scope = intersect(languagesOf(st.head, serverLanguages), st.when && languagesOf(st.when, serverLanguages));
    for (const c of [st.head, st.when]) if (c) atoms(c, scope);
  });
  return [...out.values()];
}

/** Hints on server(...) IDs that aren't installed: rules with them apply nowhere. */
export function unknownServers(file: RulesFile, installed: (id: string) => boolean): Problem[] {
  const out = new Map<string, Problem>();
  const walk = (c: Cond) => {
    if (c.kind === "server") {
      const missing = c.ids.filter((id) => !installed(id));
      if (missing.length) {
        const message = `${missing.map((id) => `'${id}'`).join(", ")} isn't installed: server(...) takes the ID of an extension providing a language server, e.g. ms-python.vscode-pylance`;
        out.set(`${c.range.start.line}:${c.range.start.col}`, { range: c.range, message, hint: true });
      }
    } else if ("inner" in c) walk(c.inner);
    else if (c.kind === "not") walk(c.operand);
    else if (c.kind === "and" || c.kind === "or") {
      walk(c.left);
      walk(c.right);
    }
  };
  forEachRule(file.stmts, (st) => [st.head, st.when].forEach((c) => c && walk(c)));
  for (const e of file.expressions.values()) walk(e.cond);
  return [...out.values()];
}

/** Every rule, += and := in the statements, also inside blocks. */
function forEachRule(stmts: Stmt[], f: (st: Rule | TagRule | MessageRule) => void) {
  for (const st of stmts) {
    switch (st.kind) {
      case "rule":
      case "tag":
      case "message":
        f(st);
        break;
      case "when":
      case "override":
      case "target":
        forEachRule(st.body, f);
        break;
    }
  }
}

/** The languages a condition can hold in; undefined for any. server(x) holds where x starts. */
function languagesOf(c: Cond, serverLanguages: (id: string) => string[] | undefined): string[] | undefined {
  switch (c.kind) {
    case "language":
      return c.ids;
    case "server": {
      const all = c.ids.map(serverLanguages);
      return all.every(Boolean) ? [...new Set(all.flat() as string[])] : undefined;
    }
    case "selector": {
      // parameter:python
      const at = c.selector.lastIndexOf(":");
      return at >= 0 ? [c.selector.slice(at + 1)] : undefined;
    }
    case "and":
      return intersect(languagesOf(c.left, serverLanguages), languagesOf(c.right, serverLanguages));
    case "or": {
      const l = languagesOf(c.left, serverLanguages);
      const r = languagesOf(c.right, serverLanguages);
      return l && r ? [...new Set([...l, ...r])] : undefined;
    }
    default:
      return undefined;
  }
}

function intersect(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  return a && b ? a.filter((x) => b.includes(x)) : (a ?? b);
}
