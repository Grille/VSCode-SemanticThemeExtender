import { drawn, FakeDoc, Position, reset, show, world } from "../fake-vscode";
import { strict as assert } from "assert";
import { after, before, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";
import { TokenDecorator } from "../../src/decorations";
import { decorator, eventually } from "../helpers";
import { RealServer, SERVERS, unavailable } from "./real-server";

const spec = SERVERS.typescript;

function colors(doc: FakeDoc): Record<string, string[]> {
  return Object.fromEntries(Object.entries(drawn(doc)).map(([k, v]) => [JSON.parse(k).color, v]));
}

const messages = (doc: FakeDoc) => (world.diagnostics.get(doc.uri.toString()) ?? []).map((m: any) => `${m.range.start.line}:${m.message}`);

const run = (command: string, ...args: unknown[]) => vscode.commands.executeCommand<any>(command, ...(args as []));

describe(`TypeScript, with ${spec.name}`, { skip: unavailable(spec) }, () => {
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

  async function expect(global: string[], expected: Record<string, string[]>) {
    const main = server.doc("main.ts");
    show(main);
    d = decorator(global, undefined);
    await eventually(() => assert.deepEqual(colors(main), expected));
    return main;
  }

  describe("what the server reports", () => {
    it("token types: decorators are functions, methods are 'member'", async () => {
      const main = server.doc("main.ts");
      const tokens = await server.describeTokens(main, (t) => ["sealed", "Point", "make"].includes(t));
      assert.deepEqual(tokens, ["2:sealed=function.declaration", "8:sealed=function", "9:Point=class.declaration", "11:make=member.declaration.static", "11:Point=class", "12:Point=class"]);
    });

    it("symbol ranges include decorators", async () => {
      const main = server.doc("main.ts");
      const symbols = await run("vscode.executeDocumentSymbolProvider", main.uri);
      const point = symbols.find((s: any) => s.name === "Point");
      assert.deepEqual([point.range.start.line, point.selectionRange.start.line], [8, 9]);
    });

    it("hovers: a blank line, the signature, then docs with JSDoc tags in Markdown", async () => {
      const main = server.doc("main.ts");
      const [hover] = await run("vscode.executeHoverProvider", main.uri, new Position(4, 28));
      assert.equal(hover.contents[0].value, "\n```typescript\n(alias) class Slotted\nimport Slotted\n```\nA base with a marker.\n\n*@struct*");
    });

    it("go to definition on a constructor call gives the class and the inherited constructor", async () => {
      const main = server.doc("main.ts");
      const defs = await run("vscode.executeDefinitionProvider", main.uri, new Position(21, 21));
      assert.deepEqual(
        defs.map((x: any) => `${(x.targetUri ?? x.uri).path.split("/").pop()}:${(x.targetSelectionRange ?? x.range).start.line}`),
        ["main.ts:6", "base.ts:2"],
      );
    });

    it("has no type hierarchy", async () => {
      const main = server.doc("main.ts");
      assert.deepEqual(await run("vscode.prepareTypeHierarchy", main.uri, new Position(6, 13)), []);
    });
  });

  describe("the decorator", () => {
    it("decorated(): decorators that are function tokens", async () => {
      await expect(['decorated(text("sealed")) class = #AA0000'], { "#AA0000": ["9:Point", "11:Point", "12:Point"] });
    });

    it("contains(): members by name", async () => {
      await expect(['contains(text("make")) class = #AA0000'], { "#AA0000": ["9:Point", "11:Point", "12:Point"] });
    });

    it("doc() and signature() read the hover, messages go on matches", async () => {
      const main = await expect(['doc("*@struct*") class = #AA0000', 'doc(/@deprecated/) function := warn(deprecated, "{text} is deprecated")'], {
        // Names in import lines get no semantic token from this server.
        "#AA0000": ["4:Slotted"],
      });
      assert.deepEqual(messages(main), ["17:handler is deprecated"]);
      reset();
      server.install();
      d?.dispose();
      const again = await expect(["signature(/^\\(alias\\) class Slotted$/m) = #00AA00"], { "#00AA00": ["4:Slotted"] });
      void again;
    });
  });
});
