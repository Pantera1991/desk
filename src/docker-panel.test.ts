import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerOverview } from "./api";

const confirm = vi.fn<(m: string, ok?: string) => Promise<boolean>>();
const toast = vi.fn();
vi.mock("./ui", () => ({ confirmBox: (m: string, ok?: string) => confirm(m, ok), toast: (...a: unknown[]) => toast(...a) }));

const gitStatusSummary = vi.fn();
vi.mock("./api", () => ({ api: { gitStatusSummary: (p: string) => gitStatusSummary(p) } }));

import { deployQuestion, restartQuestion } from "./docker-view";
import { t } from "./i18n";
import { DOCKER_EVERY_MS, DockerPanel, type DockerPanelContext } from "./docker-panel";

const OVERVIEW: DockerOverview = { cli: true, compose: true, hosts: [] };

/** Just enough DOM for the panel: no browser in these tests. */
function fakeEl() {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const child = { scrollTop: 0, addEventListener() {}, setPointerCapture() {}, removeEventListener() {}, innerHTML: "" };
  return {
    hidden: false,
    className: "",
    innerHTML: "",
    style: { width: "" } as Record<string, string>,
    child,
    contains: () => false,
    getBoundingClientRect: () => ({ width: 380 }),
    querySelector: () => child,
    addEventListener(n: string, f: (e: unknown) => void) {
      (listeners[n] ??= []).push(f);
    },
    fire(n: string, e: unknown) {
      for (const f of listeners[n] ?? []) f(e);
    },
  };
}

let el: ReturnType<typeof fakeEl>;
let doc: { hidden: boolean };
let store: Record<string, string>;
const handlers: Record<string, ((e: unknown) => void)[]> = {};
const fireGlobal = (n: string, e: unknown) => handlers[n]?.forEach((f) => f(e));

beforeEach(() => {
  vi.useFakeTimers();
  el = fakeEl();
  store = {};
  for (const k of Object.keys(handlers)) delete handlers[k];
  const on = (n: string, f: (e: unknown) => void) => void (handlers[n] ??= []).push(f);
  doc = { hidden: false };
  vi.stubGlobal("document", Object.assign(doc, { createElement: () => el, addEventListener: on }));
  vi.stubGlobal("window", { addEventListener: on, innerWidth: 1000, innerHeight: 800 });
  vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) });
  vi.stubGlobal("Element", class {});
  confirm.mockReset();
  toast.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function make(overview: () => Promise<DockerOverview>, removeImage = vi.fn().mockResolvedValue(undefined), extra: Partial<DockerPanelContext> = {}) {
  const open = vi.fn();
  const p = new DockerPanel(vi.fn(), {
    overview,
    openPaths: () => [],
    open,
    removeImage,
    restart: vi.fn().mockResolvedValue(undefined),
    focusDeploy: vi.fn().mockReturnValue(false),
    ...extra,
  });
  return { p, removeImage, open };
}

