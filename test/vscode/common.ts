import * as path from "path";
import * as vscode from "vscode";
import type { api as Api } from "../../src/extension";

export const projects = path.resolve(__dirname, "..", "..", "..", "test", "fixtures", "projects");

const RULES = vscode.Uri.parse("semantic-theme-rules:/rules.str");

let ext: typeof Api | undefined;
async function extension(): Promise<typeof Api> {
  return (ext ??= await vscode.extensions.getExtension("Grille.semantic-theme-extender")!.activate());
}

/** Replaces the global rules, as saving the rules tab does. */
export async function setRules(...lines: string[]) {
  await extension();
  await vscode.workspace.fs.writeFile(RULES, Buffer.from(lines.join("\n")));
}

/** Writes or (without lines) removes a folder's project rules. */
export async function setProjectRules(folder: string, ...lines: string[]) {
  const file = vscode.Uri.file(path.join(projects, folder, ".vscode", "semantic-theme.str"));
  if (lines.length) await vscode.workspace.fs.writeFile(file, Buffer.from(lines.join("\n")));
  else await vscode.workspace.fs.delete(file, { recursive: true, useTrash: false }).then(undefined, () => undefined);
}

/** Opens a fixture file in an editor. */
export async function open(file: string): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(path.join(projects, file));
  await vscode.window.showTextDocument(doc);
  return doc;
}

/** Where `text` starts on `line` (0-based). */
export function at(doc: vscode.TextDocument, line: number, text: string): vscode.Position {
  const ch = doc.lineAt(line).text.indexOf(text);
  if (ch < 0) throw new Error(`'${text}' isn't on line ${line}: ${doc.lineAt(line).text}`);
  return new vscode.Position(line, ch);
}

/** What Inspect Token prints for the token at line:text. */
export async function inspect(doc: vscode.TextDocument, line: number, text: string): Promise<string[]> {
  return (await extension()).inspect(doc, at(doc, line, text));
}

/** The color drawn on line:text, or undefined when nothing is. */
export async function drawnColor(doc: vscode.TextDocument, line: number, text: string): Promise<string | undefined> {
  const drawn = (await inspect(doc, line, text)).find((l) => l.startsWith("  drawn: ") && !l.startsWith("  drawn: nothing"));
  // The style is a color ("#AA0000") or {"foreground":"#AA0000",...}.
  return drawn?.match(/ = (?:\{"foreground":)?"(#[0-9a-f]+)"/i)?.[1]?.toUpperCase();
}

/** "line:text=type.modifiers" of the language server's tokens whose text passes the filter. */
export async function tokens(doc: vscode.TextDocument, filter: (text: string) => boolean): Promise<string[]> {
  const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>("vscode.provideDocumentSemanticTokensLegend", doc.uri);
  const result = await vscode.commands.executeCommand<vscode.SemanticTokens>("vscode.provideDocumentSemanticTokens", doc.uri);
  if (!legend || !result) return [];
  const data = result.data;
  const out: string[] = [];
  let line = 0;
  let ch = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    line += data[i];
    ch = data[i] === 0 ? ch + data[i + 1] : data[i + 1];
    const text = doc.lineAt(line).text.slice(ch, ch + data[i + 2]);
    const mods = legend.tokenModifiers.filter((_, m) => data[i + 4] & (1 << m));
    if (filter(text)) out.push(`${line}:${text}=${[legend.tokenTypes[data[i + 3]], ...mods].join(".")}`);
  }
  return out;
}

/**
 * Retries `check` until it passes: language servers start, load the project and refine their
 * answers in their own time. Fails with the last error after `timeoutMs`.
 */
export async function eventually<T>(check: () => Promise<T> | T, timeoutMs = 90_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
