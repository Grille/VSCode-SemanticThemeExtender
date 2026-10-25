import * as vscode from "vscode";
import { DEFAULT_RULES, parseRulesFile } from "./cfg";
import { DrawRule, DrawTag, TokenDecorator } from "./decorations";
import { compile } from "./engine";
import { LANGUAGE_ID, PROJECT_FILE, registerLanguage } from "./language";
import { Customizations, normalizeOwned, SEMANTIC_SETTING, strip, TEXTMATE_SETTING, UI_SETTING, write } from "./settings";
import { RULES_URI, RulesStore } from "./store";
import { activeThemeId, loadTheme, STANDARD_TYPES, ThemeResolver, TokenRegistry } from "./theme";

// Entries this extension wrote, so user-written ones are never touched.
const OWNED_KEY = "semanticThemeExtender.owned";
const SYNC_POLL_MS = 30_000;

let output: vscode.OutputChannel;
let state: vscode.Memento;
let store: RulesStore;
let cachedResolver: ThemeResolver | undefined;
let decorator: TokenDecorator;
let lastTextRules = "";

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Semantic Theme Extender");
  state = context.globalState;
  store = new RulesStore(context.globalState, [OWNED_KEY]);
  // First, so a rules tab restored at startup can be read as early as possible.
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider("semantic-theme-rules", store, { isCaseSensitive: true }));
  store.announce();

  decorator = new TokenDecorator(() => resolver()?.registry, LANGUAGE_ID, (line) => output.appendLine(`[decorations] ${line}`));
  context.subscriptions.push(decorator);

  const language = registerLanguage(context, {
    resolver: () => resolver(),
  });

  let timer: NodeJS.Timeout | undefined;
  const schedule = (themeChanged: boolean) => {
    if (themeChanged) {
      cachedResolver = undefined;
      language.refresh();
    }
    clearTimeout(timer);
    timer = setTimeout(() => apply().catch(report), 300);
  };

  const poll = setInterval(() => store.checkForExternalChange(), SYNC_POLL_MS);
  // Project rules apply when saved (or changed on disk), like the global rules.
  const projectFiles = vscode.workspace.createFileSystemWatcher(`**/${PROJECT_FILE}`);

  context.subscriptions.push(
    output,
    store.onDidChangeText(() => schedule(false)),
    vscode.commands.registerCommand("semanticThemeExtender.openRules", openRules),
    vscode.commands.registerCommand("semanticThemeExtender.openProjectRules", () => openProjectRules().catch(report)),
    projectFiles,
    projectFiles.onDidChange(() => schedule(false)),
    projectFiles.onDidCreate(() => schedule(false)),
    projectFiles.onDidDelete(() => schedule(false)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => schedule(false)),
    vscode.workspace.onDidGrantWorkspaceTrust(() => schedule(false)),
    vscode.commands.registerCommand("semanticThemeExtender.resetRules", resetRules),
    vscode.commands.registerCommand("semanticThemeExtender.apply", () => apply(true).catch(report)),
    vscode.commands.registerCommand("semanticThemeExtender.remove", () => removeAll().catch(report)),
    vscode.commands.registerCommand("semanticThemeExtender.showResolved", showResolved),
    vscode.commands.registerCommand("semanticThemeExtender.inspectToken", () => inspectToken().catch(report)),
    vscode.window.onDidChangeActiveColorTheme(() => schedule(true)),
    vscode.window.onDidChangeWindowState((s) => s.focused && store.checkForExternalChange()),
    vscode.extensions.onDidChange(() => schedule(true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("workbench.colorTheme") ||
        e.affectsConfiguration("workbench.preferredDarkColorTheme") ||
        e.affectsConfiguration("workbench.preferredLightColorTheme") ||
        e.affectsConfiguration("window.autoDetectColorScheme")
      ) {
        schedule(true);
      }
    }),
    { dispose: () => clearInterval(poll) },
  );

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(refillRulesTab));
  vscode.workspace.textDocuments.forEach(refillRulesTab);

  schedule(true);
}

/**
 * A rules tab whose read failed, e.g. while the extension host was restarting, stays empty and
 * doesn't recover from a change event; unless it has unsaved edits, give it the stored text.
 */
