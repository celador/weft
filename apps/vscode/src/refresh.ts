// When the extension re-reads the repo list (/v1/repos), kept free of the vscode API so it is unit-tested in
// plain Node. Live events arrive over the per-repo sockets; this only refreshes the summary counts and notices
// new repos, so it runs only while someone can see it: a Weft repo is mapped to the workspace, the Weft view is
// visible AND the window is focused. Every 60 s, backing off (x2, up to 5 min) while nothing changes.

export const REFRESH_BASE_MS = 60_000;
export const REFRESH_MAX_MS = 300_000;

export type RefresherOptions = {
  /** Re-read the list; resolve true when it changed. */
  run: () => Promise<boolean>;
  baseMs?: number;
  maxMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
};

export class RepoRefresher {
  private mapped = false;
  private visible = false;
  private focused = false;
  private timer: unknown;
  private running = false;
  private idle = 0;
  private lastRun?: number;
  private readonly base: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(private readonly o: RefresherOptions) {
    this.base = o.baseMs ?? REFRESH_BASE_MS;
    this.max = o.maxMs ?? REFRESH_MAX_MS;
    this.now = o.now ?? (() => Date.now());
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** A Weft repo is mapped to this workspace (or the user connected explicitly). */
  setMapped(v: boolean): void {
    this.mapped = v;
    if (!v) this.idle = 0;
    this.sync();
  }
  setVisible(v: boolean): void {
    this.visible = v;
    this.sync();
  }
  setFocused(v: boolean): void {
    this.focused = v;
    this.sync();
  }

  /** True while a timer is pending or a refresh is in flight. */
  get armed(): boolean {
    return this.timer !== undefined || this.running;
  }

  get active(): boolean {
    return this.mapped && this.visible && this.focused;
  }

  dispose(): void {
    this.mapped = false;
    this.cancel();
  }

  private cancel(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private sync(): void {
    if (!this.active) return this.cancel();
    if (this.timer !== undefined || this.running) return;
    // Just became active: refresh at once if the last read is stale, else when it comes due.
    const due = this.lastRun === undefined ? 0 : Math.max(0, this.lastRun + this.delay() - this.now());
    this.arm(due);
  }

  private delay(): number {
    return Math.min(this.base * 2 ** this.idle, this.max);
  }

  private arm(ms: number): void {
    this.timer = this.setTimer(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (!this.active) return;
    this.running = true;
    let changed = false;
    try {
      changed = await this.o.run();
    } catch {
      /* offline: the next round tries again, slower */
    } finally {
      this.running = false;
      this.lastRun = this.now();
    }
    this.idle = changed ? 0 : this.idle + 1;
    if (this.active && this.timer === undefined) this.arm(this.delay());
  }
}
