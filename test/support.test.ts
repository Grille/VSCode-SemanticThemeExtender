import { addFile, drawn, editLine, Position, reset, show, SymbolKind as K, Uri, world } from "./fake-vscode";
import { strict as assert } from "assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { conditionText, parseRulesFile } from "../src/cfg";
import { TokenDecorator } from "../src/decorations";
import { languagesOfServer, Missing, serversFor, Support, unknownServers, unsupported } from "../src/support";
import { compileRules, decorator, errors, eventually } from "./helpers";

const NO_HIERARCHY: Missing = { language: "typescript", feature: "typeHierarchy", file: "main.ts" };

/** "line:col message" of the warnings for these rules. */
function warningsFor(lines: string[], missing: Missing[] = [NO_HIERARCHY]): string[] {
  return unsupported(parseRulesFile(lines.join("\n")), missing).map((p) => `${p.range.start.line + 1}:${p.range.start.col} ${p.message}`);
}

describe("conditions a language can't support", () => {
  it("warns on the atom, naming the language and where it showed", () => {
    assert.deepEqual(warningsFor(['inherits(text("Base")) class = #AA0000']), [
      "1:0 inherits() can't match in typescript: its language server provides no type hierarchy (seen in main.ts)",
    ]);
  });

  it("not where the rule can't apply to that language", () => {
    assert.deepEqual(warningsFor(['language(python) { inherits(text("Base")) class = #AA0000 }']), []);
    assert.deepEqual(warningsFor(['language(python) inherits(text("Base")) class += based']), []);
    assert.deepEqual(warningsFor(['inherits(text("Base")) class:python := warn("based")']), []);
    assert.equal(warningsFor(['language(python, typescript) { inherits(text("Base")) class = #AA0000 }']).length, 1);
    assert.equal(warningsFor(['language(python) | language(typescript) { inherits(text("Base")) class = #AA0000 }']).length, 1);
  });

  it("inside other conditions and expressions, once per place", () => {
    const missing: Missing[] = [{ language: "typescript", feature: "symbols", file: "main.ts" }];
    assert.deepEqual(warningsFor(['inherits(contains(text("x") property)) class = #AA0000'], missing), [
      "1:9 contains() can't match in typescript: its language server provides no document symbols (seen in main.ts)",
    ]);
    const shared = ['@based => !decorated(text("sealed"))', "@based class = #AA0000", "language(typescript) { @based interface = #00AA00 }"];
    assert.ok(warningsFor(shared, missing).length >= 1);
    assert.deepEqual(warningsFor(["language(python) { @based class = #AA0000 }", '@based => decorated(text("sealed"))'], missing), []);
  });

  it("nothing while nothing is known to be missing", () => {
    assert.deepEqual(warningsFor(['inherits(text("Base")) class = #AA0000', 'doc("*x*") = #00AA00'], []), []);
  });
});

describe("finding out what a language server provides", () => {
  it("one answer is enough to count as there, for good", () => {
    const s = new Support();
    let changes = 0;
    s.onDidChange(() => changes++);
    s.report("typescript", "typeHierarchy", false, "a.ts");
    assert.ok(s.lacks("typescript", "typeHierarchy"));
    s.report("typescript", "typeHierarchy", true, "b.ts");
    s.report("typescript", "typeHierarchy", false, "c.ts");
    assert.ok(!s.lacks("typescript", "typeHierarchy"));
    assert.deepEqual(s.missing(), []);
    assert.equal(changes, 2);
  });

  let d: TokenDecorator | undefined;
  beforeEach(() => reset());
  afterEach(() => d?.dispose());

  /** A TypeScript file and a Python file, both declaring a class and deriving from it. */
  function files() {
    world.folders = [{ uri: Uri.parse("file:///proj"), name: "proj", index: 0 }];
    const file = (name: string, language: string) => {
      const doc = addFile(`file:///proj/${name}`, {
        language,
        lines: ["class Base {}", "class Child extends Base {}"],
        tokens: [
          { line: 0, text: "Base", type: "class", modifiers: ["declaration"] },
          { line: 1, text: "Child", type: "class", modifiers: ["declaration"] },
          { line: 1, text: "Base", type: "class" },
        ],
        symbols: [
          { name: "Base", kind: K.Class, from: 0, to: 0, nameLine: 0 },
          { name: "Child", kind: K.Class, from: 1, to: 1, nameLine: 1 },
        ],
        hovers: { Base: "```\nclass Base\n```\nThe base." },
      });
      world.declared.set("Base", { uri: `file:///proj/${name}`, line: 0 });
      return doc;
    };
    world.bases.set("Child", ["Base"]);
    return { ts: file("main.ts", "typescript"), py: file("main.py", "python") };
  }

  it("a type hierarchy: asked at a type declaration, only where inherits() is used", async () => {
    world.lacking.set("typescript", new Set(["typeHierarchy"]));
    const { ts, py } = files();
    show(ts);
    show(py);
    d = decorator(['inherits(text("Base")) class = #AA0000']);
    await eventually(() => assert.deepEqual(d!.support.missing(), [NO_HIERARCHY]));
    const lines = await d.inspect(ts as any, new Position(1, 7) as any);
    assert.ok(lines.includes("  inherits() can't match in typescript: its language server provides no type hierarchy"), lines.join("\n"));
    assert.ok(!(await d.inspect(py as any, new Position(1, 7) as any)).some((l) => l.includes("can't match")));
  });

  it("symbols and hovers", async () => {
    world.lacking.set("typescript", new Set(["symbols", "hovers"]));
    const { ts } = files();
    show(ts);
    d = decorator(['contains(text("x")) class = #AA0000', 'doc("*base*") class = #00AA00']);
    await eventually(() =>
      assert.deepEqual(
        d!.support.missing().map((m) => `${m.language} ${m.feature}`).sort(),
        ["typescript hovers", "typescript symbols"],
      ),
    );
  });

  it("nothing from a file that declares nothing: no answer there proves nothing", async () => {
    world.lacking.set("typescript", new Set(["typeHierarchy", "symbols"]));
    world.folders = [{ uri: Uri.parse("file:///proj"), name: "proj", index: 0 }];
    const doc = addFile("file:///proj/use.ts", {
      language: "typescript",
      lines: ["const b = new Base();"],
      tokens: [{ line: 0, text: "Base", type: "class" }],
    });
    show(doc);
    d = decorator(['inherits(text("Base")) class = #AA0000', 'contains(text("x")) class = #00AA00']);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(d.support.missing(), []);
  });
});