async function refillRulesTab(doc: vscode.TextDocument) {
  if (doc.uri.toString() !== RULES_URI.toString() || doc.isDirty) return;
  const text = store.text;
  const shown = doc.getText();
  if (shown === text) return;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(shown.length)), text);
  if ((await vscode.workspace.applyEdit(edit)) && (await doc.save())) {
    output.appendLine(`Rules tab showed ${shown.length ? "outdated" : "no"} content; refilled it from the stored rules.`);
  }
}

export function deactivate() {}

function report(e: unknown) {
  output.appendLine(`[error] ${(e as Error)?.stack ?? e}`);
}

function resolver(): ThemeResolver | undefined {
  if (cachedResolver) return cachedResolver;
  const id = activeThemeId();
  if (!id) {
    output.appendLine("No active color theme found.");
    return undefined;
  }
  const theme = loadTheme(id);
  if (!theme) {
    output.appendLine(`Theme '${id}' not found among installed extensions.`);
    return undefined;
  }
  theme.warnings.forEach((w) => output.appendLine(`[warn] ${w}`));
  cachedResolver = new ThemeResolver(theme, new TokenRegistry());
  return cachedResolver;
}

async function openRules() {
  const doc = await vscode.workspace.openTextDocument(RULES_URI);
  await vscode.languages.setTextDocumentLanguage(doc, LANGUAGE_ID);
  await vscode.window.showTextDocument(doc);
}

const PROJECT_TEMPLATE = `; What tokens are in this project, as custom modifiers; applied on save, in this folder only.
;   contains(text("__slots__") variable.classMember) class += slotted
; How they look belongs in the global rules (Semantic Theme Extender: Open Rules), the same in
; every project:   class.slotted = $struct

`;

/** Opens the project rules of a workspace folder, creating the file if there is none. */
async function openProjectRules() {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    vscode.window.showInformationMessage("Project rules belong to a workspace folder; open a folder first.");
    return;
  }
  const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: "Project rules for which folder?" });
  if (!folder) return;
  const uri = vscode.Uri.joinPath(folder.uri, PROJECT_FILE);
  const exists = await vscode.workspace.fs.stat(uri).then(
    () => true,
    () => false,
  );
  if (!exists) await vscode.workspace.fs.writeFile(uri, Buffer.from(PROJECT_TEMPLATE, "utf8"));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
}

/** Each trusted workspace folder's project rules, as saved on disk. */
async function projectRules(r: ThemeResolver): Promise<{ rules: DrawRule[]; tags: DrawTag[] }> {
  const out = { rules: [] as DrawRule[], tags: [] as DrawTag[] };
  if (!vscode.workspace.isTrusted) return out;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const uri = vscode.Uri.joinPath(folder.uri, PROJECT_FILE);
    const bytes = await vscode.workspace.fs.readFile(uri).then(
      (b) => b,
      () => undefined,
    );
    if (!bytes) continue;
    const result = compile(parseRulesFile(Buffer.from(bytes).toString("utf8")), r, { project: true });
    output.appendLine(`\n== project rules ${uri.fsPath}`);
    result.log.forEach((l) => output.appendLine(l));
    const file = vscode.workspace.asRelativePath(uri);
    out.rules.push(...result.textRules.map((t) => ({ ...t, folder: folder.uri.toString(), file })));
    out.tags.push(...result.tagRules.map((t) => ({ ...t, folder: folder.uri.toString(), file })));
  }
  return out;
}

async function resetRules() {
  const ok = await vscode.window.showWarningMessage(
    "Replace your Semantic Theme Extender rules with the defaults?",
    { modal: true },
    "Reset",
  );
  if (ok === "Reset") {
    await store.setText(DEFAULT_RULES);
  }
}

const globalValue = (setting: string) =>
  vscode.workspace.getConfiguration().inspect<Record<string, any>>(setting)?.globalValue;

const SETTINGS: Record<keyof Customizations, string> = { semantic: SEMANTIC_SETTING, textMate: TEXTMATE_SETTING, ui: UI_SETTING };

const currentSettings = () => ({
  semantic: globalValue(SEMANTIC_SETTING),
  textMate: globalValue(TEXTMATE_SETTING),
  ui: globalValue(UI_SETTING),
});

