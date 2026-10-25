// Locates the active color theme's JSON and resolves token colors the way VS Code does:
// semantic rule -> superType chain -> TextMate fallback scope (longest prefix match) -> editor foreground.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Flag, NameKind, themeFlags } from "./cfg";
import { lightness, parseHex } from "./color";
import { UI_COLORS } from "./uiColors";

export interface ThemeData {
  id: string;
  file: string;
  dark: boolean;
  /** The theme's declared kind: "vs", "vs-dark", "hc-black" or "hc-light". */
  uiTheme: string;
  semanticHighlighting?: boolean;
  colors: Record<string, string>;
  semanticTokenColors: Record<string, unknown>;
  tokenColors: { scope?: string | string[]; settings?: { foreground?: string } }[];
  warnings: string[];
}

export interface Resolution {
  color: string;
  source: string;
}

// VS Code's built-in semantic token type -> TextMate scope fallback table.
const STANDARD_SCOPES: Record<string, string[]> = {
  comment: ["comment"],
  string: ["string"],
  keyword: ["keyword.control"],
  number: ["constant.numeric"],
  regexp: ["constant.regexp"],
  operator: ["keyword.operator"],
  namespace: ["entity.name.namespace"],
  type: ["entity.name.type", "support.type"],
  struct: ["entity.name.type.struct"],
  class: ["entity.name.type.class", "support.class"],
  interface: ["entity.name.type.interface"],
  enum: ["entity.name.type.enum"],
  typeParameter: ["entity.name.type.parameter"],
  function: ["entity.name.function", "support.function"],
  method: ["entity.name.function.member", "support.function"],
  macro: ["entity.name.function.preprocessor"],
  variable: ["variable.other.readwrite", "entity.name.variable"],
  parameter: ["variable.parameter"],
  property: ["variable.other.property"],
  enumMember: ["variable.other.enummember"],
  event: ["variable.other.event"],
  decorator: ["entity.name.decorator", "entity.name.function"],
};

// Fallback scopes VS Code defines for type + modifier combinations.
const MODIFIER_SCOPES: Record<string, string[]> = {
  "variable.readonly": ["variable.other.constant"],
  "property.readonly": ["variable.other.constant.property"],
  "type.defaultLibrary": ["support.type"],
  "class.defaultLibrary": ["support.class"],
  "interface.defaultLibrary": ["support.class"],
  "variable.defaultLibrary": ["support.variable", "support.other.variable"],
  "variable.defaultLibrary.readonly": ["support.constant"],
  "property.defaultLibrary": ["support.variable.property"],
  "property.defaultLibrary.readonly": ["support.constant.property"],
  "function.defaultLibrary": ["support.function"],
  "member.defaultLibrary": ["support.function"],
};

const STANDARD_MODIFIERS = ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"];

/** Top-level TextMate scopes that are not semantic token types, so they are valid without a dot. */
const TEXTMATE_ROOTS = new Set(["constant", "entity", "invalid", "markup", "meta", "punctuation", "storage", "support", "source", "text"]);
// Token types that TextMate scopes also start with: as plain names, string.quoted stays a scope
// rather than a string with the custom modifier "quoted".
const SHARED_ROOTS = new Set(["string", "comment", "keyword", "variable"]);

export const STANDARD_TYPES = Object.keys(STANDARD_SCOPES);

/** Default values for [dark, light, hcDark, hcLight]; a value may also name another UI color. */
type UiDefaults = [string | null, string | null, string | null, string | null];

const UI_THEME_INDEX: Record<string, number> = { "vs-dark": 0, vs: 1, "hc-black": 2, "hc-light": 3 };

export interface Selector {
  type: string;
  modifiers: string[];
  language?: string;
}

export function parseSelector(selector: string): Selector {
  const [typeAndModifiers, language] = selector.split(":");
  const [type, ...modifiers] = typeAndModifiers.split(".");
  return { type, modifiers, language };
}

/** Theme settings ID currently in effect, honoring auto-detected light/dark preference. */
export function activeThemeId(): string | undefined {
  const cfg = vscode.workspace.getConfiguration("workbench");
  if (vscode.workspace.getConfiguration("window").get<boolean>("autoDetectColorScheme")) {
    switch (vscode.window.activeColorTheme.kind) {
      case vscode.ColorThemeKind.Light:
        return cfg.get<string>("preferredLightColorTheme");
      case vscode.ColorThemeKind.HighContrast:
        return cfg.get<string>("preferredHighContrastColorTheme");
      case vscode.ColorThemeKind.HighContrastLight:
        return cfg.get<string>("preferredHighContrastLightColorTheme");
      default:
        return cfg.get<string>("preferredDarkColorTheme");
    }
  }
  return cfg.get<string>("colorTheme");
}

