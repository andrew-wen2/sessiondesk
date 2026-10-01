// A counting semaphore whose waiters can be cancelled. One per provider per process,
// capping how many rung calls a single instance has in flight to that vendor.
//
// Per instance only: Vercel spreads requests across instances, so this cannot enforce
// an account-wide limit. Size it at roughly the vendor's account limit divided by the
// concurrent generate requests expected (1–2 for one tutor). A queued waiter whose
// signal aborts leaves the queue without ever holding a permit.
export class Semaphore {
  private inUse = 0;
  private waiters: { resolve: (release: () => void) => void; reject: (e: unknown) => void; signal?: AbortSignal; onAbort?: () => void }[] = [];

  constructor(readonly capacity: number) {
    if (!(capacity >= 1)) throw new Error("Semaphore capacity must be at least 1.");
  }

  get active(): number {
    return this.inUse;
  }

  get queued(): number {
    return this.waiters.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
    if (this.inUse < this.capacity) {
      this.inUse++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(signal.reason ?? new Error("aborted"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
        next.resolve(this.releaser()); // the permit passes straight to the next waiter
      } else {
        this.inUse--;
      }
    };
  }
}
