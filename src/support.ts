// What the language servers can do, per language, as found out from the documents seen; and the
// conditions in a rules file that can't match because of it.

import * as vscode from "vscode";
import { Cond, Problem, RulesFile, Stmt } from "./cfg";

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
export function unsupported(file: RulesFile, missing: Missing[]): Problem[] {
  const out = new Map<string, Problem>();
  if (!missing.length) return [];
  const visit = (stmts: Stmt[]) => {
    for (const st of stmts) {
      switch (st.kind) {
        case "rule":
        case "tag":
        case "message": {
          const scope = intersect(languagesOf(st.head), st.when && languagesOf(st.when));
          for (const c of [st.head, st.when]) if (c) atoms(c, scope);
          break;
        }
        case "when":
        case "override":
        case "target":
          visit(st.body);
          break;
        case "block":
          st.arms.forEach((a) => visit(a.body));
          break;
      }
    }
  };
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
  visit(file.stmts);
  return [...out.values()];
}

/** The languages a condition can hold in; undefined for any. */
function languagesOf(c: Cond): string[] | undefined {
  switch (c.kind) {
    case "language":
      return c.ids;
    case "selector": {
      // parameter:python
      const at = c.selector.lastIndexOf(":");
      return at >= 0 ? [c.selector.slice(at + 1)] : undefined;
    }
    case "and":
      return intersect(languagesOf(c.left), languagesOf(c.right));
    case "or": {
      const l = languagesOf(c.left);
      const r = languagesOf(c.right);
      return l && r ? [...new Set([...l, ...r])] : undefined;
    }
    default:
      return undefined;
  }
}

function intersect(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  return a && b ? a.filter((x) => b.includes(x)) : (a ?? b);
}
