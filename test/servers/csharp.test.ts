import { addExtension, drawn, FakeDoc, Position, reset, show, world } from "../fake-vscode";
import { strict as assert } from "assert";
import * as path from "path";
import { after, before, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";
import { TokenDecorator } from "../../src/decorations";
import { decorator, eventually } from "../helpers";
import { normalize, RealServer, SERVERS, unavailable, uriOf } from "./real-server";

const spec = SERVERS.csharp;

function colors(doc: FakeDoc): Record<string, string[]> {
  return Object.fromEntries(Object.entries(drawn(doc)).map(([k, v]) => [JSON.parse(k).color, v]));
}

const messages = (doc: FakeDoc) => (world.diagnostics.get(doc.uri.toString()) ?? []).map((m: any) => `${m.range.start.line}:${m.message}`);

const run = (command: string, ...args: unknown[]) => vscode.commands.executeCommand<any>(command, ...(args as []));

describe(`C#, with ${spec.name}`, { skip: unavailable(spec) }, () => {
  let server: RealServer;
  let d: TokenDecorator | undefined;
  before(async () => {
    // The C# extension's own token types (field, recordClass, ...), as VS Code knows them.
    addExtension(path.dirname(path.dirname(spec.command)));
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

  async function expect(global: string[], expected: Record<string, string[]>) {
    const main = server.doc("Main.cs");
    show(main);
    d = decorator(global, undefined);
    await eventually(() => assert.deepEqual(colors(main), expected), 60_000);
    return main;
  }

  describe("what the server reports", () => {
    it("token types: attributes are classes; two surprises", async () => {
      const main = server.doc("Main.cs");
      const tokens = await server.describeTokens(main, (t) => ["Slotted", "Serializable", "Obsolete", "Make", "X"].includes(t));
      // An [Obsolete] method is type 0 (namespace) plus deprecated, without "method": VS Code
      // shows the same (checked with Developer: Inspect Editor Tokens and Scopes).
      // A base type from another file comes as a variable here, but as a class in VS Code
      // (test/vscode): Roslyn says variable while it doesn't have the project, and project/open
      // alone apparently doesn't give it all of it. Not timing, request kind, client
      // capabilities, open files or URI spelling.
      assert.deepEqual(tokens, ["4:Slotted=variable", "14:Serializable=class", "17:X=field", "19:Obsolete=class", "20:Make=namespace.deprecated"]);
    });

    it("symbol ranges include attributes; names include signatures", async () => {
      const main = server.doc("Main.cs");
      const [ns] = await run("vscode.executeDocumentSymbolProvider", main.uri);
      const point = ns.children.find((s: any) => s.name === "Point");
      assert.deepEqual([point.range.start.line, point.selectionRange.start.line], [14, 15]);
      assert.deepEqual(point.children.map((s: any) => s.name), ["X : int", "Make() : Point"]);
    });

    it("hovers: the signature in a code block, then Markdown-escaped docs", async () => {
      const main = server.doc("Main.cs");
      const [hover] = await run("vscode.executeHoverProvider", main.uri, new Position(4, 21));
      assert.equal(hover.contents[0].value, "```csharp\r\nclass Fixture.Slotted\r\n```\r\n  \r\nA base with a marker\\. @struct  \r\n");
    });

    it("go to definition on a constructor call gives the constructor", async () => {
      const main = server.doc("Main.cs");
      const [def] = await run("vscode.executeDefinitionProvider", main.uri, new Position(28, 46));
      const target = def.targetUri ?? def.uri;
      assert.deepEqual([target.path.split("/").pop(), (def.targetSelectionRange ?? def.range).start.line], ["Main.cs", 11]);
    });

    it("the type hierarchy reaches across files", async () => {
      const main = server.doc("Main.cs");
      let [item] = await run("vscode.prepareTypeHierarchy", main.uri, new Position(9, 13));
      const chain = [];
      while (item) {
        chain.push(`${item.name}@${item.uri.path.split("/").pop()}`);
        [item] = await run("vscode.provideSupertypes", item);
      }
      assert.deepEqual(chain, ["GrandChild@Main.cs", "Child@Main.cs", "Slotted@Base.cs"]);
    });
  });

  describe("the decorator", () => {
    it("inherits(): through the type hierarchy, across files", async () => {
      await expect(['inherits(text("Slotted")) class = #AA0000'], { "#AA0000": ["4:Child", "6:Child", "9:GrandChild", "9:Child", "11:GrandChild", "28:GrandChild", "28:GrandChild"] });
    });

    it("decorated(): attributes, on classes and on members", async () => {
      // Not "method": Roslyn reports obsolete members without their type (see above).
      await expect(['decorated(text("Serializable")) class = #AA0000', 'decorated(text("Obsolete")) = #00AA00'], {
        "#AA0000": ["15:Point", "20:Point", "20:Point"],
        "#00AA00": ["20:Make"],
      });
    });

    it("contains(): members are matched by their name, not their signature", async () => {
      await expect(['contains(text("callback") parameter) method = #AA0000', 'contains(text("X") field) class = #00AA00'], {
        "#AA0000": ["26:handler"],
        "#00AA00": ["15:Point", "20:Point", "20:Point"],
      });
    });

    it("doc() reads the documentation without Markdown escapes", async () => {
      // No "class": here this Slotted comes as a variable (see above).
      const main = await expect(['doc("*marker. @struct*") = #AA0000'], { "#AA0000": ["4:Slotted"] });
      assert.deepEqual(messages(main), []);
    });
  });
});

// Kept for the project-rules path, which the other suites cover.
void normalize;
void uriOf;