describe("server()", () => {
  let d: TokenDecorator | undefined;
  beforeEach(() => reset());
  afterEach(() => d?.dispose());

  it("parses extension IDs, any case, and is drawn rather than written to settings", () => {
    const r = compileRules(["server(Test.Test-Language-Server) class = #AA0000"]);
    assert.deepEqual(errors(r), []);
    assert.deepEqual(r.rules, {});
    assert.deepEqual(r.textRules.map((t) => conditionText(t.when)), ["server(test.test-language-server) class"]);
  });

  it("matches documents of the languages an active extension starts for", async () => {
    world.folders = [{ uri: Uri.parse("file:///proj"), name: "proj", index: 0 }];
    const file = (name: string, language: string) =>
      addFile(`file:///proj/${name}`, { language, lines: ["class A: pass"], tokens: [{ line: 0, text: "A", type: "class", modifiers: ["declaration"] }] });
    const py = file("a.py", "python");
    const ts = file("a.ts", "typescript");
    show(py);
    show(ts);
    d = decorator(["server(test.test-language-server) class = #AA0000", "server(someone.else) class = #00AA00"]);
    await eventually(() => assert.deepEqual(Object.values(drawn(py)), [["0:A"]]));
    assert.equal(JSON.parse(Object.keys(drawn(py))[0]).color, "#AA0000");
    assert.deepEqual(drawn(ts), {});
  });

  it("counts the languages an extension brings itself, not only those it starts for", () => {
    // rust-analyzer: starts on workspaceContains:Cargo.toml, contributes the rust language.
    const all: unknown[] = require("vscode").extensions.all;
    const packageJSON = { main: "./out/main", activationEvents: ["workspaceContains:Cargo.toml"], contributes: { languages: [{ id: "rust" }, { id: "ra_syntax_tree" }] } };
    all.push({ id: "rust-lang.rust-analyzer", isActive: true, packageJSON });
    try {
      assert.deepEqual(languagesOfServer("rust-lang.rust-analyzer"), ["rust", "ra_syntax_tree"]);
      assert.deepEqual(serversFor("rust"), ["rust-lang.rust-analyzer"]);
    } finally {
      all.pop();
    }
  });

  it("a hint where the extension isn't installed", () => {
    const file = parseRulesFile(["server(ms-python.vscode-pylance) { class = #AA0000 }", "@x => server(nobody.there) class", "@x = #00AA00"].join("\n"));
    const hints = unknownServers(file, (id) => id === "ms-python.vscode-pylance").map((p) => `${p.range.start.line + 1}: ${p.message}`);
    assert.deepEqual(hints, ["2: 'nobody.there' isn't installed: server(...) takes the ID of an extension providing a language server, e.g. ms-python.vscode-pylance"]);
  });

  it("limits unsupported-condition warnings to the languages the extension starts for", () => {
    const languages = (id: string) => (id === "ms-python.vscode-pylance" ? ["python"] : undefined);
    const file = parseRulesFile('server(ms-python.vscode-pylance) { inherits(text("Base")) class = #AA0000 }');
    assert.deepEqual(unsupported(file, [NO_HIERARCHY], languages), []);
    assert.equal(unsupported(file, [NO_HIERARCHY]).length, 1, "an extension that isn't installed says nothing about languages");
  });
});

