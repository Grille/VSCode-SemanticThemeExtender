import { addFile, drawn, FakeDoc, Position, reset, show, SymbolKind as K, Uri, world } from "./fake-vscode";
import { strict as assert } from "assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { TokenDecorator } from "../src/decorations";
import { decorator, settle } from "./helpers";

/** What a document shows, by style ("#AA0000", "#AA0000 bold"): "line:text" of each token. */
function colors(doc: FakeDoc): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(drawn(doc))) {
    const o = JSON.parse(k);
    out[[o.color, o.fontWeight, o.fontStyle].filter(Boolean).join(" ")] = v;
  }
  return out;
}

const messages = (doc: FakeDoc) => (world.diagnostics.get(doc.uri.toString()) ?? []).map((d) => `${d.range.start.line}:${d.message}`);

const SLOTS = 'contains(text("__slots__") variable.classMember)';

/**
 * Two files of one workspace folder. base.py has a class with __slots__; main.py has subclasses of
 * it (Child, and GrandChild two levels down), a local slotted class with subclasses, a context
 * manager and a top-level function named like one of its methods.
 */
function project() {
  world.folders = [{ uri: Uri.parse("file:///proj"), name: "proj", index: 0 }];
  const base = addFile("file:///proj/base.py", {
    lines: ["class Slotted:", "    __slots__ = ('a',)"],
    tokens: [
      { line: 0, text: "Slotted", type: "class", modifiers: ["declaration"] },
      { line: 1, text: "__slots__", type: "variable", modifiers: ["declaration", "classMember"] },
    ],
    symbols: [{ name: "Slotted", kind: K.Class, from: 0, to: 1, nameLine: 0, children: [{ name: "__slots__", kind: K.Variable, from: 1, to: 1, nameLine: 1 }] }],
  });
  const main = addFile("file:///proj/main.py", {
    lines: [
      "from base import Slotted", // 0
      "class Child(Slotted): pass", // 1
      "class GrandChild(Child): pass", // 2
      "class Plain: pass", // 3
      "class Ctx:", // 4
      "    def run(self): ...", // 5
      "    def __enter__(self): ...", // 6
      "def run(): ...", // 7
      "x = GrandChild()", // 8
      "class Local:", // 9
      "    __slots__ = ()", // 10
      "class Sub(Local): pass", // 11
      "class SubKeep(Local):", // 12
      "    __slots__ = ()", // 13
    ],
    tokens: [
      { line: 0, text: "Slotted", type: "class" },
      { line: 1, text: "Child", type: "class", modifiers: ["declaration"] },
      { line: 1, text: "Slotted", type: "class" },
      { line: 2, text: "GrandChild", type: "class", modifiers: ["declaration"] },
      { line: 2, text: "Child", type: "class", nth: 1 },
      { line: 3, text: "Plain", type: "class", modifiers: ["declaration"] },
      { line: 4, text: "Ctx", type: "class", modifiers: ["declaration"] },
      { line: 5, text: "run", type: "method", modifiers: ["declaration", "classMember"] },
      { line: 6, text: "__enter__", type: "method", modifiers: ["declaration", "classMember"] },
      { line: 7, text: "run", type: "function", modifiers: ["declaration"] },
      { line: 8, text: "GrandChild", type: "class" },
      { line: 9, text: "Local", type: "class", modifiers: ["declaration"] },
      { line: 10, text: "__slots__", type: "variable", modifiers: ["declaration", "classMember"] },
      { line: 11, text: "Sub", type: "class", modifiers: ["declaration"] },
      { line: 11, text: "Local", type: "class" },
      { line: 12, text: "SubKeep", type: "class", modifiers: ["declaration"] },
      { line: 12, text: "Local", type: "class" },
      { line: 13, text: "__slots__", type: "variable", modifiers: ["declaration", "classMember"] },
    ],
    symbols: [
      { name: "Child", kind: K.Class, from: 1, to: 1, nameLine: 1 },
      { name: "GrandChild", kind: K.Class, from: 2, to: 2, nameLine: 2 },
      { name: "Plain", kind: K.Class, from: 3, to: 3, nameLine: 3 },
      {
        name: "Ctx",
        kind: K.Class,
        from: 4,
        to: 6,
        nameLine: 4,
        children: [
          { name: "run", kind: K.Method, from: 5, to: 5, nameLine: 5 },
          { name: "__enter__", kind: K.Method, from: 6, to: 6, nameLine: 6 },
        ],
      },
      { name: "run", kind: K.Function, from: 7, to: 7, nameLine: 7 },
      { name: "Local", kind: K.Class, from: 9, to: 10, nameLine: 9, children: [{ name: "__slots__", kind: K.Variable, from: 10, to: 10, nameLine: 10 }] },
      { name: "Sub", kind: K.Class, from: 11, to: 11, nameLine: 11 },
      { name: "SubKeep", kind: K.Class, from: 12, to: 13, nameLine: 12, children: [{ name: "__slots__", kind: K.Variable, from: 13, to: 13, nameLine: 13 }] },
    ],
    hovers: {
      Local: "```python\nclass Local\n```\n---\nA slotted local.\n\n@STRUCT",
      Child: "```python\nclass Child(Slotted)\n```\n---\nDeprecated: use Sub.",
    },
  });
  world.declared.set("Slotted", { uri: base.uri.toString(), line: 0 });
  for (const [name, line] of [["Child", 1], ["GrandChild", 2], ["Plain", 3], ["Ctx", 4], ["Local", 9], ["Sub", 11], ["SubKeep", 12]] as const) {
    world.declared.set(name, { uri: main.uri.toString(), line });
  }
  world.bases.set("Child", ["Slotted"]);
  world.bases.set("GrandChild", ["Child"]);
  world.bases.set("Sub", ["Local"]);
  world.bases.set("SubKeep", ["Local"]);
  return { base, main };
}

