import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerOverview } from "./api";

const confirm = vi.fn<(m: string, ok?: string) => Promise<boolean>>();
vi.mock("./ui", () => ({ confirmBox: (m: string, ok?: string) => confirm(m, ok), toast: vi.fn() }));

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
const chip = { setAttribute() {}, removeAttribute() {}, getBoundingClientRect: () => ({ left: 0, right: 10, bottom: 10, width: 10 }) };

beforeEach(() => {
  vi.useFakeTimers();
  el = fakeEl();
  vi.stubGlobal("document", { createElement: () => el, addEventListener() {}, querySelector: () => chip });
  vi.stubGlobal("window", { addEventListener() {}, innerWidth: 1000, innerHeight: 800 });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
  vi.stubGlobal("Element", class {});
  confirm.mockReset();
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
