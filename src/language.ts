// Editor support for .str rules files: diagnostics, color swatches, hover and completion.

import * as vscode from "vscode";
import { CONDITION_ARGS, conditionText, FLAGS, NAME_KINDS, NameKind, parseRulesFile, Problem, Range, Rule, Stmt, stripCondition, STYLE_NAMES } from "./cfg";
import { Color, toHex } from "./color";
import { compile, CompileResult } from "./engine";
import { FUNCTIONS } from "./rules";
import { Missing, unsupported } from "./support";
import { ThemeResolver } from "./theme";

export const LANGUAGE_ID = "semantic-theme-rules";

export interface LanguageHost {
  resolver(): ThemeResolver | undefined;
  /** Features language servers turned out to lack. */
  missing?(): Missing[];
  /** The rules files in use (global and project), with their saved text. */
  sources?(): { uri: vscode.Uri; text: string }[];
}

const STYLES = [...STYLE_NAMES];
/** A project's rules, next to its settings; they apply to that workspace folder only. */
export const PROJECT_FILE = ".vscode/semantic-theme.str";
export const isProjectFile = (uri: vscode.Uri) => uri.scheme !== "semantic-theme-rules" && uri.path.toLowerCase().endsWith(`/${PROJECT_FILE}`);

const KEYWORDS = new Set(["match", "style", "override", "language", "text", "doc", "signature", "contains", "within", "inherits", "decorated", ...NAME_KINDS, "_"]);

const KIND_LABELS: Record<NameKind, string> = { semantic: "Semantic selector", textmate: "TextMate scope", ui: "UI color" };

const FUNCTION_DOCS: Record<string, [string, string]> = {
  style: ["style(${1:color}, ${2:bold})", "Font styles for the whole value: style(color, bold | !italic). style(underline) keeps the theme's color."],
  emphasize: ["emphasize(${1:color}, ${2:10%})", "More contrast to the editor background: lighter on dark themes, darker on light ones."],
  soften: ["soften(${1:color}, ${2:10%})", "Less contrast: toward the editor background."],
  lighten: ["lighten(${1:color}, ${2:10%})", "Raise lightness (OKLCH, 0-1) by an absolute amount: 10% adds 0.1."],
  darken: ["darken(${1:color}, ${2:10%})", "Lower lightness (OKLCH, 0-1) by an absolute amount: 10% subtracts 0.1."],
  saturate: ["saturate(${1:color}, ${2:20%})", "Scale chroma up by a relative amount: 20% means chroma x 1.2."],
  desaturate: ["desaturate(${1:color}, ${2:20%})", "Scale chroma down by a relative amount: 20% means chroma x 0.8."],
  offset: [
    "offset(${1:class}, ${2:#4EC9B0}, ${3:#86C691}, ${4|light,dark|})",
    "Apply the change from base to target to the color: lightness, chroma and hue as measured. Exact where the color equals base. Where the optional condition holds (light, light & !contrast, ...) the lightness change flips; pass light for references measured on a dark theme.",
  ],
  hue: ["hue(${1:color}, ${2:30})", "Rotate the hue (OKLCH): by an angle, hue(c, 30) / 30deg / 30°, or by a visible distance, hue(c, 5%), which looks the same on muted and saturated colors."],
  mix: ["mix(${1:a}, ${2:b}, ${3:0.5})", "Blend two colors in OKLab; 0 = a, 1 = b."],
  alpha: ["alpha(${1:color}, ${2:50%})", "Set opacity."],
  rgb: ["rgb(${1:r}, ${2:g}, ${3:b})", "Integers are 0-255 (rgb(0, 100, 200)), decimals 0.0-1.0 (rgb(0.5, 1.0, 0.2)), or percentages. Optional alpha: 0.5, 50% or 0-255."],
  rgba: ["rgba(${1:r}, ${2:g}, ${3:b}, ${4:a})", "Same as rgb with alpha."],
};