/** Writes each changed setting; true when any was written. */
async function writeSettings(before: Partial<Customizations>, after: Customizations) {
  let wrote = false;
  for (const key of Object.keys(SETTINGS) as (keyof Customizations)[]) {
    wrote = (await updateIfChanged(SETTINGS[key], before[key], after[key])) || wrote;
  }
  return wrote;
}

/** Writes a setting if it changed; an empty object removes it from settings.json entirely. */
async function updateIfChanged(setting: string, before: Record<string, any> | undefined, after: Record<string, any>) {
  if (JSON.stringify(before ?? {}) === JSON.stringify(after)) return false;
  await vscode.workspace
    .getConfiguration()
    .update(setting, Object.keys(after).length ? after : undefined, vscode.ConfigurationTarget.Global);
  return true;
}

async function apply(verbose = false) {
  const r = resolver();
  if (!r) return;
  const result = compile(parseRulesFile(store.text), r);
  const { rules, textMate, ui, log } = result;
  const section = `[${r.theme.id}]`;

  const before = currentSettings();
  // Themes that don't opt into semantic highlighting would ignore the rules otherwise.
  const enable = r.theme.semanticHighlighting !== true;
  const next = write(strip(before, normalizeOwned(state.get(OWNED_KEY))), section, result, enable);

  output.appendLine(`\n== ${new Date().toLocaleTimeString()} theme '${r.theme.id}' (${r.theme.file})`);
  log.forEach((l) => output.appendLine(l));

  // Rules with more than a plain selector, and all project rules, are drawn over the language
  // server's tokens; project rules come last, so they win over equally specific global ones.
  const project = await projectRules(r);
  const drawn: DrawRule[] = [...result.textRules.map((t) => ({ ...t, file: "global rules" })), ...project.rules];
  const tags: DrawTag[] = [...result.tagRules.map((t) => ({ ...t, file: "global rules" })), ...project.tags];
  const textRules = JSON.stringify([drawn, tags]);
  if (textRules !== lastTextRules) {
    lastTextRules = textRules;
    decorator.update(drawn, tags);
  }

  // Store ownership first: if a write fails half way, the next apply can still clean up.
  if (JSON.stringify(state.get(OWNED_KEY)) !== JSON.stringify(next.owned)) {
    await state.update(OWNED_KEY, next.owned);
  }
  const wrote = await writeSettings(before, next);
  output.appendLine(
    wrote
      ? `wrote ${Object.keys(rules).length} semantic, ${Object.keys(textMate).length} TextMate and ${Object.keys(ui).length} UI color rules for ${section}`
      : "no changes",
  );
  if (verbose) output.show(true);
}

async function removeAll() {
  const before = currentSettings();
  await writeSettings(before, strip(before, normalizeOwned(state.get(OWNED_KEY))));
  await state.update(OWNED_KEY, undefined);
  vscode.window.showInformationMessage("Semantic Theme Extender: removed all generated color rules.");
}

/** Writes what the extension knows about the token at the cursor to the output panel. */
async function inspectToken() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Put the cursor on a token in an editor first.");
    return;
  }
  const pos = editor.selection.active;
  const lines = await decorator.inspect(editor.document, pos);
  output.appendLine(`\n== Token at ${vscode.workspace.asRelativePath(editor.document.uri)}:${pos.line + 1}:${pos.character + 1}`);
  lines.forEach((l) => output.appendLine(l));
  output.show(true);
}

function showResolved() {
  const r = resolver();
  if (!r) return;
  output.appendLine(`\n== Resolved colors for theme '${r.theme.id}'`);
  output.appendLine(`   file: ${r.theme.file}`);
  output.appendLine(`   semanticHighlighting: ${r.theme.semanticHighlighting ?? "(not set)"}`);
  output.appendLine(`   $type: ${[...r.flags].join(" & ")}   background: ${r.background}`);
  for (const type of STANDARD_TYPES) {
    const x = r.resolve(type);
    output.appendLine(`   @${type.padEnd(14)} ${x.color.padEnd(10)} ${x.source}`);
  }
  output.appendLine("\n   Generated rules:");
  compile(parseRulesFile(store.text), r).log.forEach((l) => output.appendLine(`   ${l}`));
  output.show(true);
}