describe("conditions decided per document", () => {
  let d: TokenDecorator | undefined;
  beforeEach(() => reset());
  afterEach(() => d?.dispose());

  it("rules for another language ask the language server nothing", async () => {
    world.folders = [{ uri: Uri.parse("file:///proj"), name: "proj", index: 0 }];
    const py = addFile("file:///proj/a.py", {
      lines: ["class Base: pass", "class Child(Base): pass"],
      tokens: [
        { line: 0, text: "Base", type: "class", modifiers: ["declaration"] },
        { line: 1, text: "Child", type: "class", modifiers: ["declaration"] },
        { line: 1, text: "Base", type: "class" },
      ],
      hovers: { Base: "The base." },
    });
    world.declared.set("Base", { uri: "file:///proj/a.py", line: 0 });
    world.bases.set("Child", ["Base"]);
    show(py);
    d = decorator([
      'language(csharp) & inherits(text("Base")) class = #AA0000',
      'language(csharp) { doc("*base*") class = #AA0000 }',
      'server(someone.else) & !inherits(text("Base")) = #AA0000',
      'language(python) & text("Child") = #00AA00',
      'language(python) | doc("*nothing*") = #0000AA',
    ]);
    await eventually(() => assert.deepEqual(Object.values(drawn(py)).sort(), [["0:Base", "1:Base"], ["1:Child"]]));
    // The second pass (definitions, hovers) has run too by now.
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual([world.requests.typeHierarchy, world.requests.hover], [0, 0]);
  });
});

describe("asking only about tokens the rest of a rule lets through", () => {
  let d: TokenDecorator | undefined;
  beforeEach(() => reset());
  afterEach(() => d?.dispose());

  it("doc() & class asks for hovers of classes, inherits() & class.declaration of those only", async () => {
    world.folders = [{ uri: Uri.parse("file:///proj"), name: "proj", index: 0 }];
    const py = addFile("file:///proj/a.py", {
      lines: ["class Base: pass", "class Child(Base): pass", "x = 1", "y = 2", "def f(a): pass"],
      tokens: [
        { line: 0, text: "Base", type: "class", modifiers: ["declaration"] },
        { line: 1, text: "Child", type: "class", modifiers: ["declaration"] },
        { line: 1, text: "Base", type: "class" },
        { line: 2, text: "x", type: "variable", modifiers: ["declaration"] },
        { line: 3, text: "y", type: "variable", modifiers: ["declaration"] },
        { line: 4, text: "f", type: "function", modifiers: ["declaration"] },
        { line: 4, text: "a", type: "parameter", modifiers: ["declaration"] },
      ],
      hovers: { Base: "The base." },
    });
    world.declared.set("Base", { uri: "file:///proj/a.py", line: 0 });
    world.declared.set("Child", { uri: "file:///proj/a.py", line: 1 });
    world.bases.set("Child", ["Base"]);
    show(py);
    d = decorator(['doc("*base*") class = #AA0000', 'inherits(text("Base")) class.declaration & text("C*") = #00AA00']);
    await eventually(() => assert.deepEqual(drawn(py), { [JSON.stringify({ color: "#AA0000" })]: ["0:Base", "1:Base"], [JSON.stringify({ color: "#00AA00" })]: ["1:Child"] }));
    await new Promise((r) => setTimeout(r, 200));
    // Hovers: Base and Child, not x, y, f, a. Type hierarchy: the probe at Base, then Child only.
    assert.deepEqual([world.requests.hover, world.requests.typeHierarchy <= 3], [2, true]);
  });
});

describe("notebook cells", () => {
  let d: TokenDecorator | undefined;
  beforeEach(() => reset());
  afterEach(() => d?.dispose());

  it("are redrawn on edits, like files", async () => {
    const spec = { lines: ["old = 1"], tokens: [{ line: 0, text: "old", type: "variable", modifiers: ["declaration"] }] };
    const cell = addFile("vscode-notebook-cell:/proj/nb.ipynb#W0sZmlsZQ%3D%3D", spec);
    show(cell);
    d = decorator(['text("renamed") variable = #00AA00']);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(drawn(cell), {});
    spec.tokens[0].text = "renamed";
    editLine(cell, 0, "renamed = 1");
    await eventually(() => assert.deepEqual(Object.values(drawn(cell)), [["0:renamed"]]));
  });
});