let d: TokenDecorator | undefined;
beforeEach(() => reset());
afterEach(() => d?.dispose());

/** Shows main.py, sets up these rules and waits for both passes. */
async function draw(global: string[], projectRules?: string[]) {
  const files = project();
  show(files.main);
  d = decorator(global, projectRules && { folder: "file:///proj", rules: projectRules });
  await settle(120);
  return files;
}

describe("drawing", () => {
  it("the most specific rule wins, the later one among equals", async () => {
    const { main } = await draw([
      'text("__slots__") variable.classMember = #222222',
      'text("__*__") * = #111111',
      'text("__*__") method = #333333',
      'text("__e*") method = #444444',
    ]);
    // Exact text beats a wildcard; a type beats *; of two equal rules the later one wins.
    assert.deepEqual(colors(main), { "#222222": ["10:__slots__", "13:__slots__"], "#444444": ["6:__enter__"] });
  });

  it("plain selectors in the global rules go to settings, not decorations", async () => {
    const { main } = await draw(["class = #111111"]);
    assert.deepEqual(colors(main), {});
  });

  it("only draws project rules in their folder", async () => {
    world.folders = [];
    const other = addFile("file:///pro/x.py", { lines: ["class A: pass"], tokens: [{ line: 0, text: "A", type: "class", modifiers: ["declaration"] }] });
    const files = project();
    show(files.main);
    show(other);
    d = decorator(['text("A") class = #111111'], { folder: "file:///proj", rules: ["class = #222222"] });
    await settle(120);
    assert.deepEqual(Object.keys(colors(files.main)), ["#222222"]);
    // /pro is a prefix of /proj, but another folder.
    assert.deepEqual(colors(other), { "#111111": ["0:A"] });
  });
});

