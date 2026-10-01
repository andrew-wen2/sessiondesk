import { describe, it, expect } from "vitest";
import { Semaphore } from "./semaphore";

describe("Semaphore", () => {
  it("hands permits out up to capacity and passes them on release", async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    let got2 = false;
    const p2 = s.acquire().then((r) => {
      got2 = true;
      return r;
    });
    await Promise.resolve();
    expect(got2).toBe(false);
    r1();
    const r2 = await p2;
    expect(s.active).toBe(1);
    r2();
    expect(s.active).toBe(0);
  });

  it("drops a cancelled waiter without granting it a permit", async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    const c = new AbortController();
    const waiting = s.acquire(c.signal);
    c.abort("gone");
    await expect(waiting).rejects.toBe("gone");
    expect(s.queued).toBe(0);
    r1();
    expect(s.active).toBe(0);
  });

  it("ignores a double release", async () => {
    const s = new Semaphore(2);
    const r = await s.acquire();
    r();
    r();
    expect(s.active).toBe(0);
  });
});
