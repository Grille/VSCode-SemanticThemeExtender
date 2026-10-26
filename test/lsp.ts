// A minimal Language Server Protocol client over stdio, enough to start real language servers in
// tests and ask them what VS Code would ask: semantic tokens, symbols, hovers, definitions, the
// type hierarchy.

import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";

/** Every standard token type and modifier, so servers don't hold any back from the client. */
const TOKEN_TYPES = [
  "namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember",
  "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator",
];
const TOKEN_MODIFIERS = ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"];

export class LspClient {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private versions = new Map<string, number>();
  /** Answers to requests the server sends us. */
  readonly handlers: Record<string, (params: any) => unknown> = {
    "workspace/configuration": (p) => p.items.map(() => null),
    "client/registerCapability": () => null,
    "client/unregisterCapability": () => null,
    "window/workDoneProgress/create": () => null,
    "workspace/workspaceFolders": () => this.folders,
    "workspace/semanticTokens/refresh": () => null,
  };
  readonly notifications: { method: string; params: any }[] = [];
  capabilities: any;
  private folders: { uri: string; name: string }[] = [];

  private constructor(private readonly proc: ChildProcess, readonly name: string) {
    proc.stdout!.on("data", (chunk: Buffer) => this.receive(chunk));
    proc.stderr!.on("data", () => undefined);
    proc.on("exit", (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`${name} exited (${code}) during ${p.method}`));
      this.pending.clear();
    });
  }

  static start(name: string, command: string, args: string[], cwd: string): LspClient {
    return new LspClient(spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] }), name);
  }

  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1]);
      if (this.buffer.length < end + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString("utf8"));
      this.buffer = this.buffer.subarray(end + 4 + length);
      this.dispatch(message);
    }
  }

  private dispatch(m: any) {
    if (m.id !== undefined && m.method === undefined) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.reject(new Error(`${p.method}: ${m.error.message}`));
      else p?.resolve(m.result);
    } else if (m.id !== undefined) {
      const handler = this.handlers[m.method];
      this.send({ jsonrpc: "2.0", id: m.id, result: handler ? handler(m.params) : null });
    } else {
      this.notifications.push({ method: m.method, params: m.params });
    }
  }

  private send(message: unknown) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.proc.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin!.write(body);
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async initialize(rootUri: string, initializationOptions?: unknown) {
    this.folders = [{ uri: rootUri, name: "root" }];
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: this.folders,
      initializationOptions,
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, semanticTokens: { refreshSupport: true } },
        textDocument: {
          synchronization: { didSave: true },
          semanticTokens: {
            requests: { full: true },
            tokenTypes: TOKEN_TYPES,
            tokenModifiers: TOKEN_MODIFIERS,
            formats: ["relative"],
            multilineTokenSupport: false,
            overlappingTokenSupport: false,
          },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          typeHierarchy: {},
        },
        window: { workDoneProgress: true },
      },
    });
    this.capabilities = result.capabilities;
    this.notify("initialized", {});
    return result;
  }

  /** Opens a file on disk in the server, once. */
  open(uri: string, path: string, languageId: string) {
    if (this.versions.has(uri)) return;
    this.versions.set(uri, 1);
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text: fs.readFileSync(path, "utf8") } });
  }

  async stop() {
    try {
      await this.request("shutdown", null, 5_000);
      this.notify("exit", null);
    } catch {
      // Already gone.
    }
    this.proc.kill();
  }
}
