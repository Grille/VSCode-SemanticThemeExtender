import { strict as assert } from "assert";
import * as vscode from "vscode";
import { drawnColor, eventually, inspect, open, setProjectRules, setRules, tokens, unsupportedWarnings } from "./common";

describe("Python, with Pylance", () => {
  let main: vscode.TextDocument;
  before(async () => {
    main = await open("python/main.py");
  });
  after(() => setProjectRules("python"));

  describe("what Pylance reports", () => {
    it("token types of __slots__ and decorators", async () => {
      // basedpyright says property.static.classMember for __slots__; Pylance a variable.
      const base = await open("python/base.py");
      await eventually(async () => assert.deepEqual(await tokens(base, (t) => t === "__slots__"), ["3:__slots__=variable.declaration.classMember"]));
      main = await open("python/main.py");
      await eventually(async () =>
        assert.deepEqual(await tokens(main, (t) => ["dataclass", "staticmethod"].includes(t)), [
          "0:dataclass=function.library",
          "18:dataclass=function.decorator.library",
          "22:staticmethod=class.decorator.builtin",
        ]),
      );
    });

    it("the type hierarchy reaches across files", async () => {
      const chain = await eventually(async () => {
        let [item] = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.prepareTypeHierarchy", main.uri, new vscode.Position(10, 7));
        const names = [];
        while (item) {
          names.push(`${item.name}@${item.uri.path.split("/").pop()}`);
          [item] = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.provideSupertypes", item);
        }
        assert.ok(names.length > 2, names.join(" > "));
        return names;
      });
      assert.deepEqual(chain, ["GrandChild@main.py", "Child@main.py", "Slotted@base.py", "object@builtins.pyi"]);
    });
  });

  describe("the extension", () => {
    it("inherits(): subclasses, across files", async () => {
      await setRules('inherits(text("Slotted")) class = #AA0000');
      await eventually(async () => assert.equal(await drawnColor(main, 32, "GrandChild"), "#AA0000"));
      assert.equal(await drawnColor(main, 14, "Keep"), "#AA0000");
      assert.equal(await drawnColor(main, 19, "Point"), undefined);
      // Pylance has a type hierarchy: no warning on the rule.
      assert.deepEqual(unsupportedWarnings("python"), []);
    });

    it("inherits(): the builtin tuple, not a class of the same name", async () => {
      // Pylance marks builtins where builtins.pyi declares them too: class.declaration.builtin.
      await setRules('inherits(text("tuple") & class.builtin) class = #00AAAA', 'inherits(text("tuple") & !class.builtin) class = #AA00AA');
      await eventually(async () => assert.equal(await drawnColor(main, 35, "Pair"), "#00AAAA"));
      const shadow = await open("python/shadow.py");
      await eventually(async () => assert.equal(await drawnColor(shadow, 4, "Fake"), "#AA00AA"));
      main = await open("python/main.py");
    });

    it("custom modifiers from project rules reach other files", async () => {
      await setProjectRules("python", 'contains(text("__slots__") variable.classMember) class += slotted');
      await setRules("class.slotted = #00AA00");
      await eventually(async () => assert.equal(await drawnColor(main, 3, "Slotted"), "#00AA00"));
      assert.ok((await inspect(main, 3, "Slotted")).some((l) => l.startsWith("  custom modifier slotted:")));
      await setProjectRules("python");
    });

    it("decorated(): @dataclass", async () => {
      await setRules('decorated(text("dataclass")) class = #0000AA');
      await eventually(async () => assert.equal(await drawnColor(main, 19, "Point"), "#0000AA"));
      assert.equal(await drawnColor(main, 6, "Child"), undefined);
    });

    it("doc() and messages", async () => {
      await setRules('doc("*@struct*") class = #AA00AA', 'doc("deprecated*") function := warn(deprecated, "{text} is deprecated")');
      await eventually(async () => assert.equal(await drawnColor(main, 6, "Slotted"), "#AA00AA"));
      await eventually(() =>
        assert.deepEqual(
          vscode.languages.getDiagnostics(main.uri).filter((d) => d.source === "Semantic Theme Extender").map((d) => `${d.range.start.line}:${d.message}`),
          ["27:handler is deprecated"],
        ),
      );
    });

    it("server(): rules for what Pylance reports, not basedpyright", async () => {
      await setRules(
        'server(ms-python.vscode-pylance) text("__slots__") variable.classMember = #AA0000',
        'server(detachhead.basedpyright) text("__slots__") property.classMember = #00AA00',
      );
      await eventually(async () => assert.equal(await drawnColor(main, 15, "__slots__"), "#AA0000"));
      const servers = (await inspect(main, 15, "__slots__")).find((l) => l.startsWith("  servers: "));
      assert.ok(servers?.includes("ms-python.vscode-pylance"), servers);
    });
  });
});
