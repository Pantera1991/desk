import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadHost } from "./api";

const choice = vi.fn<(m: string, ok: string, o?: { warning?: string }) => Promise<"ok" | "alt" | null>>();
const toast = vi.fn();
vi.mock("./ui", () => ({
  choiceBox: (m: string, ok: string, o?: { warning?: string }) => choice(m, ok, o),
  toast: (...a: unknown[]) => toast(...a),
}));

const uploadTools = vi.fn<() => Promise<{ rsync: boolean; ssh: boolean }>>();
const uploadFileSize = vi.fn<(path: string, file: string) => Promise<{ size: number; name: string }>>();
vi.mock("./api", () => ({ api: { uploadTools: () => uploadTools(), uploadFileSize: (p: string, f: string) => uploadFileSize(p, f) } }));

const tree = vi.hoisted(() => ({
  load: undefined as unknown as (p: string | null) => Promise<void>,
  on: undefined as unknown as { file(r: string): void; folder(r: string): void; edit(r: string): void },
}));
vi.mock("./treeview", () => ({
  FileTree: class {
    el = {};
    constructor(on: typeof tree.on) {
      tree.on = on;
    }
    load = (p: string | null) => tree.load(p);
  },
}));

import { t } from "./i18n";
import { UploadPanel, type UploadContext } from "./upload-panel";

const HOSTS: UploadHost[] = [
  { host: "example-dev", user: "deploy", key: "" },
  { host: "example-prod", user: "root", key: "" },
];

/** Just enough DOM for the panel: no browser in these tests. */
function fakeEl() {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const child = { innerHTML: "", append() {}, addEventListener() {}, setPointerCapture() {}, removeEventListener() {} };
  return {
    hidden: false,
    className: "",
    innerHTML: "",
    style: { width: "" } as Record<string, string>,
    child,
    getBoundingClientRect: () => ({ width: 340 }),
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
let store: Record<string, string>;

beforeEach(() => {
  el = fakeEl();
  store = {};
  vi.stubGlobal("document", { createElement: () => el, addEventListener() {} });
  vi.stubGlobal("window", { addEventListener() {}, innerWidth: 1000 });
  vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) });
  choice.mockReset();
  toast.mockReset();
  tree.load = vi.fn<(p: string | null) => Promise<void>>().mockResolvedValue(undefined);
  uploadTools.mockReset().mockResolvedValue({ rsync: true, ssh: true });
  uploadFileSize.mockReset().mockResolvedValue({ size: 2048, name: "a.sql" });
});
afterEach(() => vi.unstubAllGlobals());

function make(extra: Partial<UploadContext> = {}) {
  const send = vi.fn<UploadContext["send"]>().mockResolvedValue(undefined);
  const existing = vi.fn<UploadContext["existing"]>().mockResolvedValue(null);
  const focus = vi.fn<UploadContext["focus"]>().mockResolvedValue(undefined);
  const hosts = { list: HOSTS };
  const p = new UploadPanel({ project: () => "/p/app", hosts: () => hosts.list, existing, focus, send, onLayout: vi.fn(), ...extra });
  return { p, send, existing, focus, hosts };
}