export function loadTheme(id: string): ThemeData | undefined {
  for (const ext of vscode.extensions.all) {
    for (const t of ext.packageJSON?.contributes?.themes ?? []) {
      if ((t.id ?? t.label) === id && typeof t.path === "string") {
        const data: ThemeData = {
          id,
          file: path.join(ext.extensionPath, t.path),
          dark: t.uiTheme !== "vs" && t.uiTheme !== "hc-light",
          uiTheme: t.uiTheme ?? "vs-dark",
          colors: {},
          semanticTokenColors: {},
          tokenColors: [],
          warnings: [],
        };
        loadInto(data, data.file, new Set());
        return data;
      }
    }
  }
  return undefined;
}

function loadInto(data: ThemeData, file: string, seen: Set<string>) {
  if (seen.has(file)) {
    return;
  }
  seen.add(file);
  let json: any;
  try {
    json = parseJsonc(fs.readFileSync(file, "utf8"));
  } catch (e) {
    data.warnings.push(`Could not read ${file}: ${(e as Error).message}`);
    return;
  }
  if (typeof json.include === "string") {
    loadInto(data, path.resolve(path.dirname(file), json.include), seen);
  }
  Object.assign(data.colors, json.colors);
  Object.assign(data.semanticTokenColors, json.semanticTokenColors);
  if (typeof json.semanticHighlighting === "boolean") {
    data.semanticHighlighting = json.semanticHighlighting;
  }
  if (Array.isArray(json.tokenColors)) {
    data.tokenColors.push(...json.tokenColors);
  } else if (typeof json.tokenColors === "string") {
    data.warnings.push(`tokenColors in ${path.basename(file)} points to a .tmTheme file, which is not supported yet`);
  }
}

/** Token type hierarchy and scope mappings contributed by language extensions. */
export class TokenRegistry {
  private superTypes = new Map<string, string>();
  private scopes = new Map<string, string[]>(); // key: "type" or "type:language"

  private types = new Set<string>(STANDARD_TYPES);
  private modifiers = new Set<string>(STANDARD_MODIFIERS);
  private uiColors = new Map<string, UiDefaults>(Object.entries(UI_COLORS));
  private languages = new Set<string>();

  constructor() {
    for (const ext of vscode.extensions.all) {
      const c = ext.packageJSON?.contributes;
      for (const t of c?.semanticTokenTypes ?? []) {
        if (t?.id) this.types.add(t.id);
        if (t?.id && t.superType) {
          this.superTypes.set(t.id, t.superType);
        }
      }
      for (const m of c?.semanticTokenModifiers ?? []) {
        if (m?.id) this.modifiers.add(m.id);
      }
      for (const lang of c?.languages ?? []) {
        if (typeof lang?.id === "string") this.languages.add(lang.id);
      }
      for (const col of c?.colors ?? []) {
        if (typeof col?.id !== "string") continue;
        const d = col.defaults ?? {};
        const v = (x: unknown) => (typeof x === "string" ? x : null);
        this.uiColors.set(col.id, [v(d.dark), v(d.light), v(d.highContrast), v(d.highContrastLight ?? d.light)]);
      }
      for (const s of c?.semanticTokenScopes ?? []) {
        for (const [key, value] of Object.entries<string[]>(s?.scopes ?? {})) {
          if (Array.isArray(value)) {
            // Each entry is a scope stack; the innermost (last) scope decides the color.
            const names = value.map((v) => v.trim().split(/\s+/).pop()!);
            this.scopes.set(s.language ? `${key}:${s.language}` : key, names);
            this.types.add(key.split(".")[0]);
          }
        }
      }
    }
  }

  /**
   * A semantic selector is a known token type (or *) followed by modifiers. Modifiers no language
   * server defines are custom ones, assigned with +=; as a plain name after a type that TextMate
   * scopes also start with (variable.foo) that reads as a scope instead, unless inExpression
   * (inside an expression, after semantic, or in a += head, where only semantic selectors stand).
   */
  isSemantic(selector: string, inExpression = false): boolean {
    const { type, modifiers } = parseSelector(selector);
    if (type !== "*" && !this.isKnown(type)) return false;
    return inExpression || !SHARED_ROOTS.has(type) || modifiers.every((m) => this.modifiers.has(m));
  }

  /** The selector's modifiers that no language server defines. */
  customModifiers(selector: string): string[] {
    return parseSelector(selector).modifiers.filter((m) => !this.modifiers.has(m));
  }

