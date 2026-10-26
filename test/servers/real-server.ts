// Runs the decorator against a real language server: the fake vscode module's language server
// commands become LSP requests, and documents are the files of a fixture project on disk.

import { addDocument, FakeDoc, Range, Uri, useLanguageServer, world } from "../fake-vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LspClient } from "../lsp";

const repo = path.join(__dirname, "..", "..", "..");
const bin = (...p: string[]) => path.join(repo, "node_modules", ...p);

export interface ServerSpec {
  name: string;
  /** Folder under test/fixtures/projects. */
  dir: string;
  languages: Record<string, string>;
  command: string;
  args: string[];
  initializationOptions?: unknown;
  /** After initialize, e.g. loading a project; files are opened afterwards. */
  prepare?(client: LspClient, root: string): Promise<void>;
}

export const SERVERS: Record<"python" | "typescript" | "csharp", ServerSpec> = {
  python: {
    name: "basedpyright",
    dir: "python",
    languages: { ".py": "python" },
    command: process.execPath,
    args: [bin("basedpyright", "langserver.index.js"), "--stdio"],
  },
  typescript: {
    name: "typescript-language-server",
    dir: "typescript",
    languages: { ".ts": "typescript" },
    command: process.execPath,
    args: [bin("typescript-language-server", "lib", "cli.mjs"), "--stdio"],
    initializationOptions: { tsserver: { path: bin("typescript", "lib", "tsserver.js") } },
  },
  csharp: {
    name: "Roslyn (C# extension)",
    dir: "csharp",
    languages: { ".cs": "csharp" },
    command: roslyn() ?? "",
    args: ["--stdio", "--logLevel", "Warning", "--extensionLogDirectory", path.join(os.tmpdir(), "semantic-theme-roslyn-log")],
    async prepare(client, root) {
      const project = fs.readdirSync(root).find((f) => f.endsWith(".csproj"))!;
      client.notify("project/open", { projects: [uriOf(path.join(root, project))] });
      await until(() => client.notifications.some((n) => n.method === "workspace/projectInitializationComplete"), 120_000);
    },
  },
};

/** The Roslyn language server of the newest installed C# extension, if any. */
function roslyn(): string | undefined {
  const dir = path.join(os.homedir(), ".vscode", "extensions");
  const ext = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => d.startsWith("ms-dotnettools.csharp-")).sort().pop() : undefined;
  const exe = ext && path.join(dir, ext, ".roslyn", process.platform === "win32" ? "Microsoft.CodeAnalysis.LanguageServer.exe" : "Microsoft.CodeAnalysis.LanguageServer");
  return exe && fs.existsSync(exe) ? exe : undefined;
}

/** Why a server can't run here, or undefined. */
export function unavailable(spec: ServerSpec): string | undefined {
  if (!spec.command || !fs.existsSync(spec.command)) return `${spec.name} is not installed`;
  if (spec.args[0] && spec.args[0].endsWith(".js") && !fs.existsSync(spec.args[0])) return `${spec.name} is not installed (npm install)`;
  return undefined;
}