/** A click on `[data-u=name]`. */
const click = (name: string) => el.fire("click", { target: { closest: () => ({ dataset: { u: name } }) } });
const pickHost = (value: string) => el.fire("change", { target: { closest: () => ({ dataset: { u: "host" }, value }) } });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the Upload panel", () => {
  it("open loads tools once and the tree of ctx.project()", async () => {
    const { p } = make();
    p.open();
    await flush();
    expect(uploadTools).toHaveBeenCalledTimes(1);
    expect(tree.load).toHaveBeenCalledWith("/p/app");
    p.close();
    p.open();
    await flush();
    expect(uploadTools).toHaveBeenCalledTimes(1);
  });

  it("send asks with size and target, and opens nothing on cancel", async () => {
    const { p, send } = make();
    p.open();
    tree.on.file("dumps/a.sql");
    choice.mockResolvedValue(null);
    click("send");
    await flush();
    expect(uploadFileSize).toHaveBeenCalledWith("/p/app", "dumps/a.sql");
    expect(choice).toHaveBeenCalledWith(t("upload.confirm", { file: "dumps/a.sql", size: "2.0 KB", target: "deploy@example-dev", name: "a.sql" }), t("upload.send"), {
      warning: undefined,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("send on a prod host passes a warning", async () => {
    store["desk.uploadHost"] = "root@example-prod";
    const { p } = make();
    p.open();
    tree.on.file("dumps/a.sql");
    choice.mockResolvedValue(null);
    click("send");
    await flush();
    expect(choice.mock.calls[0][2]).toEqual({ warning: t("upload.prodWarning") });
  });

  it("send confirmed calls ctx.send with {host,user,file} and the tile title", async () => {
    const { p, send } = make();
    p.open();
    tree.on.file("dumps/a.sql");
    choice.mockResolvedValue("ok");
    click("send");
    await flush();
    expect(send).toHaveBeenCalledWith({ host: "example-dev", user: "deploy", file: "dumps/a.sql" }, "wyślij: dumps/a.sql → example-dev", "/p/app");
  });

  it("the same file still sending is focused with a toast, and nothing is asked", async () => {
    const { p, send, existing, focus } = make();
    existing.mockResolvedValue("running");
    p.open();
    tree.on.file("dumps/a.sql");
    click("send");
    await flush();
    const tile = { host: "example-dev", user: "deploy", file: "dumps/a.sql" };
    expect(existing).toHaveBeenCalledWith(tile, "/p/app");
    expect(focus).toHaveBeenCalledWith(tile, "/p/app");
    expect(toast).toHaveBeenCalledWith(t("upload.alreadyRunning"));
    expect(choice).not.toHaveBeenCalled();
    expect(uploadFileSize).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("the same file sent before (finished) is asked about again and sent", async () => {
    const { p, send, existing, focus } = make();
    existing.mockResolvedValue("finished");
    p.open();
    tree.on.file("dumps/a.sql");
    choice.mockResolvedValue("ok");
    click("send");
    await flush();
    expect(choice).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ host: "example-dev", user: "deploy", file: "dumps/a.sql" }, "wyślij: dumps/a.sql → example-dev", "/p/app");
  });

  it("a project other than the shown tree reloads the tree and sends nothing", async () => {
    let project = "/p/app";
    const { p, send, existing } = make({ project: () => project });
    p.open();
    tree.on.file("dumps/a.sql");
    project = "/p/other";
    click("send");
    await flush();
    expect(tree.load).toHaveBeenLastCalledWith("/p/other");
    expect(existing).not.toHaveBeenCalled();
    expect(choice).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    // The file of the other project is gone: a second click sends nothing either.
    click("send");
    await flush();
    expect(choice).not.toHaveBeenCalled();
  });

  it("picking a folder clears the selected file", async () => {
    const { p, send } = make();
    p.open();
    tree.on.file("dumps/a.sql");
    tree.on.folder("dumps");
    click("send");
    await flush();
    expect(choice).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("the chosen server is remembered and falls back to the first when it was removed", async () => {
    const { p, hosts } = make();
    p.open();
    pickHost("root@example-prod");
    expect(store["desk.uploadHost"]).toBe("root@example-prod");
    tree.on.file("a.sql");
    choice.mockResolvedValue(null);
    click("send");
    await flush();
    expect(choice.mock.calls[0][0]).toContain("root@example-prod");
    hosts.list = [HOSTS[0]];
    p.hostsChanged();
    click("send");
    await flush();
    expect(choice.mock.calls[1][0]).toContain("deploy@example-dev");
  });

  it("hostsChanged with none left closes the panel", () => {
    const { p, hosts } = make();
    p.open();
    expect(p.isOpen).toBe(true);
    hosts.list = [];
    p.hostsChanged();
    expect(p.isOpen).toBe(false);
  });
});