  /**
   * What a name refers to. With an explicit kind (ui x, semantic x, textmate x) the name must fit
   * it; otherwise token types come first, then UI color IDs, then TextMate scopes (names with a
   * dot, or top-level scopes). Undefined means a typo.
   */
  classify(name: string, explicit?: NameKind): NameKind | undefined {
    if (explicit === "semantic" || explicit === "ui") return this.fits(name, explicit) ? explicit : undefined;
    if (explicit === "textmate") return "textmate";
    if (this.isSemantic(name)) return "semantic";
    if (this.uiColors.has(name)) return "ui";
    if (name.includes(".") || TEXTMATE_ROOTS.has(name)) return "textmate";
    return undefined;
  }

  private fits(name: string, kind: "semantic" | "ui") {
    return kind === "ui" ? this.uiColors.has(name) : this.isSemantic(name, true);
  }

  /** Why classify found nothing; modifiers alone are a common slip. */
  unknownNameMessage(name: string, explicit?: NameKind): string {
    if (explicit === "ui") return `Unknown UI color '${name}'`;
    const { type } = parseSelector(name);
    if (this.modifiers.has(type)) {
      return `'${type}' is a modifier, not a token type: write *.${type} for every token type, or e.g. variable.${type}`;
    }
    return `Unknown token type '${type}'`;
  }

  /**
   * The TextMate scopes VS Code falls back to for exactly this selector: never a superType's (a rule
   * for recordStruct must not recolor every struct), and for :language only language-specific ones.
   */
  ownScopes(selector: string): string[] {
    const { type, modifiers, language } = parseSelector(selector);
    if (type === "*") return [];
    const key = [type, ...modifiers].join(".");
    if (language) return this.scopes.get(`${key}:${language}`) ?? [];
    return this.scopes.get(key) ?? (modifiers.length ? MODIFIER_SCOPES[key] : STANDARD_SCOPES[type]) ?? [];
  }

  /** The type followed by its superTypes, e.g. recordStruct, struct. */
  chain(type: string): string[] {
    const out = [type];
    let t = this.superTypes.get(type);
    while (t && !out.includes(t)) {
      out.push(t);
      t = this.superTypes.get(t);
    }
    return out;
  }

  fallbackScopes(type: string, language?: string): string[] | undefined {
    for (const t of this.chain(type)) {
      const s = (language && this.scopes.get(`${t}:${language}`)) || this.scopes.get(t) || STANDARD_SCOPES[t];
      if (s) {
        return s;
      }
    }
    return undefined;
  }

  /** All known token types: VS Code's standard ones plus those contributed by extensions. */
  allTypes(): string[] {
    return [...this.types].sort();
  }

  /** Language IDs contributed by VS Code's and installed extensions. */
  isLanguage(id: string): boolean {
    return this.languages.has(id);
  }

  /** UI color IDs from VS Code and installed extensions. */
  allUiColors(): string[] {
    return [...this.uiColors.keys()].sort();
  }

  uiColorDefaults(id: string): UiDefaults | undefined {
    return this.uiColors.get(id);
  }

  superTypeOf(type: string): string | undefined {
    return this.superTypes.get(type);
  }

  isKnown(type: string): boolean {
    return this.types.has(type);
  }
}

export class ThemeResolver {
  constructor(readonly theme: ThemeData, readonly registry: TokenRegistry) {}

  get foreground(): string {
    return this.theme.colors["editor.foreground"] ?? this.defaultTmForeground() ?? (this.theme.dark ? "#D4D4D4" : "#000000");
  }

  get background(): string {
    return this.theme.colors["editor.background"] ?? (this.theme.dark ? "#1E1E1E" : "#FFFFFF");
  }

  /** $type flags; the one place that decides whether the theme counts as dark or light. */
  get flags(): Set<Flag> {
    const bg = parseHex(this.background);
    return themeFlags(bg ? lightness(bg) < 0.5 : this.theme.dark, this.theme.uiTheme);
  }

  /** The theme's own semantic rule for a selector (or its type's superTypes), if any. */
  semanticRule(ref: string): Resolution | undefined {
    const { type, modifiers, language } = parseSelector(ref);
    const mods = modifiers.map((m) => `.${m}`).join("");
    for (const t of this.registry.chain(type)) {
      const keys = mods ? [`${t}${mods}`] : [];
      keys.push(t);
      for (const key of language ? keys.flatMap((k) => [`${k}:${language}`, k]) : keys) {
        const v = this.theme.semanticTokenColors[key];
        const fg = typeof v === "string" ? v : (v as { foreground?: string } | undefined)?.foreground;
        if (fg) {
          return { color: fg, source: `semanticTokenColors["${key}"]` };
        }
      }
    }
    return undefined;
  }