describe("symbol conditions", () => {
  it("contains: classes with a matching member, at their uses too, also from other files", async () => {
    const { main } = await draw([`${SLOTS} class = #AA0000`]);
    // Slotted is defined in base.py; its uses here are found through go to definition.
    assert.deepEqual(colors(main), { "#AA0000": ["0:Slotted", "1:Slotted", "9:Local", "11:Local", "12:SubKeep", "12:Local"] });
  });

  it("within: tokens inside a matching symbol", async () => {
    const { main } = await draw(['within(class text("Ctx")) method = #AA0000']);
    assert.deepEqual(colors(main), { "#AA0000": ["5:run", "6:__enter__"] });
  });

  it("inherits: types with a matching base, directly or further up, in any file", async () => {
    const { main } = await draw([`inherits(${SLOTS}) class = #AA0000`]);
    assert.deepEqual(colors(main), { "#AA0000": ["1:Child", "2:GrandChild", "2:Child", "8:GrandChild", "11:Sub", "12:SubKeep"] });
  });

  it("decorated: works whether or not the symbol range includes the decorators", async () => {
    for (const includes of [true, false]) {
      reset();
      const doc = addFile("file:///d.py", {
        lines: ["@dataclass", "class Point:", "    @staticmethod", "    def make(): ...", "@other", "class Plain: pass", "p = Point()"],
        tokens: [
          { line: 0, text: "dataclass", type: "decorator" },
          { line: 1, text: "Point", type: "class", modifiers: ["declaration"] },
          { line: 2, text: "staticmethod", type: "decorator" },
          { line: 3, text: "make", type: "method", modifiers: ["declaration"] },
          { line: 4, text: "other", type: "decorator" },
          { line: 5, text: "Plain", type: "class", modifiers: ["declaration"] },
          { line: 6, text: "Point", type: "class" },
        ],
        symbols: [
          { name: "Point", kind: K.Class, from: includes ? 0 : 1, to: 3, nameLine: 1, children: [{ name: "make", kind: K.Method, from: includes ? 2 : 3, to: 3, nameLine: 3 }] },
          { name: "Plain", kind: K.Class, from: includes ? 4 : 5, to: 5, nameLine: 5 },
        ],
      });
      show(doc);
      d?.dispose();
      d = decorator(['decorated(text("dataclass")) class = #AA0000', 'decorated(text("staticmethod")) method = #00AA00']);
      await settle(80);
      assert.deepEqual(colors(doc), { "#AA0000": ["1:Point", "6:Point"], "#00AA00": ["3:make"] }, `range includes decorators: ${includes}`);
    }
  });
});

describe("what real servers do differently", () => {
  it("symbol names with signatures still match their tokens (C#)", async () => {
    const doc = addFile("file:///c.cs", {
      language: "csharp",
      lines: ["class Point {", "  [Obsolete]", "  Point Make() { return new Point(); }", "}"],
      tokens: [
        { line: 0, text: "Point", type: "class", modifiers: ["declaration"] },
        { line: 1, text: "Obsolete", type: "class" },
        { line: 2, text: "Make", type: "method", modifiers: ["declaration"] },
        { line: 2, text: "Point", type: "class", nth: 1 },
      ],
      symbols: [{ name: "Point", kind: K.Class, from: 0, to: 3, nameLine: 0, children: [{ name: "Make", label: "Make() : Point", kind: K.Method, from: 1, to: 2, nameLine: 2 }] }],
    });
    show(doc);
    d = decorator(['decorated(text("Obsolete")) method = #AA0000', 'contains(text("Point") class) method = #00AA00']);
    await settle(80);
    // Equally specific; the later rule wins.
    assert.deepEqual(colors(doc), { "#00AA00": ["2:Make"] });
  });

  it("Markdown escapes in hovers aren't documentation (C#)", async () => {
    world.folders = [];
    const doc = addFile("file:///e.cs", {
      language: "csharp",
      lines: ["class A {}"],
      tokens: [{ line: 0, text: "A", type: "class", modifiers: ["declaration"] }],
      hovers: { A: "```csharp\r\nclass A\r\n```\r\n  \r\nA marker\\. Done\\!  \r\n" },
    });
    show(doc);
    d = decorator(['doc("A marker. Done!") = #AA0000']);
    await settle(80);
    assert.deepEqual(colors(doc), { "#AA0000": ["0:A"] });
  });
});

describe("custom modifiers", () => {
  const TAGS = [`language(python) ${SLOTS} class += slotted`, "inherits(class.slotted) & !class.slotted += leaky"];

  it("are assigned in order, reach base types in other files and uses through definitions", async () => {
    const { main } = await draw(["class.slotted = #AA0000", "class.leaky = #00AA00"], TAGS);
    assert.deepEqual(colors(main), {
      "#AA0000": ["0:Slotted", "1:Slotted", "9:Local", "11:Local", "12:SubKeep", "12:Local"],
      "#00AA00": ["1:Child", "2:GrandChild", "2:Child", "8:GrandChild", "11:Sub"],
    });
    assert.ok(world.output.some((l) => l.includes("modifiers from there: Slotted <- base.py: slotted")), world.output.join("\n"));
  });

  it("Inspect Token tells where they came from and what is drawn", async () => {
    const { main } = await draw(["class.slotted = #AA0000", 'text("Slotted") class = #0000AA'], TAGS);
    const lines = await d!.inspect(main as any, new Position(1, 13) as any);
    assert.deepEqual(lines, [
      "'Slotted'  class, python",
      "  modifiers from the language server: none",
      "  servers: test.test-language-server  (server(...) matches these)",
      "  custom modifier slotted: from the definition in base.py",
      '  drawn: class.slotted = "#AA0000"  (global rules, line 1)',
      '  also matches: text("Slotted") class = "#0000AA"  (global rules, line 2)',
    ]);
  });
});

