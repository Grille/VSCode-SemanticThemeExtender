// Shared setup: rules compiled against the test themes, and a decorator over fake documents.

import { world } from "./fake-vscode";
import { parseRulesFile } from "../src/cfg";
import { DrawMessage, DrawRule, DrawTag, TokenDecorator } from "../src/decorations";
import { compile, CompileOptions, CompileResult } from "../src/engine";
import { loadTheme, ThemeResolver, TokenRegistry } from "../src/theme";

export function resolver(theme = "Test Dark"): ThemeResolver {
  const data = loadTheme(theme);
  if (!data) throw new Error(`Test theme '${theme}' not found`);
  return new ThemeResolver(data, new TokenRegistry());
}

/** Compiles rules text; lines in the text are given as an array for readability. */
export function compileRules(lines: string | string[], options: CompileOptions = {}, theme = "Test Dark"): CompileResult {
  const text = Array.isArray(lines) ? lines.join("\n") : lines;
  return compile(parseRulesFile(text), resolver(theme), options);
}

const at = (p: { range: { start: { line: number } }; message: string }) => `${p.range.start.line + 1}: ${p.message}`;

/** "line: message" of every error (not warnings or hints). */
export const errors = (r: CompileResult) => r.problems.filter((p) => !p.warning && !p.hint).map(at);
export const warnings = (r: CompileResult) => r.problems.filter((p) => p.warning).map(at);
export const hints = (r: CompileResult) => r.problems.filter((p) => p.hint).map(at);

/** Waits for timers and the language server round trips the decorator schedules. */
export async function settle(ms = 60) {
  for (let k = 0; k < 4; k++) await new Promise((r) => setTimeout(r, ms / 4));
}

/** Retries a check until it passes, for results that arrive when a real language server is ready. */
export async function eventually(check: () => void, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      return check();
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/**
 * A decorator with these rules, as the extension sets it up: global rules first, then project rules
 * limited to their folder.
 */
export function decorator(global: string[], project?: { folder: string; rules: string[] }): TokenDecorator {
  const d = new TokenDecorator(() => new TokenRegistry(), "semantic-theme-rules", (l) => world.output.push(l));
  const rules: DrawRule[] = [];
  const tags: DrawTag[] = [];
  const messages: DrawMessage[] = [];
  const add = (r: CompileResult, file: string, folder?: string) => {
    if (errors(r).length) throw new Error(`Rules have errors:\n${errors(r).join("\n")}`);
    rules.push(...r.textRules.map((x) => ({ ...x, file, folder })));
    tags.push(...r.tagRules.map((x) => ({ ...x, file, folder })));
    messages.push(...r.messageRules.map((x) => ({ ...x, file, folder })));
  };
  add(compileRules(global), "global rules");
  if (project) add(compileRules(project.rules, { project: true }), ".vscode/semantic-theme.str", project.folder);
  d.update(rules, tags, messages);
  return d;
}
