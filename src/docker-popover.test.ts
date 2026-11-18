import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerOverview } from "./api";

const confirm = vi.fn<(m: string, ok?: string) => Promise<boolean>>();
const toast = vi.fn();
vi.mock("./ui", () => ({ confirmBox: (m: string, ok?: string) => confirm(m, ok), toast: (...a: unknown[]) => toast(...a) }));

import { DOCKER_EVERY_MS, DockerPopover } from "./docker-popover";

const OVERVIEW: DockerOverview = { cli: true, compose: true, hosts: [] };

/** Just enough DOM for the popover: no browser in these tests. */
function fakeEl() {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  return {
    hidden: false,
    className: "",
    innerHTML: "",
    style: { left: "", top: "", maxHeight: "" },
    firstElementChild: null,
    append() {},
    contains: () => false,
    querySelector: () => null,
    addEventListener(n: string, f: (e: unknown) => void) {
      (listeners[n] ??= []).push(f);
    },
    fire(n: string, e: unknown) {
      for (const f of listeners[n] ?? []) f(e);
    },
  };
}

let el: ReturnType<typeof fakeEl>;
const handlers: Record<string, ((e: unknown) => void)[]> = {};
const fireGlobal = (n: string, e: unknown) => handlers[n]?.forEach((f) => f(e));
const chip = { setAttribute() {}, removeAttribute() {}, getBoundingClientRect: () => ({ left: 0, right: 10, bottom: 10, width: 10 }) };

beforeEach(() => {
  vi.useFakeTimers();
  el = fakeEl();
  for (const k of Object.keys(handlers)) delete handlers[k];
  const on = (n: string, f: (e: unknown) => void) => void (handlers[n] ??= []).push(f);
  vi.stubGlobal("document", { createElement: () => el, addEventListener: on, querySelector: () => chip });
  vi.stubGlobal("window", { addEventListener: on, innerWidth: 1000, innerHeight: 800 });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
  vi.stubGlobal("Element", class {});
  confirm.mockReset();
  toast.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function make(overview: () => Promise<DockerOverview>, removeImage = vi.fn().mockResolvedValue(undefined)) {
  const p = new DockerPopover({ append() {} } as unknown as HTMLElement, { overview, open: vi.fn(), removeImage });
  return { p, removeImage };
}

describe("the Docker popover", () => {
  it("asks only while open", async () => {
    const overview = vi.fn().mockResolvedValue(OVERVIEW);
    const { p } = make(overview);
    expect(overview).not.toHaveBeenCalled();
    p.toggle();
    expect(overview).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DOCKER_EVERY_MS);
    expect(overview).toHaveBeenCalledTimes(2);
    p.close();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(overview).toHaveBeenCalledTimes(2);
  });

  it("never overlaps", async () => {
    const overview = vi.fn().mockReturnValue(new Promise(() => {}));
    const { p } = make(overview);
    p.toggle();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(overview).toHaveBeenCalledTimes(1);
  });

  it("skips a tick while the call is slow", async () => {
    const overview = vi.fn().mockImplementation(() => new Promise((r) => setTimeout(() => r(OVERVIEW), 6000)));
    const { p } = make(overview);
    p.toggle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(overview).toHaveBeenCalledTimes(2);
  });

  it("keeps one call in flight across close and reopen, then asks once", async () => {
    let done!: (o: typeof OVERVIEW) => void;
    const overview = vi.fn().mockReturnValueOnce(new Promise((r) => (done = r))).mockResolvedValue(OVERVIEW);
    const { p } = make(overview);
    p.toggle();
    p.close();
    p.toggle();
    expect(overview).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DOCKER_EVERY_MS);
    expect(overview).toHaveBeenCalledTimes(1);
    done(OVERVIEW);
    await vi.advanceTimersByTimeAsync(0);
    expect(overview).toHaveBeenCalledTimes(2);
  });

  it("asks nothing after a stale call settles on a closed panel", async () => {
    let done!: (o: typeof OVERVIEW) => void;
    const overview = vi.fn().mockReturnValueOnce(new Promise((r) => (done = r)));
    const { p } = make(overview);
    p.toggle();
    p.close();
    done(OVERVIEW);
    await vi.advanceTimersByTimeAsync(0);
    expect(overview).toHaveBeenCalledTimes(1);
  });

  it("survives a failing call", async () => {
    const overview = vi.fn().mockRejectedValue("boom");
    const { p } = make(overview);
    p.toggle();
    await vi.advanceTimersByTimeAsync(DOCKER_EVERY_MS);
    expect(overview).toHaveBeenCalledTimes(2);
    expect(el.innerHTML).toContain("boom");
  });

  describe("remove", () => {
    const click = () => {
      const btn = { dataset: { d: "rm", host: "srv", target: "nginx:1", question: "Sure?" } };
      el.fire("click", { target: { closest: (s: string) => (s === "[data-d]" ? btn : null) } });
    };

    it("toasts the result and does nothing after close", async () => {
      const overview = vi.fn().mockResolvedValue(OVERVIEW);
      let done!: () => void;
      const removeImage = vi.fn().mockReturnValue(new Promise<void>((r) => (done = r)));
      const { p } = make(overview, removeImage);
      p.toggle();
      await vi.advanceTimersByTimeAsync(0);
      confirm.mockResolvedValue(true);
      click();
      await vi.advanceTimersByTimeAsync(0);
      p.close();
      done();
      await vi.advanceTimersByTimeAsync(0);
      expect(toast).toHaveBeenCalledTimes(1);
      expect(overview).toHaveBeenCalledTimes(1);
    });

    it("ignores outside clicks and Esc while confirming", async () => {
      const { p } = make(vi.fn().mockResolvedValue(OVERVIEW));
      p.toggle();
      await vi.advanceTimersByTimeAsync(0);
      confirm.mockReturnValue(new Promise(() => {}));
      click();
      await vi.advanceTimersByTimeAsync(0);
      fireGlobal("keydown", { key: "Escape", preventDefault() {}, stopImmediatePropagation() {} });
      fireGlobal("mousedown", Object.assign(new (globalThis.Element as new () => object)(), { closest: () => null }));
      expect(p.isOpen).toBe(true);
    });

    it("asks first", async () => {
      const overview = vi.fn().mockResolvedValue(OVERVIEW);
      const { p, removeImage } = make(overview);
      p.toggle();
      await vi.advanceTimersByTimeAsync(0);
      confirm.mockResolvedValue(false);
      click();
      await vi.advanceTimersByTimeAsync(0);
      expect(confirm).toHaveBeenCalledWith("Sure?", expect.anything());
      expect(removeImage).not.toHaveBeenCalled();
      confirm.mockResolvedValue(true);
      click();
      await vi.advanceTimersByTimeAsync(0);
      expect(removeImage).toHaveBeenCalledWith("srv", "nginx:1");
      expect(overview).toHaveBeenCalledTimes(2);
    });
  });
});
