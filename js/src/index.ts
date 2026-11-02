// Epitaxy client for TypeScript / JavaScript (Node 18+, Deno, Bun, browsers). Zero dependencies.
//
//   import { Epitaxy } from "@epitaxy/client";
//   const ep = new Epitaxy();                       // EPITAXY_API_KEY from the environment
//   const job = await ep.submit(plan, { files: { "build/app.elf": bytes }, waitS: 120 });
//   console.log(job.verdict, job.summary);

export const DEFAULT_URL = "https://epitaxy.dev";
const INLINE_LIMIT = 3_000_000;   // bytes; larger firmware goes through a presigned upload URL
const SERVER_WAIT_S = 50;         // the server holds a wait call at most this long

export class EpitaxyError extends Error {
  constructor(message: string) { super(message); this.name = "EpitaxyError"; }
}

export type Verdict = "pass" | "fail" | "error";
export type JobState = "queued" | "running" | "done" | "cancelled";

export interface JobView {
  job_id: string;
  state: JobState;
  plan: string;
  station?: string | null;
  slot?: string | null;
  verdict?: Verdict;
  message?: string;
  summary?: string;
  duration_s?: number;
  problems?: Array<{ step: number; id: string; type: string; status: string; message: string; checks: unknown[] }>;
  artifacts?: string[];
  queue_position?: number;
  [k: string]: unknown;
}

export interface EpitaxyOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface SubmitOptions {
  /** File name used in the plan's images -> contents. */
  files?: Record<string, Uint8Array | ArrayBuffer | string>;
  /** Block until the job finishes, up to this many seconds. */
  waitS?: number;
}

const env = (k: string): string | undefined =>
  (globalThis as any).process?.env?.[k] ?? (globalThis as any).Deno?.env?.get?.(k);

