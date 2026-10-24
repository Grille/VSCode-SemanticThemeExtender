// Merges generated rules into the user's color customization settings.
//
// Only the active theme gets a section: on every apply, everything this extension wrote before is
// removed (from all theme sections), then the active theme's rules are written. Entries the user
// wrote, or edited after we wrote them, are never touched.

import { StyleValue, TextMateSettings } from "./engine";

export const SEMANTIC_SETTING = "editor.semanticTokenColorCustomizations";
export const TEXTMATE_SETTING = "editor.tokenColorCustomizations";
export const UI_SETTING = "workbench.colorCustomizations";

export interface Owned {
  /** Theme section -> semantic rule keys we wrote. */
  semantic: Record<string, string[]>;
  /** Theme sections where we set "enabled": true. */
  enabled: string[];
  /** Theme section -> textMateRules entries we wrote, as JSON, so only exact matches are removed. */
  textMate: Record<string, string[]>;
  /** Theme section -> UI color IDs we wrote. */
  ui: Record<string, string[]>;
}

type Settings = Record<string, any>;

/** The three settings this extension writes into. */
export interface Customizations {
  semantic: Settings;
  textMate: Settings;
  ui: Settings;
}

const clone = (v: Settings | undefined): Settings => JSON.parse(JSON.stringify(v ?? {}));

/** Older versions stored only semantic keys, as section -> keys. */
export function normalizeOwned(raw: unknown): Owned {
  const o = (raw ?? {}) as Partial<Owned> & Record<string, unknown>;
  if (o.semantic || o.textMate || o.enabled || o.ui) {
    return { semantic: o.semantic ?? {}, enabled: o.enabled ?? [], textMate: o.textMate ?? {}, ui: o.ui ?? {} };
  }
  const semantic: Record<string, string[]> = {};
  const enabled: string[] = [];
  for (const [section, keys] of Object.entries(o)) {
    if (!Array.isArray(keys)) continue;
    semantic[section] = keys.filter((k) => k !== "$enabled");
    if (keys.includes("$enabled")) enabled.push(section);
  }
  return { semantic, enabled, textMate: {}, ui: {} };
}

const dropEmpty = (settings: Settings, section: string) => {
  const s = settings[section];
  if (s && typeof s === "object" && !Object.keys(s).length) delete settings[section];
};

/** Removes everything we wrote, in every theme section. */
export function strip(current: Partial<Customizations>, owned: Owned): Customizations {
  const sem = clone(current.semantic);
  const tm = clone(current.textMate);
  const ui = clone(current.ui);
  for (const [section, keys] of Object.entries(owned.semantic)) {
    const rules = sem[section]?.rules;
    if (!rules) continue;
    keys.forEach((k) => delete rules[k]);
    if (!Object.keys(rules).length) delete sem[section].rules;
    dropEmpty(sem, section);
  }
  for (const section of owned.enabled) {
    if (sem[section]?.enabled === true) delete sem[section].enabled;
    dropEmpty(sem, section);
  }
  for (const [section, entries] of Object.entries(owned.textMate)) {
    const list = tm[section]?.textMateRules;
    if (!Array.isArray(list)) continue;
    const ours = new Set(entries);
    tm[section].textMateRules = list.filter((e: unknown) => !ours.has(JSON.stringify(e)));
    if (!tm[section].textMateRules.length) delete tm[section].textMateRules;
    dropEmpty(tm, section);
  }
  for (const [section, ids] of Object.entries(owned.ui)) {
    if (!ui[section] || typeof ui[section] !== "object") continue;
    ids.forEach((id) => delete ui[section][id]);
    dropEmpty(ui, section);
  }
  return { semantic: sem, textMate: tm, ui };
}

/**
 * Writes the active theme's rules into already stripped settings and returns what we now own.
 * Our TextMate entries go before the user's, so the user's own entries win on equal scopes.
 */
export function write(
  stripped: Customizations,
  section: string,
  generated: { rules: Record<string, StyleValue>; textMate: Record<string, TextMateSettings>; ui: Record<string, string> },
  enableSemantic: boolean,
): Customizations & { owned: Owned } {
  const { rules, textMate: textMateRules } = generated;
  const sem = clone(stripped.semantic);
  const tm = clone(stripped.textMate);
  const ui = clone(stripped.ui);
  const owned: Owned = { semantic: {}, enabled: [], textMate: {}, ui: {} };

  const keys = Object.keys(rules).filter((k) => sem[section]?.rules?.[k] === undefined);
  if (keys.length) {
    sem[section] = { ...(sem[section] ?? {}) };
    sem[section].rules = { ...(sem[section].rules ?? {}) };
    for (const k of keys) sem[section].rules[k] = rules[k];
    owned.semantic[section] = keys;
    if (enableSemantic && sem[section].enabled === undefined) {
      sem[section].enabled = true;
      owned.enabled.push(section);
    }
  }

  const entries = Object.entries(textMateRules).map(([scope, settings]) => ({ scope, settings }));
  if (entries.length) {
    tm[section] = { ...(tm[section] ?? {}) };
    const existing = Array.isArray(tm[section].textMateRules) ? tm[section].textMateRules : [];
    tm[section].textMateRules = [...entries, ...existing];
    owned.textMate[section] = entries.map((e) => JSON.stringify(e));
  }

  const ids = Object.keys(generated.ui).filter((id) => ui[section]?.[id] === undefined);
  if (ids.length) {
    ui[section] = { ...(ui[section] ?? {}) };
    for (const id of ids) ui[section][id] = generated.ui[id];
    owned.ui[section] = ids;
  }
  return { semantic: sem, textMate: tm, ui, owned };
}