async function until(done: () => boolean, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

const slash = (p: string) => p.split(path.sep).join("/");
export const uriOf = (p: string) => (p.startsWith("/") ? `file://${slash(p)}` : `file:///${slash(p)}`);

/** Servers spell the same file differently (c%3A, lower-case drives); one spelling for all. */
export function normalize(uri: string): string {
  return decodeURIComponent(uri).replace(/^file:\/\/\/([a-z]):/, (_, d: string) => `file:///${d.toUpperCase()}:`);
}

const pathOf = (uri: string) => normalize(uri).replace(/^file:\/\/\/?(?=[A-Za-z]:)/, "").replace(/^file:\/\//, "");

const toRange = (r: any) => new Range(r.start.line, r.start.character, r.end.line, r.end.character);

export class RealServer {
  readonly root: string;
  private legend: any;
  /** What every token request returned, by URI, to tell when answers settle. */
  readonly tokenAnswers = new Map<string, number[][]>();
  private settled = new Map<string, number[]>();

  private constructor(readonly spec: ServerSpec, readonly client: LspClient) {
    this.root = path.join(repo, "test", "fixtures", "projects", spec.dir);
  }

  static async start(spec: ServerSpec): Promise<RealServer> {
    const root = path.join(repo, "test", "fixtures", "projects", spec.dir);
    const client = LspClient.start(spec.name, spec.command, spec.args, root);
    const server = new RealServer(spec, client);
    const init = await client.initialize(uriOf(root), spec.initializationOptions);
    server.legend = init.capabilities.semanticTokensProvider?.legend;
    await spec.prepare?.(client, root);
    return server;
  }

  stop() {
    return this.client.stop();
  }

  /** A fixture file as a document, opened in the server. */
  doc(file: string): FakeDoc {
    return this.load(Uri.parse(uriOf(path.join(this.root, file))))!;
  }

  private load(uri: Uri): FakeDoc | undefined {
    const file = pathOf(uri.toString());
    const languageId = this.spec.languages[path.extname(file)];
    if (!languageId || !fs.existsSync(file)) return undefined;
    const doc = addDocument(Uri.parse(normalize(uri.toString())), fs.readFileSync(file, "utf8"), languageId);
    this.client.open(doc.uri.toString(), file, languageId);
    return doc;
  }

  /** Makes the fake vscode module ask this server; call after reset(). */
  install() {
    world.folders = [{ uri: Uri.parse(normalize(uriOf(this.root))), name: this.spec.dir, index: 0 }];
    const at = (uri: Uri, pos: any) => ({ textDocument: { uri: uri.toString() }, position: { line: pos.line, character: pos.character } });
    const symbol = (s: any): any =>
      s.location
        ? { name: s.name, kind: s.kind - 1, location: { uri: Uri.parse(normalize(s.location.uri)), range: toRange(s.location.range) } }
        : { name: s.name, kind: s.kind - 1, range: toRange(s.range), selectionRange: toRange(s.selectionRange), children: (s.children ?? []).map(symbol) };
    const hierarchyItem = (i: any) => ({ name: i.name, kind: i.kind - 1, uri: Uri.parse(normalize(i.uri)), range: toRange(i.range), selectionRange: toRange(i.selectionRange), raw: i });
    useLanguageServer(
      {
        "vscode.provideDocumentSemanticTokensLegend": () => this.legend,
        "vscode.provideDocumentSemanticTokens": async (uri: Uri) => ({ data: Uint32Array.from(await this.settledTokens(uri)) }),
        "vscode.executeDocumentSymbolProvider": async (uri: Uri) => ((await this.client.request("textDocument/documentSymbol", { textDocument: { uri: uri.toString() } })) ?? []).map(symbol),
        "vscode.executeHoverProvider": async (uri: Uri, pos: any) => {
          world.requests.hover++;
          const h = await this.client.request("textDocument/hover", at(uri, pos));
          if (!h) return [];
          const contents = (Array.isArray(h.contents) ? h.contents : [h.contents]).map((c: any) => (typeof c === "string" || "language" in c ? c : { value: c.value }));
          return [{ contents }];
        },
        "vscode.executeDefinitionProvider": async (uri: Uri, pos: any) => {
          world.requests.definition++;
          const d = await this.client.request("textDocument/definition", at(uri, pos));
          return (Array.isArray(d) ? d : d ? [d] : []).map((l: any) =>
            l.targetUri
              ? { targetUri: Uri.parse(normalize(l.targetUri)), targetRange: toRange(l.targetRange), targetSelectionRange: toRange(l.targetSelectionRange) }
              : { uri: Uri.parse(normalize(l.uri)), range: toRange(l.range) },
          );
        },
        "vscode.prepareTypeHierarchy": async (uri: Uri, pos: any) => {
          world.requests.typeHierarchy++;
          const items = await this.client.request("textDocument/prepareTypeHierarchy", at(uri, pos)).catch(() => null);
          return (items ?? []).map(hierarchyItem);
        },
        "vscode.provideSupertypes": async (item: any) => {
          world.requests.typeHierarchy++;
          return ((await this.client.request("typeHierarchy/supertypes", { item: item.raw }).catch(() => null)) ?? []).map(hierarchyItem);
        },
      },
      (uri) => this.load(uri),
    );
  }

  /**
   * Semantic tokens once the server's answer stops changing: right after opening, some servers
   * answer before they know the whole project (Roslyn classifies base types from other files as
   * variables at first).
   */
  async settledTokens(uri: Uri): Promise<number[]> {
    const done = this.settled.get(uri.toString());
    if (done) return done;
    const answers = this.tokenAnswers.get(uri.toString()) ?? [];
    this.tokenAnswers.set(uri.toString(), answers);
    let last: number[] | undefined;
    for (let k = 0; k < 60; k++) {
      const data: number[] = (await this.client.request("textDocument/semanticTokens/full", { textDocument: { uri: uri.toString() } }).catch(() => null))?.data ?? [];
      answers.push(data);
      if (data.length && last && data.join() === last.join()) {
        this.settled.set(uri.toString(), data);
        return data;
      }
      last = data;
      await new Promise((r) => setTimeout(r, 500));
    }
    return last ?? [];
  }

  /** "line:text=type.modifiers" of every token, for asserting what the server reports. */
  async describeTokens(doc: FakeDoc, filter: (text: string) => boolean = () => true): Promise<string[]> {
    const data = await this.settledTokens(doc.uri);
    const out: string[] = [];
    let line = 0;
    let ch = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
      line += data[i];
      ch = data[i] === 0 ? ch + data[i + 1] : data[i + 1];
      const text = doc.lines[line].slice(ch, ch + data[i + 2]);
      const mods = (this.legend.tokenModifiers as string[]).filter((_, m) => data[i + 4] & (1 << m));
      if (filter(text)) out.push(`${line}:${text}=${[this.legend.tokenTypes[data[i + 3]], ...mods].join(".")}`);
    }
    return out;
  }
}