const BUILTIN_DOCS: Record<string, string> = {
  theme: 'The active theme\'s name. Use with match: match($theme) { "Dark Modern" { ... } }',
  type: "The active theme's type as flags: dark or light, plus contrast. Use with match: match($type) { dark -> ... }",
  none: "No rule for this selector, e.g. enum = $none",
};

const toVsColor = (c: Color) => new vscode.Color(c.r, c.g, c.b, c.a);
const toVsRange = (r: Range) => new vscode.Range(r.start.line, r.start.col, r.end.line, r.end.col);

export function registerLanguage(context: vscode.ExtensionContext, host: LanguageHost): { refresh(): void; refreshSupport(): void } {
  const diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);
  const cache = new WeakMap<vscode.TextDocument, { version: number; result: CompileResult | undefined }>();

  const analyze = (doc: vscode.TextDocument): CompileResult | undefined => {
    const hit = cache.get(doc);
    if (hit && hit.version === doc.version) return hit.result;
    const resolver = host.resolver();
    const result = resolver && compile(parseRulesFile(doc.getText()), resolver, { project: isProjectFile(doc.uri) });
    cache.set(doc, { version: doc.version, result });
    return result;
  };

  // Computed colors depend on the theme, but VS Code only re-queries color providers on edits,
  // so they are drawn as decorations (read-only, no picker) that can be refreshed at any time.
  const computedSwatch = vscode.window.createTextEditorDecorationType({
    before: {
      contentText: " ",
      width: "0.8em",
      height: "0.8em",
      margin: "0.1em 0.2em 0 0.2em",
      border: "1px solid",
      borderColor: new vscode.ThemeColor("editorWidget.border"),
      textDecoration: "none; display: inline-block; vertical-align: middle; box-sizing: border-box",
    },
  });

  const decorate = (editor: vscode.TextEditor) => {
    if (editor.document.languageId !== LANGUAGE_ID) return;
    const result = analyze(editor.document);
    const themeId = host.resolver()?.theme.id ?? "the active theme";
    editor.setDecorations(
      computedSwatch,
      (result?.colors ?? [])
        .filter((c) => !c.literal)
        .map((c) => ({
          range: toVsRange(c.range),
          hoverMessage: new vscode.MarkdownString(`\`${toHex(c.color)}\` in *${themeId}*`),
          renderOptions: { before: { backgroundColor: toHex(c.color) } },
        })),
    );
  };

  const toDiagnostic = (p: Problem) => {
    const d = new vscode.Diagnostic(
      toVsRange(p.range),
      p.message,
      p.hint ? vscode.DiagnosticSeverity.Hint : p.warning ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
    );
    d.source = LANGUAGE_ID;
    return d;
  };

  /** Conditions that can't match in some language, as far as the language servers seen so far tell. */
  const unsupportedIn = (text: string) => {
    const missing = host.missing?.() ?? [];
    return missing.length ? unsupported(parseRulesFile(text), missing) : [];
  };

  const validate = (doc: vscode.TextDocument) => {
    if (doc.languageId !== LANGUAGE_ID) return;
    vscode.window.visibleTextEditors.filter((e) => e.document === doc).forEach(decorate);
    const result = analyze(doc);
    diagnostics.set(doc.uri, [...(result?.problems ?? []), ...unsupportedIn(doc.getText())].map(toDiagnostic));
  };

  /**
   * The rules files in use that aren't open get their unsupported conditions too, so the Problems
   * panel shows them as soon as a language server turns out to lack something.
   */
  const validateClosed = () => {
    const open = new Set(vscode.workspace.textDocuments.map((d) => d.uri.toString()));
    for (const { uri, text } of host.sources?.() ?? []) {
      if (!open.has(uri.toString())) diagnostics.set(uri, unsupportedIn(text).map(toDiagnostic));
    }
  };

  const selector: vscode.DocumentSelector = { language: LANGUAGE_ID };

  const tokenTypeItems = (resolver: ThemeResolver | undefined, kind: vscode.CompletionItemKind) =>
    (resolver?.registry.allTypes() ?? []).map((t) => {
      const item = new vscode.CompletionItem(t, kind);
      try {
        const r = resolver!.resolve(t);
        item.detail = r.color;
        item.documentation = `${r.source} in ${resolver!.theme.id}`;
      } catch {
        // unknown in this theme
      }
      const sup = resolver?.registry.superTypeOf(t);
      if (sup) item.detail = `${item.detail ?? ""}  (extends ${sup})`.trim();
      return item;
    });

  const uiColorItems = (resolver: ThemeResolver | undefined) =>
    (resolver?.registry.allUiColors() ?? []).map((id) => {
      const item = new vscode.CompletionItem(id, vscode.CompletionItemKind.Color);
      try {
        const r = resolver!.uiColor(id);
        item.detail = r.color;
        item.documentation = `${r.source} in ${resolver!.theme.id}`;
      } catch (e) {
        item.documentation = (e as Error).message;
      }
      return item;
    });

  const snippet = (label: string, body: string, kind: vscode.CompletionItemKind, docs?: string) => {
    const item = new vscode.CompletionItem(label, kind);
    item.insertText = new vscode.SnippetString(body);
    item.documentation = docs;
    return item;
  };

  const matchSnippet = (asValue: boolean) =>
    snippet(
      "match",
      asValue ? "match(\\$${1|type,theme|}) {\n\t${2:dark} -> $3\n\t_ -> $4\n}" : "match(\\$${1|type,theme|}) {\n\t${2:dark} {\n\t\t$3\n\t}\n}",
      vscode.CompletionItemKind.Keyword,
      asValue ? "Choose a value by theme type or name" : "Rules for matching themes",
    );

  context.subscriptions.push(
    diagnostics,
    computedSwatch,
    vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach(decorate)),
    vscode.workspace.onDidOpenTextDocument(validate),
    vscode.workspace.onDidChangeTextDocument((e) => validate(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => {
      diagnostics.delete(d.uri);
      validateClosed();
    }),

    vscode.languages.registerColorProvider(selector, {
      provideDocumentColors(doc) {
        // Only literal hex colors get the editable built-in swatch; computed ones are decorations.
        return (analyze(doc)?.colors ?? [])
          .filter((c) => c.literal)
          .map((c) => new vscode.ColorInformation(toVsRange(c.range), toVsColor(c.color)));
      },
      provideColorPresentations(color, { range }) {
        const hex = toHex({ r: color.red, g: color.green, b: color.blue, a: color.alpha });
        const p = new vscode.ColorPresentation(hex);
        p.textEdit = vscode.TextEdit.replace(range, hex);
        return [p];
      },
    }),

    vscode.languages.registerHoverProvider(selector, {
      provideHover(doc, pos) {
        const range = doc.getWordRangeAtPosition(pos, /[$@]?[A-Za-z_*][\w.:-]*/);
        if (!range) return undefined;
        const line = doc.lineAt(pos.line).text;
        const commentAt = line.indexOf(";");
        if (commentAt >= 0 && commentAt < range.start.character) return undefined;
        const word = doc.getText(range);
        const after = line.slice(range.end.character);
        const resolver = host.resolver();
        const result = analyze(doc);
        const md = new vscode.MarkdownString();

        if (word.startsWith("$")) {
          const name = word.slice(1);
          if (name in BUILTIN_DOCS) {
            md.appendMarkdown(`**${word}**: ${BUILTIN_DOCS[name]}`);
            if (name === "theme" && resolver) md.appendMarkdown(`\n\nNow: \`"${resolver.theme.id}"\``);
            if (name === "type" && result) md.appendMarkdown(`\n\nNow: \`${[...result.flags].join(" & ")}\``);
          } else {
            const c = result?.variables.get(name);
            md.appendMarkdown(c ? `**${word}** = \`${toHex(c)}\`` : `**${word}** is undefined or has an error`);
          }
          return new vscode.Hover(md, range);
        }

        if (word.startsWith("@")) {
          const e = parseRulesFile(doc.getText()).expressions.get(word.slice(1));
          md.appendMarkdown(e ? `**${word}**: \`${conditionText(stripCondition(e.cond))}\`` : `**${word}** is undefined or has an error`);
          return new vscode.Hover(md, range);
        }

        if ((FLAGS as string[]).includes(word) && result && !/^\s*=/.test(after)) {
          const has = result.flags.has(word as never);
          md.appendMarkdown(`**${word}**: the active theme ${has ? "is" : "is not"} ${word === "contrast" ? "high contrast" : word} (\`${[...result.flags].join(" & ")}\`)`);
          return new vscode.Hover(md, range);
        }

        const isSelector = /^\s*=/.test(after);
        if (!isSelector && (word in FUNCTIONS || STYLE_NAMES.has(word) || KEYWORDS.has(word))) return undefined;
        if (!resolver) return undefined;
        // "ui name" right before, or a rule inside a ui { } block.
        const explicit =
          (/\b(ui|semantic|textmate)\s+$/.exec(line.slice(0, range.start.character))?.[1] as NameKind | undefined) ??
          (isSelector ? ruleAt(parseRulesFile(doc.getText()).stmts, range.start)?.target : undefined);
        const kind = resolver.registry.classify(word, explicit);
        try {
          const r = resolver.resolve(word, explicit);
          md.appendMarkdown(`**${word}** in *${resolver.theme.id}*: \`${r.color}\` from ${r.source}`);
        } catch (e) {
          md.appendMarkdown((e as Error).message);
        }
        if (kind) md.appendMarkdown(`\n\n${KIND_LABELS[kind]}${explicit ? ` (${explicit})` : ""}.`);
        if (isSelector && kind === "ui") {
          const generated = result?.ui[word];
          md.appendMarkdown(generated !== undefined ? `\n\nGenerated: \`${generated}\`` : "\n\nNo rule generated for this theme.");
        } else if (isSelector && kind) {
          const semantic = kind === "semantic";
          const generated = semantic ? result?.rules[word] : undefined;
          const scopes = !semantic ? [word] : explicit ? [] : resolver.registry.ownScopes(word);
          const textMate = scopes.filter((s) => result?.textMate[s]).map((s) => `\`${s}\` = \`${JSON.stringify(result!.textMate[s])}\``);
          if (generated !== undefined) md.appendMarkdown(`\n\nGenerated: \`${JSON.stringify(generated)}\``);
          if (textMate.length) md.appendMarkdown(`\n\nTextMate: ${textMate.join(", ")}`);
          if (generated === undefined && !textMate.length) md.appendMarkdown("\n\nNo rule generated for this theme.");
        }
        return new vscode.Hover(md, range);
      },
    }),

    vscode.languages.registerCompletionItemProvider(
      selector,
      {
        provideCompletionItems(doc, pos) {
          const resolver = host.resolver();
          const where = cursorContext(doc.getText(new vscode.Range(0, 0, pos.line, pos.character)));
          if (where.kind === "none") return undefined;

          if (where.kind === "expression") {
            return [...parseRulesFile(doc.getText()).expressions].map(([name, e]) => {
              const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
              item.detail = conditionText(stripCondition(e.cond));
              item.range = new vscode.Range(pos.line, pos.character - where.typed.length, pos.line, pos.character);
              return item;
            });
          }

          if (where.kind === "variable") {
            const vars = analyze(doc)?.variables ?? new Map<string, Color>();
            const items = [...vars].map(([name, c]) => {
              const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
              item.detail = toHex(c);
              return item;
            });
            for (const [name, docs] of Object.entries(BUILTIN_DOCS)) {
              const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Constant);
              item.documentation = docs;
              items.push(item);
            }
            return items.map((item) => {
              item.range = new vscode.Range(pos.line, pos.character - where.typed.length, pos.line, pos.character);
              return item;
            });
          }

          if (where.kind === "pattern") {
            if (where.subject === "type") {
              return [...FLAGS, "_"].map((f) => new vscode.CompletionItem(f, vscode.CompletionItemKind.EnumMember));
            }
            const ids = new Set<string>();
            for (const ext of vscode.extensions.all) {
              for (const t of ext.packageJSON?.contributes?.themes ?? []) {
                const id = t.id ?? t.label;
                if (typeof id === "string" && !id.startsWith("%")) ids.add(id);
              }
            }
            return [...ids].map((id) => {
              const item = new vscode.CompletionItem(`"${id}"`, vscode.CompletionItemKind.Value);
              item.filterText = id;
              return item;
            });
          }

          if (where.kind === "selector") {
            return [
              ...tokenTypeItems(resolver, vscode.CompletionItemKind.Property),
              ...uiColorItems(resolver),
              matchSnippet(false),
              snippet("override", "override {\n\t$1\n}", vscode.CompletionItemKind.Keyword, "Rules that also replace the theme's own colors"),
              snippet("contains", 'contains(text("${1:__slots__}") ${2:variable.classMember}) ${3:class}', vscode.CompletionItemKind.Keyword, "Only tokens naming a symbol (class, function, ...) that directly contains a matching token"),
              snippet("decorated", 'decorated(text("${1:dataclass}")) ${2:class}', vscode.CompletionItemKind.Keyword, "Only tokens naming a symbol (class, function, ...) with a matching decorator or [Attribute]"),
              snippet("within", "within(${1:class}) ${2:method}", vscode.CompletionItemKind.Keyword, "Only tokens inside a symbol (class, function, ...) whose name matches"),
              snippet("inherits", 'inherits(${1:contains(text("__slots__") variable.classMember)}) ${2:class}', vscode.CompletionItemKind.Keyword, "Only tokens naming a type with a base type (directly or further up) whose name matches; uses the language server's type hierarchy"),
              snippet("@name", "@${1:name} => ${2:contains(text(\"__slots__\") variable.classMember)}", vscode.CompletionItemKind.Keyword, "A named selector expression, used in heads as @name: @name class = ..."),
              snippet("signature", 'signature("${1:*: Callable*}") ${2:variable}', vscode.CompletionItemKind.Keyword, 'Only tokens whose signature or type (the code in their hover) matches; "*" wildcards, any case'),
              snippet("doc", 'doc("${1:*deprecated*}") ${2:function}', vscode.CompletionItemKind.Keyword, 'Only tokens whose documentation (the hover, without code) matches; "*" wildcards, any case'),
              snippet("text", 'text("${1:__slots__}") ${2:variable}', vscode.CompletionItemKind.Keyword, 'Only tokens with this text ("*" wildcards), drawn over the language server\'s tokens'),
              snippet("language", "language(${1:python}) {\n\t$2\n}", vscode.CompletionItemKind.Keyword, "Rules for one or more languages: language(python, csharp)"),
              snippet("ui", "ui {\n\t$1\n}", vscode.CompletionItemKind.Keyword, "Rules for UI colors, e.g. editorBracketHighlight.foreground1"),
              snippet("semantic", "semantic {\n\t$1\n}", vscode.CompletionItemKind.Keyword, "Only semantic rules, without their TextMate fallback scope"),
              snippet("textmate", "textmate {\n\t$1\n}", vscode.CompletionItemKind.Keyword, "Names taken literally as TextMate scopes"),
            ];
          }

          // value
          const styleItems = () => STYLES.map((s) => new vscode.CompletionItem(s, vscode.CompletionItemKind.EnumMember));
          const arg = styleArgument(where.value);
          if (arg === "flags") return styleItems();
          if (arg === "condition") return [...FLAGS].map((f) => new vscode.CompletionItem(f, vscode.CompletionItemKind.EnumMember));
          const functions = ["style", ...Object.keys(FUNCTIONS)]
            .filter((name) => !(name === "style" && arg !== "top"))
            .map((name) => {
              const [body, docs] = FUNCTION_DOCS[name] ?? [`${name}($1)`, ""];
              return snippet(name, body, vscode.CompletionItemKind.Function, docs);
            });
          const items = [...functions, ...tokenTypeItems(resolver, vscode.CompletionItemKind.Color), ...uiColorItems(resolver), matchSnippet(true)];
          return arg === "first" ? [...styleItems(), ...items] : items;
        },
      },
      "$",
      "@",
      "(",
      ",",
      "|",
      "&",
      "!",
    ),
  );

  vscode.workspace.textDocuments.forEach(validate);

  return {
    /** Re-validates open documents, e.g. after a theme change. */
    refresh() {
      for (const doc of vscode.workspace.textDocuments) {
        cache.delete(doc);
        validate(doc);
      }
      validateClosed();
    },
    /** Re-checks unsupported conditions: after new rules, or when a language server lacks something. */
    refreshSupport() {
      vscode.workspace.textDocuments.forEach(validate);
      validateClosed();
    },
  };
}

