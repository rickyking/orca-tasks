// The few Node APIs this plugin uses. A plugin folder ships no node_modules, so @types/node is not
// available to `tsc`; these declarations cover exactly what is called. Node itself provides them
// at run time (the CLI, `node --test`, and the worker, which Orca runs in Node).

declare module 'node:fs/promises' {
  export interface FileHandle {
    writeFile(data: string, encoding: 'utf8'): Promise<void>
    sync(): Promise<void>
    close(): Promise<void>
  }
  export interface Stats {
    size: number
    mtimeMs: number
    isFile(): boolean
  }
  export function open(path: string, flags: 'w' | 'wx' | 'a'): Promise<FileHandle>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function writeFile(path: string, data: string, options: 'utf8' | { encoding: 'utf8'; flag?: string; mode?: number }): Promise<void>
  export function writeFile(path: string, data: Uint8Array): Promise<void>
  export function mkdir(path: string, options: { recursive: true }): Promise<unknown>
  export function rename(from: string, to: string): Promise<void>
  export function unlink(path: string): Promise<void>
  export function stat(path: string): Promise<Stats>
  export function chmod(path: string, mode: number): Promise<void>
  export function readdir(path: string): Promise<string[]>
  export function rm(path: string, options: { recursive: true; force: true }): Promise<void>
  export function mkdtemp(prefix: string): Promise<string>
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export interface FSWatcher {
    close(): void
    on(event: 'error', listener: (error: Error) => void): FSWatcher
  }
  export function watch(path: string, listener: (event: string, filename: string | null) => void): FSWatcher
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function dirname(path: string): string
  export function basename(path: string): string
  export function resolve(...parts: string[]): string
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string
}

declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: { timeout?: number; maxBuffer?: number; cwd?: string; env?: Record<string, string | undefined> },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): { stdin: { end(data: string): void; on(event: 'error', listener: (error: Error) => void): void } | null }
  export interface ChildProcess {
    kill(): boolean
    stdout: { on(event: 'data', listener: (chunk: unknown) => void): void }
    stderr: { on(event: 'data', listener: (chunk: unknown) => void): void }
    on(event: 'close', listener: (code: number | null) => void): void
  }
  export function spawn(command: string, args: readonly string[], options: { env?: Record<string, string | undefined> }): ChildProcess
  export function spawnSync(
    command: string,
    args: readonly string[],
    options: { encoding: 'utf8'; env?: Record<string, string | undefined>; input?: string }
  ): { status: number | null; stdout: string; stderr: string }
}

declare module 'node:test' {
  export function test(name: string, fn: () => unknown): Promise<void>
  export function test(name: string, options: { skip?: boolean | string }, fn: () => unknown): Promise<void>
  export function describe(name: string, fn: () => unknown): Promise<void>
  export function beforeEach(fn: () => unknown): void
  export function afterEach(fn: () => unknown): void
}

declare module 'node:assert/strict' {
  const assert: {
    (value: unknown, message?: string): asserts value
    ok(value: unknown, message?: string): asserts value
    equal(actual: unknown, expected: unknown, message?: string): void
    notEqual(actual: unknown, expected: unknown, message?: string): void
    deepEqual(actual: unknown, expected: unknown, message?: string): void
    match(value: string, pattern: RegExp, message?: string): void
    doesNotMatch(value: string, pattern: RegExp, message?: string): void
    throws(fn: () => unknown, expected?: unknown, message?: string): void
    rejects(promise: Promise<unknown> | (() => Promise<unknown>), expected?: unknown, message?: string): Promise<void>
  }
  export default assert
}

declare const process: {
  pid: number
  argv: string[]
  execPath: string
  env: Record<string, string | undefined>
  exitCode?: number
  version: string
  versions: { node: string }
  kill(pid: number, signal: 0): void
  cwd(): string
  stdin: { setEncoding(encoding: 'utf8'): void; on(event: 'data', listener: (chunk: string) => void): void; on(event: 'end', listener: () => void): void; isTTY?: boolean }
  stdout: { write(text: string): boolean }
  stderr: { write(text: string): boolean }
}

interface ImportMeta {
  url: string
}

declare module 'node:http' {
  export interface IncomingMessage {
    url?: string
  }
  export interface ServerResponse {
    writeHead(status: number, headers?: Record<string, string>): void
    end(body?: string): void
  }
  export interface Server {
    listen(port: number, host: string, callback: () => void): void
    address(): unknown
    close(callback?: () => void): void
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server
}

declare module 'node:net' {
  export interface Server {
    listen(port: number, host: string, callback: () => void): void
    address(): unknown
    close(callback?: () => void): void
  }
  export function createServer(): Server
}

declare module 'node:module' {
  /** Node 22.13+: TypeScript with its types removed (`mode: 'strip'` keeps the positions). */
  export function stripTypeScriptTypes(code: string, options?: { mode?: 'strip' | 'transform' }): string
}

declare const Buffer: { from(data: string, encoding: 'base64'): Uint8Array }