describe("the Docker panel", () => {
  it("asks only while open", async () => {
    const overview = vi.fn().mockResolvedValue(OVERVIEW);
    const { p } = make(overview);
    expect(overview).not.toHaveBeenCalled();
    p.open();
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
    p.open();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(overview).toHaveBeenCalledTimes(1);
  });

  it("skips a tick while the call is slow", async () => {
    const overview = vi.fn().mockImplementation(() => new Promise((r) => setTimeout(() => r(OVERVIEW), 6000)));
    const { p } = make(overview);
    p.open();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(overview).toHaveBeenCalledTimes(2);
  });

  it("keeps one call in flight across close and reopen, then asks once", async () => {
    let done!: (o: typeof OVERVIEW) => void;
    const overview = vi.fn().mockReturnValueOnce(new Promise((r) => (done = r))).mockResolvedValue(OVERVIEW);
    const { p } = make(overview);
    p.open();
    p.close();
    p.open();
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
    p.open();
    p.close();
    done(OVERVIEW);
    await vi.advanceTimersByTimeAsync(0);
    expect(overview).toHaveBeenCalledTimes(1);
  });

  it("survives a failing call", async () => {
    const overview = vi.fn().mockRejectedValue("boom");
    const { p } = make(overview);
    p.open();
    await vi.advanceTimersByTimeAsync(DOCKER_EVERY_MS);
    expect(overview).toHaveBeenCalledTimes(2);
    expect(el.child.innerHTML).toContain("boom");
  });

  it("pauses while the window is hidden and asks at once when it is back", async () => {
    const overview = vi.fn().mockResolvedValue(OVERVIEW);
    const { p } = make(overview);
    p.open();
    await vi.advanceTimersByTimeAsync(0);
    doc.hidden = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(overview).toHaveBeenCalledTimes(1);
    doc.hidden = false;
    fireGlobal("visibilitychange", {});
    expect(overview).toHaveBeenCalledTimes(2);
  });

  it("does not close on Esc or a click elsewhere", async () => {
    const { p } = make(vi.fn().mockResolvedValue(OVERVIEW));
    p.open();
    await vi.advanceTimersByTimeAsync(0);
    fireGlobal("keydown", { key: "Escape", preventDefault() {}, stopImmediatePropagation() {} });
    fireGlobal("mousedown", Object.assign(new (globalThis.Element as new () => object)(), { closest: () => null }));
    fireGlobal("blur", {});
    expect(p.isOpen).toBe(true);
  });

  it("remembers being open and restores it", () => {
    const { p } = make(vi.fn().mockResolvedValue(OVERVIEW));
    p.open();
    expect(store["desk.dockerPanel"]).toBe("1");
    p.close();
    expect(store["desk.dockerPanel"]).toBe("0");
    store["desk.dockerPanel"] = "1";
    expect(make(vi.fn().mockResolvedValue(OVERVIEW)).p.isOpen).toBe(true);
  });

  it("tells the layout when it opens or closes", () => {
    const onLayout = vi.fn();
    const p = new DockerPanel(onLayout, {
      overview: vi.fn().mockResolvedValue(OVERVIEW),
      openPaths: () => [],
      open: vi.fn(),
      removeImage: vi.fn(),
      restart: vi.fn(),
      focusDeploy: vi.fn(),
    });
    p.open();
    p.close();
    expect(onLayout).toHaveBeenCalledTimes(2);
  });

  it("takes its width from storage, 380 by default, 280 at least", () => {
    make(vi.fn().mockResolvedValue(OVERVIEW));
    expect(el.style.width).toBe("380px");
    store["desk.dockerWidth"] = "500";
    make(vi.fn().mockResolvedValue(OVERVIEW));
    expect(el.style.width).toBe("500px");
    store["desk.dockerWidth"] = "100";
    make(vi.fn().mockResolvedValue(OVERVIEW));
    expect(el.style.width).toBe("280px");
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
      p.open();
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

    it("stays open while confirming", async () => {
      const { p } = make(vi.fn().mockResolvedValue(OVERVIEW));
      p.open();
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
      p.open();
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

  describe("restart", () => {
    const click = () => {
      const btn = { dataset: { d: "restart", host: "srv", target: "web" } };
      el.fire("click", { target: { closest: (s: string) => (s === "[data-d]" ? btn : null) } });
    };
    const opened = async (restart: DockerPanelContext["restart"]) => {
      const overview = vi.fn().mockResolvedValue(OVERVIEW);
      const m = make(overview, undefined, { restart });
      m.p.open();
      await vi.advanceTimersByTimeAsync(0);
      return { ...m, overview };
    };

    it("cancel calls nothing", async () => {
      const restart = vi.fn().mockResolvedValue(undefined);
      await opened(restart);
      confirm.mockResolvedValue(false);
      click();
      await vi.advanceTimersByTimeAsync(0);
      expect(confirm).toHaveBeenCalledWith(restartQuestion("srv", "web"), t("docker.restart"));
      expect(restart).not.toHaveBeenCalled();
    });

    it("OK restarts, toasts and refreshes", async () => {
      const restart = vi.fn().mockResolvedValue(undefined);
      const { overview } = await opened(restart);
      confirm.mockResolvedValue(true);
      click();
      await vi.advanceTimersByTimeAsync(0);
      expect(restart).toHaveBeenCalledWith("srv", "web");
      expect(toast).toHaveBeenCalledWith(expect.stringContaining("web"), { kind: "ok" });
      expect(overview).toHaveBeenCalledTimes(2);
    });

    it("an error toasts its text", async () => {
      await opened(vi.fn().mockRejectedValue("boom"));
      confirm.mockResolvedValue(true);
      click();
      await vi.advanceTimersByTimeAsync(0);
      expect(toast).toHaveBeenCalledWith("boom", { kind: "error" });
    });
  });

  describe("deploy", () => {
    const click = () => {
      const btn = { dataset: { d: "deploy", host: "srv", target: "shop", path: "/work/shop" } };
      el.fire("click", { target: { closest: (s: string) => (s === "[data-d]" ? btn : null) } });
    };
    const opened = async (extra: Partial<DockerPanelContext> = {}) => {
      gitStatusSummary.mockReset();
      gitStatusSummary.mockResolvedValue({ branch: "main", dirty: 0 });
      const m = make(vi.fn().mockResolvedValue(OVERVIEW), undefined, extra);
      m.p.open();
      await vi.advanceTimersByTimeAsync(0);
      return m;
    };

    it("asks with the git summary, then opens a deploy tile on the given folder", async () => {
      const { open } = await opened();
      confirm.mockResolvedValue(true);
      click();
      await vi.advanceTimersByTimeAsync(0);
      expect(gitStatusSummary).toHaveBeenCalledWith("/work/shop");
      expect(confirm).toHaveBeenCalledWith(deployQuestion("srv", "shop", "/work/shop", { branch: "main", dirty: 0 }) , t("docker.deploy"));
      expect(open).toHaveBeenCalledWith({ host: "srv", target: "shop", kind: "deploy" }, t("docker.tileDeploy", { name: "shop" }), "/work/shop");
    });

    it("cancel opens nothing; a failing git summary still asks", async () => {
      const { open } = await opened();
      gitStatusSummary.mockRejectedValue("no git");
      confirm.mockResolvedValue(false);
      click();
      await vi.advanceTimersByTimeAsync(0);
      expect(confirm).toHaveBeenCalledWith(deployQuestion("srv", "shop", "/work/shop", null), t("docker.deploy"));
      expect(open).not.toHaveBeenCalled();
    });

    it("focuses the tile already open without asking", async () => {
      const focusDeploy = vi.fn().mockReturnValue(true);
      const { open } = await opened({ focusDeploy });
      click();
      await vi.advanceTimersByTimeAsync(0);
      expect(focusDeploy).toHaveBeenCalledWith("srv", "shop");
      expect(confirm).not.toHaveBeenCalled();
      expect(gitStatusSummary).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    });
  });
});