/** The rule whose selector starts at pos, searching nested blocks. */
function ruleAt(stmts: Stmt[], pos: vscode.Position): Rule | undefined {
  for (const st of stmts) {
    if (st.kind === "rule" && st.selectorRange.start.line === pos.line && st.selectorRange.start.col === pos.character) return st;
    const bodies = st.kind === "override" || st.kind === "target" || st.kind === "when" ? [st.body] : st.kind === "block" ? st.arms.map((a) => a.body) : [];
    for (const body of bodies) {
      const found = ruleAt(body, pos);
      if (found) return found;
    }
  }
  return undefined;
}

type CursorContext =
  | { kind: "none" }
  | { kind: "variable"; typed: string }
  | { kind: "expression"; typed: string }
  | { kind: "pattern"; subject: string }
  | { kind: "selector" }
  | { kind: "value"; value: string };

/** Works out what may be typed at the end of `before` (the document text up to the cursor). */
function cursorContext(before: string): CursorContext {
  // Strip comments and strings so braces and operators inside them don't count.
  const lines = before.split(/\r?\n/).map((l) => l.replace(/;.*$/, "").replace(/"[^"]*"/g, '""'));
  const current = before.split(/\r?\n/).pop()!;
  if (current.includes(";") || /"[^"]*$/.test(current.replace(/"[^"]*"/g, ""))) return { kind: "none" };
  const text = lines.join("\n");

  // Innermost open brace: a match (arms are patterns) or an arm body (statements).
  const stack: ({ kind: "match"; subject: string } | { kind: "arm" })[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      const m = /match\s*\(\s*\$(\w+)\s*\)\s*$/.exec(text.slice(0, i));
      stack.push(m ? { kind: "match", subject: m[1] } : { kind: "arm" });
    } else if (text[i] === "}") {
      stack.pop();
    }
  }

  const v = /\$([\w-]*)$/.exec(current);
  if (v) return { kind: "variable", typed: v[1] };
  const at = /@([\w-]*)$/.exec(current);
  if (at) return { kind: "expression", typed: at[1] };

  const line = lines[lines.length - 1];
  const top = stack[stack.length - 1];
  if (top?.kind === "match") {
    const arrow = line.lastIndexOf("->");
    if (arrow >= 0) return { kind: "value", value: line.slice(arrow + 2) };
    return { kind: "pattern", subject: top.subject };
  }
  // "@name => head": the right side is a head, not a value.
  if (line.includes("=>")) return { kind: "selector" };
  const eq = /=/.exec(line);
  if (eq) return { kind: "value", value: line.slice(eq.index + eq[0].length) };
  return { kind: "selector" };
}

/**
 * Where the cursor sits relative to style(): "flags" after its comma or a "|", "first" in its
 * first argument (a color or flags), "nested" inside another call, "top" at the start of the value.
 */
function styleArgument(value: string): "top" | "first" | "flags" | "condition" | "nested" {
  const stack: { fn: string; commas: number }[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "(") stack.push({ fn: /(\w+)\s*$/.exec(value.slice(0, i))?.[1] ?? "", commas: 0 });
    else if (c === ")") stack.pop();
    else if (c === "," && stack.length) stack[stack.length - 1].commas++;
  }
  if (!stack.length) return "top";
  const top = stack[stack.length - 1];
  if (CONDITION_ARGS[top.fn] !== undefined && top.commas === CONDITION_ARGS[top.fn]) return "condition";
  if (stack.length === 1 && top.fn === "style") {
    return top.commas > 0 || /\|\s*!?\w*$/.test(value) ? "flags" : "first";
  }
  return "nested";
}