  /**
   * The theme's color for a name: semantic selectors (type plus known modifiers, optionally
   * ":language") resolve like VS Code does, UI colors to the theme's value or VS Code's default,
   * TextMate scopes by longest prefix match.
   */
  resolve(ref: string, explicit?: NameKind): Resolution {
    const kind = this.registry.classify(ref, explicit);
    if (!kind) {
      throw new Error(this.registry.unknownNameMessage(ref, explicit));
    }
    if (kind === "ui") {
      return this.uiColor(ref);
    }
    if (kind === "textmate") {
      return this.textMate([ref]) ?? { color: this.foreground, source: "editor foreground (no matching TextMate rule)" };
    }
    const semantic = this.semanticRule(ref);
    if (semantic) {
      return semantic;
    }
    const { type, language } = parseSelector(ref);
    const own = this.registry.ownScopes(ref);
    const scopes = own.length ? own : this.registry.fallbackScopes(type, language);
    return (scopes && this.textMate(scopes)) ?? { color: this.foreground, source: "editor foreground" };
  }

  /**
   * The theme's rule for exactly this selector, if any. A parent rule (struct for recordStruct,
   * variable for variable.readonly) doesn't count: a more specific rule refines it on purpose.
   */
  exactSemanticRule(selector: string): Resolution | undefined {
    const v = this.theme.semanticTokenColors[selector];
    const fg = typeof v === "string" ? v : (v as { foreground?: string } | undefined)?.foreground;
    return v !== undefined ? { color: fg ?? "(style only)", source: `semanticTokenColors["${selector}"]` } : undefined;
  }

  /** A UI color: the theme's own value, else VS Code's (or the contributing extension's) default. */
  uiColor(id: string, seen = new Set<string>()): Resolution {
    const own = this.theme.colors[id];
    if (own !== undefined) return { color: own, source: `colors["${id}"]` };
    const defaults = this.registry.uiColorDefaults(id);
    if (!defaults) throw new Error(`Unknown UI color '${id}'`);
    const value = defaults[UI_THEME_INDEX[this.theme.uiTheme] ?? 0];
    if (value === null) {
      throw new Error(`'${id}' isn't set by ${this.theme.id}, and VS Code computes its default from other colors`);
    }
    if (value.startsWith("#")) return { color: value, source: "VS Code default" };
    // Extensions may default to another UI color.
    if (seen.has(id)) throw new Error(`'${id}' defaults to itself`);
    seen.add(id);
    const r = this.uiColor(value, seen);
    return { color: r.color, source: `default via ${value}: ${r.source}` };
  }

  /** True when the theme colors this exact scope or a more specific one itself (not just a parent). */
  hasTextMateRule(scope: string): boolean {
    return this.theme.tokenColors.some((rule) => {
      if (!rule.scope || !rule.settings?.foreground) return false;
      const selectors = Array.isArray(rule.scope) ? rule.scope : rule.scope.split(",");
      return selectors.some((raw) => {
        const sel = raw.trim();
        return sel === scope || sel.startsWith(scope + ".");
      });
    });
  }

  /** Longest-prefix TextMate match for the first scope that any rule colors. */
  private textMate(scopes: string[]): Resolution | undefined {
    for (const scope of scopes) {
      let best: { color: string; selector: string; score: number } | undefined;
      for (const rule of this.theme.tokenColors) {
        const fg = rule.settings?.foreground;
        if (!fg || !rule.scope) {
          continue;
        }
        const selectors = Array.isArray(rule.scope) ? rule.scope : rule.scope.split(",");
        for (const raw of selectors) {
          const sel = raw.trim();
          // Descendant and exclusion selectors need the full scope stack; skip them.
          if (!sel || /\s/.test(sel) || sel.startsWith("-")) {
            continue;
          }
          if (scope === sel || scope.startsWith(sel + ".")) {
            const score = sel.split(".").length;
            if (!best || score >= best.score) {
              best = { color: fg, selector: sel, score };
            }
          }
        }
      }
      if (best) {
        return { color: best.color, source: `tokenColors "${best.selector}" (via ${scope})` };
      }
    }
    return undefined;
  }

  private defaultTmForeground(): string | undefined {
    return this.theme.tokenColors.find((r) => !r.scope && r.settings?.foreground)?.settings?.foreground;
  }
}

/** JSON with comments and trailing commas, as used by theme files. */
export function parseJsonc(text: string): any {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== "}" && text[j] !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}