describe("hovers", () => {
  it("doc() matches the prose, signature() the code, any case for globs", async () => {
    const { main } = await draw(['doc("*@struct*") class = #AA0000', 'signature("*(Slotted)*") class = #00AA00', 'doc("*class Local*") = #0000AA']);
    assert.deepEqual(colors(main), { "#AA0000": ["9:Local", "11:Local", "12:Local"], "#00AA00": ["1:Child", "2:Child"] });
  });

  it("regular expressions take their own flags, and --- separators aren't documentation", async () => {
    const { main } = await draw(["doc(/^deprecated/) = #AA0000", "doc(/^deprecated/i) = #00AA00", "text(/^Sub/) class = #0000AA"]);
    assert.deepEqual(colors(main), { "#00AA00": ["1:Child", "2:Child"], "#0000AA": ["11:Sub", "12:SubKeep"] });
  });

  it("aren't asked for when no rule needs them", async () => {
    await draw(["class = #111111"]);
    assert.equal(world.requests.hover, 0);
  });
});

describe("messages", () => {
  it("go on every matching token, with {text} and the name as code", async () => {
    const { main } = await draw([], [...["inherits(class.slotted) & !class.slotted += leaky", `${SLOTS} class += slotted`].reverse(), 'class.leaky & class.declaration := warn(leaky-slots, "{text} gets a __dict__ again")']);
    assert.deepEqual(messages(main), ["1:Child gets a __dict__ again", "2:GrandChild gets a __dict__ again", "11:Sub gets a __dict__ again"]);
    assert.deepEqual(world.diagnostics.get(main.uri.toString())!.map((x) => [x.code, x.source]), Array(3).fill(["leaky-slots", "Semantic Theme Extender"]));
  });

  it("are silenced by a marker on the line or alone above, by name or all", async () => {
    world.folders = [];
    const doc = addFile("file:///m.py", {
      lines: ["class A: pass  # semantic-theme: ignore", "# semantic-theme: ignore named", "class B: pass", "class C: pass  # semantic-theme: ignore other", "x = 1  # semantic-theme: ignore", "class D: pass"],
      tokens: ["A", "B", "C", "D"].map((t, k) => ({ line: [0, 2, 3, 5][k], text: t, type: "class", modifiers: ["declaration"] })),
    });
    show(doc);
    d = decorator(['class := warn(named, "{text}")']);
    await settle(80);
    // A: same line; B: alone above, by name; C: another name; D: the marker above ends a code line.
    assert.deepEqual(messages(doc), ["3:C", "5:D"]);
  });

  it("offer a quick fix that adds the marker in the language's comment syntax", () => {
    d = new TokenDecorator(() => undefined, "x");
    const fix = world.codeActionProviders.at(-1);
    const doc = addFile("file:///q.py", { lines: ["class A:", "    class B(Base): pass"], tokens: [] });
    const diagnostic = { source: "Semantic Theme Extender", code: "leaky-slots", range: { start: { line: 1 } } };
    const pylance = { source: "Pylance", code: "x", range: { start: { line: 1 } } };
    const actions = fix.provideCodeActions(doc, undefined, { diagnostics: [diagnostic, pylance] });
    assert.deepEqual(actions.map((a: any) => [a.title, a.edit.inserts[0].at.line, a.edit.inserts[0].text]), [
      ["Ignore leaky-slots here", 1, "    # semantic-theme: ignore leaky-slots\n"],
    ]);
    const md = addFile("file:///q.md", { lines: ["x"], language: "markdown", tokens: [] });
    assert.deepEqual(fix.provideCodeActions(md, undefined, { diagnostics: [diagnostic] }), []);
  });
});
