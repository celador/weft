// Types for the system job runner (plain ESM so the image needs no build step).
export declare const ZERO_SHA: string;
export type JobSpec = Record<string, any> & { job: "rebase" | "land" | "revert" };
export type JobResult = Record<string, any> & { job?: string; status: string };
export declare function runJob(spec: JobSpec, opts?: { env?: Record<string, string | undefined>; log?: (o: unknown) => void }): Promise<JobResult>;
export declare function validateJob(spec: unknown): string[];
export declare function summarizeTests(out: string): { pass?: number; fail?: number };
export declare function stripFences(s: string): string;
export declare function redact(s: string, extra?: string[]): string;
export declare function loadSelector(): Promise<unknown>;
export declare function selectedCommand(command: string[] | string, files: string[]): string[];