function toBytes(v: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof v === "string") return new TextEncoder().encode(v);
  return v instanceof Uint8Array ? v : new Uint8Array(v);
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class Job {
  constructor(private client: Epitaxy, public raw: JobView) {}
  get id() { return this.raw.job_id; }
  get state() { return this.raw.state; }
  get verdict() { return this.raw.verdict; }
  get summary() { return this.raw.summary ?? ""; }
  get problems() { return this.raw.problems ?? []; }
  get artifacts() { return this.raw.artifacts ?? []; }
  get done() { return this.raw.state === "done" || this.raw.state === "cancelled"; }
  get passed() { return this.raw.verdict === "pass"; }

  async refresh(detail = false): Promise<this> {
    this.raw = await this.client.call<JobView>("get_result", { job_id: this.id, detail });
    return this;
  }

  async wait(timeoutS = 600): Promise<this> {
    const end = Date.now() + timeoutS * 1000;
    while (!this.done) {
      const left = (end - Date.now()) / 1000;
      if (left <= 0) break;
      this.raw = await this.client.call<JobView>("wait_for_result", { job_id: this.id, timeout_s: Math.min(SERVER_WAIT_S, left) });
    }
    return this;
  }

  async cancel(): Promise<this> {
    this.raw = await this.client.call<JobView>("cancel_job", { job_id: this.id });
    return this;
  }

  /** A text artifact (console_N.txt, flash_N.log, emulator_N.log, result.json); last 20 kB if long. */
  async text(name: string): Promise<string> {
    return (await this.client.call<{ text: string }>("get_artifact", { job_id: this.id, name })).text;
  }

  /** Any artifact, including binary captures, as bytes. */
  async bytes(name: string): Promise<Uint8Array> {
    const { url } = await this.client.call<{ url: string }>("get_artifact_url", { job_id: this.id, name });
    const r = await this.client.fetchImpl(url);
    if (!r.ok) throw new EpitaxyError(`download ${name}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
}

export class Epitaxy {
  readonly baseUrl: string;
  /** @internal */ readonly fetchImpl: typeof fetch;
  private apiKey: string;
  private ids = 1;

  constructor(opts: EpitaxyOptions = {}) {
    const key = opts.apiKey ?? env("EPITAXY_API_KEY");
    if (!key) throw new EpitaxyError("no API key: pass { apiKey } or set EPITAXY_API_KEY (create one at https://epitaxy.dev/account/)");
    this.apiKey = key;
    this.baseUrl = (opts.baseUrl ?? env("EPITAXY_URL") ?? DEFAULT_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Call one API tool by name. Throws EpitaxyError on errors. */
  async call<T = any>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null));
    const r = await this.fetchImpl(this.baseUrl + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
                 Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.ids++, method: "tools/call", params: { name: tool, arguments: clean } }),
    });
    if (r.status === 401) throw new EpitaxyError("invalid or revoked API key");
    if (!r.ok) throw new EpitaxyError(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const msg: any = await r.json();
    if (msg.error) throw new EpitaxyError(msg.error.message ?? JSON.stringify(msg.error));
    const res = msg.result ?? {};
    let out: any;
    if (res.structuredContent != null) {
      const sc = res.structuredContent;
      out = Object.keys(sc).length === 1 && "result" in sc ? sc.result : sc;
    } else {
      const text = (res.content ?? []).filter((c: any) => (c.type ?? "text") === "text").map((c: any) => c.text).join("");
      try { out = JSON.parse(text); } catch { out = text; }
    }
    if (res.isError) throw new EpitaxyError(typeof out === "string" ? out : JSON.stringify(out));
    if (out && typeof out === "object" && !Array.isArray(out) && "error" in out && Object.keys(out).length <= 2)
      throw new EpitaxyError(String(out.error));
    return out as T;
  }

  /** Stations, boards, wired/capturable pins and rig capabilities. */
  boards() { return this.call("list_boards"); }

  /** The test-plan format guide (and JSON schema). */
  planGuide(includeSchema = false) { return this.call("get_plan_guide", { include_schema: includeSchema }); }

  /** Check a plan against the schema and the boards that could run it (nothing is run). */
  validate(plan: object) { return this.call("validate_plan", { plan }); }

  async submit(plan: object, opts: SubmitOptions = {}): Promise<Job> {
    const blobs = Object.entries(opts.files ?? {}).map(([n, v]) => [n, toBytes(v)] as const);
    const total = blobs.reduce((a, [, b]) => a + b.length, 0);
    const inline: Record<string, string> = {}, uploads: Record<string, string> = {};
    for (const [name, data] of blobs) {
      if (total <= INLINE_LIMIT) { inline[name] = b64(data); continue; }
      const up = await this.call<{ upload_url: string; file_ref: string }>("create_upload_url", { name: name.split("/").pop() });
      const put = await this.fetchImpl(up.upload_url, { method: "PUT", body: data as BodyInit });
      if (!put.ok) throw new EpitaxyError(`upload ${name}: HTTP ${put.status}`);
      uploads[name] = up.file_ref;
    }
    const waitS = opts.waitS ?? 0;
    const out = await this.call<JobView & { accepted?: boolean; errors?: string[] }>("submit_test", {
      plan, files_base64: blobs.length && total <= INLINE_LIMIT ? inline : undefined,
      uploads: Object.keys(uploads).length ? uploads : undefined, wait_s: Math.min(waitS, SERVER_WAIT_S),
    });
    if (out.accepted === false) throw new EpitaxyError((out.errors ?? ["rejected"]).join("; "));
    const job = new Job(this, out);
    if (waitS > SERVER_WAIT_S && !job.done) await job.wait(waitS - SERVER_WAIT_S);
    return job;
  }

  async job(jobId: string, detail = false): Promise<Job> {
    return new Job(this, await this.call<JobView>("get_result", { job_id: jobId, detail }));
  }

  jobs(limit = 20) { return this.call<JobView[]>("list_jobs", { limit }); }
}
