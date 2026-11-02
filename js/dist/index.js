// Epitaxy client for TypeScript / JavaScript (Node 18+, Deno, Bun, browsers). Zero dependencies.
//
//   import { Epitaxy } from "@epitaxy/client";
//   const ep = new Epitaxy();                       // EPITAXY_API_KEY from the environment
//   const job = await ep.submit(plan, { files: { "build/app.elf": bytes }, waitS: 120 });
//   console.log(job.verdict, job.summary);
export const DEFAULT_URL = "https://epitaxy.dev";
const INLINE_LIMIT = 3000000; // bytes; larger firmware goes through a presigned upload URL
const SERVER_WAIT_S = 50; // the server holds a wait call at most this long
export class EpitaxyError extends Error {
    constructor(message) { super(message); this.name = "EpitaxyError"; }
}
const env = (k) => globalThis.process?.env?.[k] ?? globalThis.Deno?.env?.get?.(k);
function toBytes(v) {
    if (typeof v === "string")
        return new TextEncoder().encode(v);
    return v instanceof Uint8Array ? v : new Uint8Array(v);
}
function b64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}
export class Job {
    constructor(client, raw) {
        this.client = client;
        this.raw = raw;
    }
    get id() { return this.raw.job_id; }
    get state() { return this.raw.state; }
    get verdict() { return this.raw.verdict; }
    get summary() { return this.raw.summary ?? ""; }
    get problems() { return this.raw.problems ?? []; }
    get artifacts() { return this.raw.artifacts ?? []; }
    get done() { return this.raw.state === "done" || this.raw.state === "cancelled"; }
    get passed() { return this.raw.verdict === "pass"; }
    async refresh(detail = false) {
        this.raw = await this.client.call("get_result", { job_id: this.id, detail });
        return this;
    }
    async wait(timeoutS = 600) {
        const end = Date.now() + timeoutS * 1000;
        while (!this.done) {
            const left = (end - Date.now()) / 1000;
            if (left <= 0)
                break;
            this.raw = await this.client.call("wait_for_result", { job_id: this.id, timeout_s: Math.min(SERVER_WAIT_S, left) });
        }
        return this;
    }
    async cancel() {
        this.raw = await this.client.call("cancel_job", { job_id: this.id });
        return this;
    }
    /** A text artifact (console_N.txt, flash_N.log, emulator_N.log, result.json); last 20 kB if long. */
    async text(name) {
        return (await this.client.call("get_artifact", { job_id: this.id, name })).text;
    }
    /** Any artifact, including binary captures, as bytes. */
    async bytes(name) {
        const { url } = await this.client.call("get_artifact_url", { job_id: this.id, name });
        const r = await this.client.fetchImpl(url);
        if (!r.ok)
            throw new EpitaxyError(`download ${name}: HTTP ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
    }
}
export class Epitaxy {
    constructor(opts = {}) {
        this.ids = 1;
        const key = opts.apiKey ?? env("EPITAXY_API_KEY");
        if (!key)
            throw new EpitaxyError("no API key: pass { apiKey } or set EPITAXY_API_KEY (create one at https://epitaxy.dev/account/)");
        this.apiKey = key;
        this.baseUrl = (opts.baseUrl ?? env("EPITAXY_URL") ?? DEFAULT_URL).replace(/\/+$/, "");
        this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    }
    /** Call one API tool by name. Throws EpitaxyError on errors. */
    async call(tool, args = {}) {
        const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null));
        const r = await this.fetchImpl(this.baseUrl + "/mcp", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
                Authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: this.ids++, method: "tools/call", params: { name: tool, arguments: clean } }),
        });
        if (r.status === 401)
            throw new EpitaxyError("invalid or revoked API key");
        if (!r.ok)
            throw new EpitaxyError(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
        const msg = await r.json();
        if (msg.error)
            throw new EpitaxyError(msg.error.message ?? JSON.stringify(msg.error));
        const res = msg.result ?? {};
        let out;
        if (res.structuredContent != null) {
            const sc = res.structuredContent;
            out = Object.keys(sc).length === 1 && "result" in sc ? sc.result : sc;
        }
        else {
            const text = (res.content ?? []).filter((c) => (c.type ?? "text") === "text").map((c) => c.text).join("");
            try {
                out = JSON.parse(text);
            }
            catch {
                out = text;
            }
        }
        if (res.isError)
            throw new EpitaxyError(typeof out === "string" ? out : JSON.stringify(out));
        if (out && typeof out === "object" && !Array.isArray(out) && "error" in out && Object.keys(out).length <= 2)
            throw new EpitaxyError(String(out.error));
        return out;
    }
    /** Stations, boards, wired/capturable pins and rig capabilities. */
    boards() { return this.call("list_boards"); }
    /** The test-plan format guide (and JSON schema). */
    planGuide(includeSchema = false) { return this.call("get_plan_guide", { include_schema: includeSchema }); }
    /** Check a plan against the schema and the boards that could run it (nothing is run). */
    validate(plan) { return this.call("validate_plan", { plan }); }
    async submit(plan, opts = {}) {
        const blobs = Object.entries(opts.files ?? {}).map(([n, v]) => [n, toBytes(v)]);
        const total = blobs.reduce((a, [, b]) => a + b.length, 0);
        const inline = {}, uploads = {};
        for (const [name, data] of blobs) {
            if (total <= INLINE_LIMIT) {
                inline[name] = b64(data);
                continue;
            }
            const up = await this.call("create_upload_url", { name: name.split("/").pop() });
            const put = await this.fetchImpl(up.upload_url, { method: "PUT", body: data });
            if (!put.ok)
                throw new EpitaxyError(`upload ${name}: HTTP ${put.status}`);
            uploads[name] = up.file_ref;
        }
        const waitS = opts.waitS ?? 0;
        const out = await this.call("submit_test", {
            plan, files_base64: blobs.length && total <= INLINE_LIMIT ? inline : undefined,
            uploads: Object.keys(uploads).length ? uploads : undefined, wait_s: Math.min(waitS, SERVER_WAIT_S),
        });
        if (out.accepted === false)
            throw new EpitaxyError((out.errors ?? ["rejected"]).join("; "));
        const job = new Job(this, out);
        if (waitS > SERVER_WAIT_S && !job.done)
            await job.wait(waitS - SERVER_WAIT_S);
        return job;
    }
    async job(jobId, detail = false) {
        return new Job(this, await this.call("get_result", { job_id: jobId, detail }));
    }
    jobs(limit = 20) { return this.call("list_jobs", { limit }); }
}
