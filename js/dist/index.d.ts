export declare const DEFAULT_URL = "https://epitaxy.dev";
export declare class EpitaxyError extends Error {
    constructor(message: string);
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
    problems?: Array<{
        step: number;
        id: string;
        type: string;
        status: string;
        message: string;
        checks: unknown[];
    }>;
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
export declare class Job {
    private client;
    raw: JobView;
    constructor(client: Epitaxy, raw: JobView);
    get id(): string;
    get state(): JobState;
    get verdict(): Verdict | undefined;
    get summary(): string;
    get problems(): {
        step: number;
        id: string;
        type: string;
        status: string;
        message: string;
        checks: unknown[];
    }[];
    get artifacts(): string[];
    get done(): boolean;
    get passed(): boolean;
    refresh(detail?: boolean): Promise<this>;
    wait(timeoutS?: number): Promise<this>;
    cancel(): Promise<this>;
    /** A text artifact (console_N.txt, flash_N.log, emulator_N.log, result.json); last 20 kB if long. */
    text(name: string): Promise<string>;
    /** Any artifact, including binary captures, as bytes. */
    bytes(name: string): Promise<Uint8Array>;
}
export declare class Epitaxy {
    readonly baseUrl: string;
    /** @internal */ readonly fetchImpl: typeof fetch;
    private apiKey;
    private ids;
    constructor(opts?: EpitaxyOptions);
    /** Call one API tool by name. Throws EpitaxyError on errors. */
    call<T = any>(tool: string, args?: Record<string, unknown>): Promise<T>;
    /** Stations, boards, wired/capturable pins and rig capabilities. */
    boards(): Promise<any>;
    /** The test-plan format guide (and JSON schema). */
    planGuide(includeSchema?: boolean): Promise<any>;
    /** Check a plan against the schema and the boards that could run it (nothing is run). */
    validate(plan: object): Promise<any>;
    submit(plan: object, opts?: SubmitOptions): Promise<Job>;
    job(jobId: string, detail?: boolean): Promise<Job>;
    jobs(limit?: number): Promise<JobView[]>;
}
