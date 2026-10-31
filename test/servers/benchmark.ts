// npm run bench: what a large rules file costs on a large file, with and without deciding
// language() / server() per document first. Not a test: it prints numbers.
//
// 1. With basedpyright: a generated Python file of CLASSES classes, rules for three languages with
//    the expensive conditions (inherits, doc, contains, decorated). Measures the work up to a full
//    answer (Inspect Token waits for everything: tokens, symbols, hovers, hierarchy, definitions)
//    and the language server requests it took.
// 2. With the scripted server (no requests): how long drawing takes for tokens x rules alone.

import { addFile, drawn, Position, reset, show, Uri, world } from "../fake-vscode";
import * as fs from "fs";
import * as path from "path";
import { TokenDecorator, tuning } from "../../src/decorations";
import { decorator } from "../helpers";
import { RealServer, SERVERS, unavailable } from "./real-server";

const CLASSES = 400;
const RULES_PER_LANGUAGE = 100;
const BIG = "bench_big.py";

function bigFile(): string {
  const out = ["from dataclasses import dataclass", ""];
  for (let i = 0; i < CLASSES; i++) {
    if (i % 10 === 0) out.push("@dataclass");
    out.push(`class C${i}${i % 5 ? `(C${i - 1})` : ""}:`);
    out.push(`    """Class number ${i}.${i % 7 === 0 ? " marker" : ""}"""`);
    if (i % 3 === 0) out.push(`    __slots__ = ("a${i}",)`);
    out.push(`    def method${i}(self, x: int) -> int:`, `        return x + ${i}`, "");
  }
  out.push(`x = C${CLASSES - 1}()`);
  return out.join("\n");
}

/** Rules for python, csharp and typescript: mostly cheap text rules, some expensive ones each. */
function rules(): string[] {
  const out: string[] = [];
  for (const language of ["python", "csharp", "typescript"]) {
    const block = [
      `inherits(text("C${language.length}")) class = #AA0000`,
      'doc("*marker*") class = #00AA00',
      'contains(text("__slots__")) class = #0000AA',
      'decorated(text("dataclass")) class = #AAAA00',
    ];
    for (let k = block.length; k < RULES_PER_LANGUAGE; k++) block.push(`text("C${k}*") method = #00AAAA`);
    out.push(`language(${language}) {`, ...block.map((r) => `  ${r}`), "}");
  }
  return out;
}

const ms = (t: number) => `${Math.round(performance.now() - t)} ms`.padStart(8);

async function withServer() {
  const spec = SERVERS.python;
  if (unavailable(spec)) return console.log(`skipped: ${unavailable(spec)}`);
  const file = path.join(__dirname, "..", "..", "..", "test", "fixtures", "projects", "python", BIG);
  fs.writeFileSync(file, bigFile());
  const server = await RealServer.start(spec);
  try {
    console.log(`\n${spec.name}: ${CLASSES} classes (${bigFile().split("\n").length} lines), ${rules().length} rule lines for 3 languages`);
    // The server's own first analysis, once, outside the measurements.
    reset();
    server.install();
    await server.settledTokens(server.doc(BIG).uri);
    for (const fold of [false, true, false, true]) {
      tuning.fold = fold;
      reset();
      server.install();
      const doc = server.doc(BIG);
      const d: TokenDecorator = decorator(rules());
      const t = performance.now();
      await d.inspect(doc as any, new Position(doc.lines.length - 1, 4) as any);
      const r = world.requests;
      console.log(`  folding ${fold ? "on " : "off"}: ${ms(t)}   hovers ${r.hover}, definitions ${r.definition}, type hierarchy ${r.typeHierarchy}`);
      d.dispose();
    }
  } finally {
    tuning.fold = true;
    await server.stop();
    fs.rmSync(file, { force: true });
  }
}

/** Drawing a file with these many tokens and text rules, no language server work. */
async function drawingOnly(tokens: number, ruleCount: number) {
  reset();
  world.folders = [{ uri: Uri.parse("file:///proj"), name: "proj", index: 0 }];
  const lines = Array.from({ length: tokens }, (_, i) => `name${i} = 1`);
  const doc = addFile("file:///proj/big.py", { lines, tokens: lines.map((_, i) => ({ line: i, text: `name${i}`, type: "variable" })) });
  show(doc);
  const rs = Array.from({ length: ruleCount }, (_, k) => `text("name${k}*") variable = #${(0x100000 + k * 997).toString(16).slice(-6)}`);
  const t = performance.now();
  const d = decorator(rs);
  while (!Object.keys(drawn(doc)).length) await new Promise((r) => setTimeout(r, 1));
  console.log(`  ${String(tokens).padStart(6)} tokens x ${String(ruleCount).padStart(4)} rules: ${ms(t)}`);
  d.dispose();
}

async function main() {
  await withServer();
  console.log("\ndrawing only (scripted server, text rules):");
  for (const [tokens, ruleCount] of [[5000, 10], [5000, 100], [5000, 300], [20000, 300]]) await drawingOnly(tokens, ruleCount);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
