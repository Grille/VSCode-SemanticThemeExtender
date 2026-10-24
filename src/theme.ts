// Locates the active color theme's JSON and resolves token colors the way VS Code does:
// semantic rule -> superType chain -> TextMate fallback scope (longest prefix match) -> editor foreground.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

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

export const STANDARD_TYPES = Object.keys(STANDARD_SCOPES);

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

  constructor() {
    for (const ext of vscode.extensions.all) {
      const c = ext.packageJSON?.contributes;
      for (const t of c?.semanticTokenTypes ?? []) {
        if (t?.id && t.superType) {
          this.superTypes.set(t.id, t.superType);
        }
      }
      for (const s of c?.semanticTokenScopes ?? []) {
        for (const [key, value] of Object.entries<string[]>(s?.scopes ?? {})) {
          if (!key.includes(".") && Array.isArray(value)) {
            // Each entry is a scope stack; the innermost (last) scope decides the color.
            const names = value.map((v) => v.trim().split(/\s+/).pop()!);
            this.scopes.set(s.language ? `${key}:${s.language}` : key, names);
          }
        }
      }
    }
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
    const keys = [...this.scopes.keys()].map((k) => k.split(":")[0]);
    return [...new Set([...STANDARD_TYPES, ...this.superTypes.keys(), ...keys])].sort();
  }

  superTypeOf(type: string): string | undefined {
    return this.superTypes.get(type);
  }

  isKnown(type: string): boolean {
    return type in STANDARD_SCOPES || this.superTypes.has(type) || [...this.scopes.keys()].some((k) => k.split(":")[0] === type);
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

  /** The theme's own semantic rule for a token type (or one of its superTypes), if any. */
  semanticRule(ref: string): Resolution | undefined {
    const [type, language] = ref.split(":");
    for (const t of this.registry.chain(type)) {
      for (const key of language ? [`${t}:${language}`, t] : [t]) {
        const v = this.theme.semanticTokenColors[key];
        const fg = typeof v === "string" ? v : (v as { foreground?: string } | undefined)?.foreground;
        if (fg) {
          return { color: fg, source: `semanticTokenColors["${key}"]` };
        }
      }
    }
    return undefined;
  }

  /** Resolves "@ref": dotted refs are TextMate scopes, others semantic token types (optionally ":language"). */
  resolve(ref: string): Resolution {
    if (ref.includes(".")) {
      return this.textMate([ref]) ?? { color: this.foreground, source: "editor foreground (no matching TextMate rule)" };
    }
    const [type, language] = ref.split(":");
    if (!this.registry.isKnown(type)) {
      throw new Error(`Unknown token type '${type}'`);
    }
    const semantic = this.semanticRule(ref);
    if (semantic) {
      return semantic;
    }
    const scopes = this.registry.fallbackScopes(type, language);
    return (scopes && this.textMate(scopes)) ?? { color: this.foreground, source: "editor foreground" };
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
