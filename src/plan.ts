// Decides how a rule's head is carried out. VS Code's settings only take plain selectors, so the
// head is expanded into an OR of ANDs: if every AND part is a positive selector (one token type,
// modifiers, at most one language), the rule becomes one settings rule per part; struct | enum and
// language(python) selfParameter work that way. Anything else (text, contains, within, inherits, !,
// two different types) is drawn as decorations over the language server's tokens.

import { Cond, NameKind, Problem } from "./cfg";
import { parseSelector, TokenRegistry } from "./theme";

export interface Plan {
  /** Selectors for settings rules; may name UI colors or TextMate scopes when they stand alone. */
  names?: string[];
  /** The head to draw as decorations instead. */
  decoration?: Cond;
  problems: Problem[];
}

interface Literal {
  c: Cond;
  negated: boolean;
}

// Expanding (a | b) (c | d) ... multiplies; past this the head is simply drawn.
const MAX_PARTS = 64;

/** The head as an OR of ANDs; undefined when it would get too big. */
function expand(c: Cond): Literal[][] | undefined {
  switch (c.kind) {
    case "language":
      // language(python, csharp) is language(python) | language(csharp).
      return c.ids.map((id) => [{ c: { ...c, ids: [id] }, negated: false }]);
    case "not":
      return [[{ c: c.operand, negated: true }]];
    case "or": {
      const l = expand(c.left);
      const r = expand(c.right);
      return l && r && l.length + r.length <= MAX_PARTS ? [...l, ...r] : undefined;
    }
    case "and": {
      const l = expand(c.left);
      const r = expand(c.right);
      if (!l || !r || l.length * r.length > MAX_PARTS) return undefined;
      return l.flatMap((a) => r.map((b) => [...a, ...b]));
    }
    default:
      return [[{ c, negated: false }]];
  }
}

/** The plain selector for one AND part, "never" when it can't match, undefined when there is none. */
function selectorFor(part: Literal[], registry: TokenRegistry): string | "never" | undefined {
  let type = "*";
  const modifiers = new Set<string>();
  let language: string | undefined;
  const setLanguage = (l: string) => {
    if (language && language !== l) return false;
    language = l;
    return true;
  };
  for (const { c, negated } of part) {
    if (negated) return undefined;
    if (c.kind === "language") {
      if (!setLanguage(c.ids[0])) return "never";
    } else if (c.kind === "selector") {
      const s = parseSelector(c.selector);
      if (s.type !== "*" && s.type !== type) {
        // Keep the more specific of two related types; unrelated ones never match together.
        if (type === "*" || registry.chain(s.type).includes(type)) type = s.type;
        else if (!registry.chain(type).includes(s.type)) return "never";
      }
      s.modifiers.forEach((m) => modifiers.add(m));
      if (s.language && !setLanguage(s.language)) return "never";
    } else {
      return undefined;
    }
  }
  if (type === "*" && !modifiers.size) return undefined;
  return `${type}${[...modifiers].map((m) => `.${m}`).join("")}${language ? `:${language}` : ""}`;
}

function atoms(c: Cond, out: Cond[] = []): Cond[] {
  if (c.kind === "not") atoms(c.operand, out);
  else if (c.kind === "and" || c.kind === "or") {
    atoms(c.left, out);
    atoms(c.right, out);
  } else {
    out.push(c);
    if (c.kind === "contains" || c.kind === "within" || c.kind === "inherits") atoms(c.inner, out);
  }
  return out;
}

export function planRule(head: Cond, target: NameKind | undefined, registry: TokenRegistry): Plan {
  const problems: Problem[] = [];

  for (const a of atoms(head)) {
    if (a.kind !== "language") continue;
    const unknown = a.ids.filter((id) => !registry.isLanguage(id));
    if (unknown.length) {
      problems.push({ range: a.range, message: `Unknown language ${unknown.map((id) => `'${id}'`).join(", ")}; language ids look like python, csharp, typescript`, warning: true });
    }
  }

  // A plain name, or several joined by |: any kind of name, inferred or explicit.
  const parts = expand(head);
  const plain = parts?.every((p) => p.length === 1 && !p[0].negated && p[0].c.kind === "selector");
  if (parts && plain) {
    const names = parts.map((p) => (p[0].c as Extract<Cond, { kind: "selector" }>).selector);
    for (const p of parts) {
      const c = p[0].c as Extract<Cond, { kind: "selector" }>;
      if (c.selector === "*") {
        problems.push({ range: c.range, message: "'*' alone needs a modifier, a language or a condition, e.g. '*.static', language(python) *, text(\"__*__\") *" });
        continue;
      }
      if (registry.classify(c.selector, target)) continue;
      const message = registry.unknownNameMessage(c.selector, target);
      problems.push({
        range: c.range,
        message: message.startsWith("Unknown token type") && !target
          ? `${message}: this rule has no effect. TextMate scopes contain a dot, e.g. string.quoted`
          : `${message}; this rule has no effect`,
        // A typo under an explicit kind is certain; without one it might be a scope we don't know.
        warning: !target,
      });
    }
    return { names: [...new Set(names.filter((n) => n !== "*"))], problems };
  }

  // In an expression, every selector must be a semantic token selector.
  let valid = true;
  if (target && target !== "semantic") {
    problems.push({ range: head.range, message: `${target} rules take plain names, joined by | at most` });
    valid = false;
  }
  for (const a of atoms(head)) {
    if (a.kind !== "selector" || a.selector === "*") continue;
    const kind = registry.classify(a.selector);
    if (kind === "semantic") continue;
    valid = false;
    problems.push({
      range: a.range,
      message: kind ? "TextMate scopes and UI colors can't be combined with other conditions; only semantic selectors can" : registry.unknownNameMessage(a.selector),
    });
  }
  if (!valid) return { problems };

  if (parts) {
    const names: string[] = [];
    let representable = true;
    let never = false;
    for (const part of parts) {
      const s = selectorFor(part, registry);
      if (s === undefined) {
        representable = false;
        break;
      }
      if (s === "never") never = true;
      else names.push(s);
    }
    if (representable) {
      if (never) {
        problems.push({ range: head.range, message: "Part of this can never match: two different token types or languages", warning: true });
      }
      return { names: [...new Set(names)], problems };
    }
  }
  return { decoration: head, problems };
}
