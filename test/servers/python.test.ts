import { drawn, FakeDoc, Position, reset, show, world } from "../fake-vscode";
import { strict as assert } from "assert";
import { after, before, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";
import { TokenDecorator } from "../../src/decorations";
import { decorator, eventually } from "../helpers";
import { normalize, RealServer, SERVERS, unavailable, uriOf } from "./real-server";

const spec = SERVERS.python;

/** What a document shows: color to "line:text" of each token. */
function colors(doc: FakeDoc): Record<string, string[]> {
  return Object.fromEntries(Object.entries(drawn(doc)).map(([k, v]) => [JSON.parse(k).color, v]));
}

const messages = (doc: FakeDoc) => (world.diagnostics.get(doc.uri.toString()) ?? []).map((m: any) => `${m.range.start.line}:${m.message}`);

const run = (command: string, ...args: unknown[]) => vscode.commands.executeCommand<any>(command, ...(args as []));

describe(`Python, with ${spec.name}`, { skip: unavailable(spec) }, () => {
  let server: RealServer;
  let d: TokenDecorator | undefined;
  before(async () => {
    server = await RealServer.start(spec);
  });
  after(async () => {
    d?.dispose();
    await server?.stop();
  });
  beforeEach(() => {
    d?.dispose();
    d = undefined;
    reset();
    server.install();
  });

  /** Shows main.py with these rules and waits until it looks like expected. */
  async function expect(global: string[], expected: Record<string, string[]>, project?: string[]) {
    const main = server.doc("main.py");
    show(main);
    d = decorator(global, project && { folder: normalize(uriOf(server.root)), rules: project });
    await eventually(() => assert.deepEqual(colors(main), expected));
  }

  describe("what the server reports", () => {
    it("token types: __slots__ is a property, decorators are their own type", async () => {
      const main = server.doc("main.py");
      const tokens = await server.describeTokens(main, (t) => ["__slots__", "dataclass", "Point", "make"].includes(t));
      assert.deepEqual(tokens, [
        "0:dataclass=function",
        "15:__slots__=property.static.classMember",
        "18:dataclass=decorator",
        "19:Point=class.declaration",
        "23:make=method.declaration.static.classMember",
        "23:Point=class",
        "24:Point=class",
      ]);
    });

    it("symbol ranges include decorators", async () => {
      const main = server.doc("main.py");
      const symbols = await run("vscode.executeDocumentSymbolProvider", main.uri);
      const point = symbols.find((s: any) => s.name === "Point");
      assert.deepEqual([point.range.start.line, point.selectionRange.start.line], [18, 19]);
      const make = point.children.find((s: any) => s.name === "make");
      assert.deepEqual([make.range.start.line, make.selectionRange.start.line], [22, 23]);
    });

    it("hovers: the signature in a code block, ---, then the docstring, also a base class's", async () => {
      const main = server.doc("main.py");
      const [hover] = await run("vscode.executeHoverProvider", main.uri, new Position(6, 12));
      assert.equal(hover.contents[0].value, "```python\nclass Slotted(a: int)\n```\n---\nA class with slots. @struct");
      // GrandChild has no docstring of its own: its hover shows the one it inherits.
      const [grand] = await run("vscode.executeHoverProvider", main.uri, new Position(10, 6));
      assert.match(grand.contents[0].value, /@struct$/);
    });

    it("go to definition on a constructor call gives the class", async () => {
      const main = server.doc("main.py");
      const [def] = await run("vscode.executeDefinitionProvider", main.uri, new Position(32, 4));
      // A plain location, not a link.
      assert.deepEqual([def.uri.path.split("/").pop(), def.range.start.line], ["main.py", 10]);
    });

    it("has no type hierarchy, unlike Pylance", async () => {
      const main = server.doc("main.py");
      assert.deepEqual(await run("vscode.prepareTypeHierarchy", main.uri, new Position(10, 6)), []);
    });
  });

  describe("the decorator", () => {
    it("decorated(): classes and methods by their decorators", async () => {
      await expect(['decorated(text("dataclass")) class = #AA0000', 'decorated(text("staticmethod")) method = #00AA00'], {
        "#AA0000": ["19:Point", "23:Point", "24:Point"],
        "#00AA00": ["23:make"],
      });
    });

    it("contains(): also for names defined in another file", async () => {
      // Slotted is defined in base.py; its uses here are matched through go to definition.
      await expect(['contains(text("__slots__") *.classMember) class = #AA0000'], { "#AA0000": ["3:Slotted", "6:Slotted", "14:Keep", "14:Slotted"] });
    });

    it("custom modifiers come along from the definition", async () => {
      await expect(["class.slotted = #AA0000"], { "#AA0000": ["3:Slotted", "6:Slotted", "14:Keep", "14:Slotted"] }, [
        'contains(text("__slots__") *.classMember) class += slotted',
      ]);
    });

    it("doc() and signature() read the hover", async () => {
      await expect(["doc(/^deprecated/i) function = #AA0000", "signature(/^class Slotted\\b/) = #0000AA", 'signature(/-> None$/m) function := info(none, "{text} returns None")'], {
        "#AA0000": ["27:handler"],
        "#0000AA": ["3:Slotted", "6:Slotted", "14:Slotted"],
      });
      assert.deepEqual(messages(server.doc("main.py")), ["27:handler returns None"]);
    });
  });
});
