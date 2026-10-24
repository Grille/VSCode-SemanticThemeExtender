import * as vscode from "vscode";
import { DEFAULT_RULES, flagsForUiTheme, parseRulesFile } from "./cfg";
import { compile } from "./engine";
import { LANGUAGE_ID, registerLanguage } from "./language";
import { RULES_URI, RulesStore } from "./store";
import { activeThemeId, loadTheme, STANDARD_TYPES, ThemeResolver, TokenRegistry } from "./theme";

const TARGET = "editor.semanticTokenColorCustomizations";
// Rule keys this extension wrote per theme section, so user-written keys are never touched.
const OWNED_KEY = "semanticThemeExtender.owned";
const SYNC_POLL_MS = 30_000;

type Owned = Record<string, string[]>;

let output: vscode.OutputChannel;
let state: vscode.Memento;
let store: RulesStore;
let cachedResolver: ThemeResolver | undefined;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Semantic Theme Extender");
  state = context.globalState;
  store = new RulesStore(context.globalState, [OWNED_KEY]);

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

  context.subscriptions.push(
    output,
    vscode.workspace.registerFileSystemProvider("semantic-theme-rules", store, { isCaseSensitive: true }),
    store.onDidChangeText(() => schedule(false)),
    vscode.commands.registerCommand("semanticThemeExtender.openRules", openRules),
    vscode.commands.registerCommand("semanticThemeExtender.resetRules", resetRules),
    vscode.commands.registerCommand("semanticThemeExtender.apply", () => apply(true).catch(report)),
    vscode.commands.registerCommand("semanticThemeExtender.remove", () => removeAll().catch(report)),
    vscode.commands.registerCommand("semanticThemeExtender.showResolved", showResolved),
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

  schedule(true);
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

async function apply(verbose = false) {
  const r = resolver();
  if (!r) return;
  const { rules, log } = compile(parseRulesFile(store.text), r);
  const sectionKey = `[${r.theme.id}]`;

  const config = vscode.workspace.getConfiguration();
  const current = (config.inspect<Record<string, any>>(TARGET)?.globalValue ?? {}) as Record<string, any>;
  const next = JSON.parse(JSON.stringify(current));
  const owned = state.get<Owned>(OWNED_KEY) ?? {};

  const section = { ...(next[sectionKey] ?? {}) };
  const sectionRules = { ...(section.rules ?? {}) };
  for (const k of owned[sectionKey] ?? []) {
    if (k === "$enabled") delete section.enabled;
    else delete sectionRules[k];
  }
  const ownedNow = Object.keys(rules);
  Object.assign(sectionRules, rules);

  // Themes that don't opt into semantic highlighting would ignore the rules otherwise.
  if (ownedNow.length && r.theme.semanticHighlighting !== true && section.enabled === undefined) {
    section.enabled = true;
    ownedNow.push("$enabled");
  }

  if (Object.keys(sectionRules).length) section.rules = sectionRules;
  else delete section.rules;
  if (Object.keys(section).length) next[sectionKey] = section;
  else delete next[sectionKey];

  owned[sectionKey] = ownedNow;
  if (!ownedNow.length) delete owned[sectionKey];

  output.appendLine(`\n== ${new Date().toLocaleTimeString()} theme '${r.theme.id}' (${r.theme.file})`);
  log.forEach((l) => output.appendLine(l));

  if (JSON.stringify(next) !== JSON.stringify(current)) {
    await config.update(TARGET, Object.keys(next).length ? next : undefined, vscode.ConfigurationTarget.Global);
    output.appendLine(`wrote ${ownedNow.length} entries to ${TARGET}["${sectionKey}"]`);
  } else {
    output.appendLine("no changes");
  }
  await state.update(OWNED_KEY, owned);
  if (verbose) output.show(true);
}

async function removeAll() {
  const config = vscode.workspace.getConfiguration();
  const current = (config.inspect<Record<string, any>>(TARGET)?.globalValue ?? {}) as Record<string, any>;
  const next = JSON.parse(JSON.stringify(current));
  const owned = state.get<Owned>(OWNED_KEY) ?? {};
  for (const [sectionKey, keys] of Object.entries(owned)) {
    const section = next[sectionKey];
    if (!section) continue;
    for (const k of keys) {
      if (k === "$enabled") delete section.enabled;
      else delete section.rules?.[k];
    }
    if (section.rules && !Object.keys(section.rules).length) delete section.rules;
    if (!Object.keys(section).length) delete next[sectionKey];
  }
  await config.update(TARGET, Object.keys(next).length ? next : undefined, vscode.ConfigurationTarget.Global);
  await state.update(OWNED_KEY, {});
  vscode.window.showInformationMessage("Semantic Theme Extender: removed all generated semantic color rules.");
}

function showResolved() {
  const r = resolver();
  if (!r) return;
  output.appendLine(`\n== Resolved colors for theme '${r.theme.id}'`);
  output.appendLine(`   file: ${r.theme.file}`);
  output.appendLine(`   semanticHighlighting: ${r.theme.semanticHighlighting ?? "(not set)"}`);
  output.appendLine(`   $type: ${[...flagsForUiTheme(r.theme.uiTheme)].join(" & ")}   background: ${r.background}`);
  for (const type of STANDARD_TYPES) {
    const x = r.resolve(type);
    output.appendLine(`   @${type.padEnd(14)} ${x.color.padEnd(10)} ${x.source}`);
  }
  output.appendLine("\n   Generated rules:");
  compile(parseRulesFile(store.text), r).log.forEach((l) => output.appendLine(`   ${l}`));
  output.show(true);
}
