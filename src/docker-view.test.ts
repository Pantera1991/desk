import { beforeEach, describe, expect, it } from "vitest";
import type { DockerContainer, DockerHostView, DockerImage, DockerOverview } from "./api";
import { checkHosts, draftAdd, draftRemove, draftRows, draftSet, flipOpen, health, isOpen, imageTarget, removeQuestion, renderDocker, deployFolder, deployQuestion, restartQuestion, findDeployTile, findDeploySession, blockedDeploy } from "./docker-view";
import { setLanguage, t } from "./i18n";

const c = (name: string, state: string, project: string | null = null, workingDir: string | null = null): DockerContainer => ({
  id: `id-${name}`,
  name,
  image: "nginx:1.27",
  state,
  status: state === "running" ? "Up 3 days" : "Exited (1)",
  project,
  service: project ? "web" : null,
  workingDir,
});
const img = (repository: string, tag: string, id = "ab12"): DockerImage => ({ id, repository, tag, size: "412 MB", created: "3 days ago" });
const host = (name: string, over: Partial<DockerHostView> = {}): DockerHostView => ({
  name,
  url: `ssh://${name}`,
  error: null,
  containers: [],
  images: [],
  networks: [],
  volumes: [],
  ...over,
});
const ov = (hosts: DockerHostView[], compose = true): DockerOverview => ({ cli: true, compose, hosts });
const none = new Set<string>();

describe("docker view", () => {
  beforeEach(() => setLanguage("pl"));

  it("health", () => {
    expect(health([c("a", "running"), c("b", "running")])).toBe("up");
    expect(health([c("a", "running"), c("b", "exited")])).toBe("partial");
    expect(health([c("a", "exited")])).toBe("down");
    expect(health([c("a", "restarting")])).toBe("partial");
    expect(health([c("a", "paused")])).toBe("partial");
  });

  it("renders missing cli", () => {
    const html = renderDocker({ cli: false, compose: false, hosts: [] }, none, none, new Map());
    expect(html).toContain(t("docker.noCli"));
    expect(html).not.toContain("data-d");
  });

  it("renders host error and keeps other hosts", () => {
    const html = renderDocker(
      ov([host("bad", { error: "server did not answer (3 s)" }), host("good", { containers: [c("web-1", "running", "web")] })]),
      new Set(["host:good", "proj:good/web"]),
      none,
      new Map(),
    );
    expect(html).toContain("server did not answer (3 s)");
    expect(html).toContain("web-1");
  });

  it("unfolds servers by default, folds the rest, and remembers a fold", () => {
    const o = ov([host("h", { containers: [c("web-1", "running", "web")] })]);
    const html = renderDocker(o, none, none, new Map());
    expect(html).toContain('data-open="proj:h/web"'); // the server is open, so its branches show
    expect(html).not.toContain("web-1"); // the project is folded
    const folded = flipOpen("host:h", none);
    expect(isOpen("host:h", folded)).toBe(false);
    expect(renderDocker(o, folded, none, new Map())).not.toContain('data-open="proj:h/web"');
    expect(isOpen("host:h", flipOpen("host:h", folded))).toBe(true);
    expect(isOpen("proj:h/web", flipOpen("proj:h/web", none))).toBe(true);
  });

  it("empty error string is still an error", () => {
    const html = renderDocker(ov([host("bad", { error: "" })]), none, none, new Map());
    expect(html).toContain(t("docker.errorFallback"));
  });

  it("groups by compose project", () => {
    const o = ov([host("h", { containers: [c("a-1", "running", "web"), c("lone", "running")] })]);
    const open = new Set(["host:h", "proj:h/web", "nocompose:h"]);
    const html = renderDocker(o, open, none, new Map());
    expect(html).toContain(t("docker.noCompose"));
    expect(html).toContain('data-d="projectLogs"');
    expect(renderDocker({ ...o, compose: false }, open, none, new Map())).not.toContain('data-d="projectLogs"');
  });

  it("shell disabled when not running", () => {
    const o = ov([host("h", { containers: [c("up", "running"), c("down", "exited")] })]);
    const html = renderDocker(o, new Set(["host:h", "nocompose:h"]), none, new Map());
    const shells = html.match(/<button[^>]*data-d="shell"[^>]*>/g) ?? [];
    expect(shells).toHaveLength(2);
    expect(shells.filter((b) => b.includes("disabled"))).toHaveLength(1);
    expect(shells.find((b) => b.includes("disabled"))).toContain('data-target="down"');
  });

  it("confirm text", () => {
    const all = [img("web", "latest"), img("web", "1.4")];
    expect(removeQuestion("H", all[1], all)).toContain("web:latest");
    const single = img("mm/web", "latest", "zz");
    expect(removeQuestion("H", single, [single])).toContain("412 MB");
  });

  it("none image removes by id", () => {
    expect(imageTarget({ repository: "<none>", tag: "<none>", id: "ab12", size: "1 MB", created: "" })).toBe("ab12");
    expect(imageTarget(img("web", "1.4"))).toBe("web:1.4");
  });

  it("image rm button busy", () => {
    const o = ov([host("h", { images: [img("web", "1.4")] })]);
    const html = renderDocker(o, new Set(["host:h", "images:h"]), new Set(["h|web:1.4"]), new Map());
    expect(html).toMatch(/<button[^>]*data-d="rm"[^>]*disabled/);
  });

  it("escapes names", () => {
    const o = ov([host("h", { containers: [c("<b>", "running")] })]);
    const html = renderDocker(o, new Set(["host:h", "nocompose:h"]), none, new Map());
    expect(html).not.toContain("<b>");
    expect(html).toContain("&#60;b&#62;");
  });
});

describe("checkHosts", () => {
  const h = (name: string, url: string) => ({ name, url });
  beforeEach(() => setLanguage("en"));
  it("accepts an empty list and good servers", () => {
    expect(checkHosts([])).toBeNull();
    expect(checkHosts([h("Docker1", "tcp://192.0.2.10:2375")])).toBeNull();
    expect(checkHosts([h("v6", "tcp://[::1]:2375"), h("sock", "unix:///var/run/docker.sock")])).toBeNull();
  });
  it("refuses a bad scheme, an empty rest and unsafe characters", () => {
    for (const url of ["http://x", "tcp://", "unix://", "tcp://x';calc;'", "tcp://a b", ""]) {
      expect(checkHosts([h("a", url)])).toBe(t("settings.dockerUrlBad", { name: "a" }));
    }
  });
  it("refuses an empty name and duplicates, ignoring case and spaces", () => {
    expect(checkHosts([h("  ", "tcp://x:1")])).toBe(t("settings.dockerNameEmpty"));
    expect(checkHosts([h("A", "tcp://x:1"), h(" a ", "tcp://y:1")])).toBe(t("settings.dockerNameDup", { name: "a" }));
  });
});

describe("Options draft", () => {
  const saved = [{ name: "a", url: "tcp://1.1.1.1:2375" }];
  it("shows the saved servers until something is typed, then the draft", () => {
    expect(draftRows(null, saved)).toEqual(saved);
    const typed = draftSet(draftAdd(draftRows(null, saved)), 1, "name", "b");
    expect(typed).toEqual([saved[0], { name: "b", url: "" }]);
    expect(draftRows(typed, saved)).toEqual(typed);
    expect(draftRows(null, saved)).toEqual(saved); // cleared after a save
    expect(saved).toEqual([{ name: "a", url: "tcp://1.1.1.1:2375" }]); // never mutated
  });
  it("removes a row by index", () => {
    expect(draftRemove([{ name: "a", url: "x" }, { name: "b", url: "y" }], 0)).toEqual([{ name: "b", url: "y" }]);
  });

  it("deployFolder: label match, name match, ambiguity, never outside openPaths", () => {
    const wd = (dir: string | null) => [c("a-1", "running", "mm-general", dir)];
    expect(deployFolder("mm-general", wd("/p/other"), ["/p/other", "/p/x"])).toBe("/p/other");
    expect(deployFolder("mm-general", wd("/srv/gone"), ["/p/MM-General"])).toBe("/p/MM-General");
    expect(deployFolder("mm-general", wd("/srv/gone"), ["/p/MM-General", "C:\\w\\mm-general"])).toBeNull();
    expect(deployFolder("web", [], ["/a/web", "/b/web"])).toBeNull();
    expect(deployFolder("web", [], ["C:\\a\\web"])).toBe("C:\\a\\web");
    expect(deployFolder("web", wd("/srv/web"), [])).toBeNull();
    expect(deployFolder("mm-general", [c("a", "running", "mm-general", "/p/a"), c("b", "running", "mm-general", "/p/b")], ["/p/a", "/p/b"])).toBeNull();
    expect(deployFolder("mm-general", wd("/srv/web"), ["/p/zzz"])).toBeNull();
  });

  it("restart and deploy questions", () => {
    setLanguage("pl");
    expect(restartQuestion("Docker1", "web-app-1")).toBe("Zrestartować kontener web-app-1 na Docker1? Usługa przestanie działać na kilka sekund.");
    const q = (git: { branch: string | null; dirty: number } | null) => deployQuestion("Docker1", "mm-general", "/p/mm-general", git);
    expect(q({ branch: "main", dirty: 3 })).toBe("Wdrożyć mm-general na Docker1 z /p/mm-general? Gałąź: main, 3 niezacommitowane zmiany.");
    expect(q({ branch: "main", dirty: 1 })).toContain("1 niezacommitowana zmiana.");
    expect(q({ branch: "main", dirty: 5 })).toContain("5 niezacommitowanych zmian.");
    expect(q({ branch: "main", dirty: 0 })).toBe("Wdrożyć mm-general na Docker1 z /p/mm-general? Gałąź: main, bez niezacommitowanych zmian.");
    expect(q(null)).toBe("Wdrożyć mm-general na Docker1 z /p/mm-general?");
  });

  it("restart on every row; deploy only with map entry and compose; path escaped", () => {
    const o = ov([host("h", { containers: [c("a", "running", "web"), c("b", "exited")] })]);
    const open = new Set(["host:h", "proj:h/web", "nocompose:h"]);
    const html = renderDocker(o, open, new Set(["h|a"]), new Map([["h|web", '/p/"x"&']]));
    expect(html.match(/data-d="restart"/g)).toHaveLength(2);
    expect(html).toMatch(/data-d="restart" data-host="h" data-target="a" disabled/);
    expect(html).toMatch(/data-d="restart" data-host="h" data-target="b">/);
    expect(html).toContain('data-d="deploy"');
    expect(html).toContain('data-path="/p/&#34;x&#34;&#38;"');
    expect(renderDocker(o, open, none, new Map())).not.toContain('data-d="deploy"');
    expect(renderDocker({ ...o, compose: false }, open, none, new Map([["h|web", "/p"]]))).not.toContain('data-d="deploy"');
  });
});

describe("findDeployTile", () => {
  const docker = {
    "/a#docker:1": { host: "srv", target: "shop", kind: "deploy" as const },
    "/a#docker:2": { host: "srv", target: "shop", kind: "logs" as const },
    "/b#docker:1": { host: "other", target: "shop", kind: "deploy" as const },
  };
  it("finds the open deploy tile of the same host and project", () => {
    expect(findDeployTile(docker, ["/a#docker:1", "/b#docker:1"], "srv", "shop")).toBe("/a#docker:1");
    expect(findDeployTile(docker, ["/b#docker:1"], "other", "shop")).toBe("/b#docker:1");
  });
  it("ignores closed tiles, other kinds and other hosts", () => {
    expect(findDeployTile(docker, [], "srv", "shop")).toBeNull();
    expect(findDeployTile(docker, ["/a#docker:2"], "srv", "shop")).toBeNull();
    expect(findDeployTile(docker, ["/a#docker:1"], "srv", "api")).toBeNull();
  });
});

describe("findDeploySession", () => {
  const docker = {
    "/a#docker:1": { host: "srv", target: "shop", kind: "deploy" as const },
    "/a#docker:2": { host: "srv", target: "shop", kind: "logs" as const },
    "/b#docker:1": { host: "other", target: "shop", kind: "deploy" as const },
  };
  it("prefers the open tile", () => {
    expect(findDeploySession(docker, ["/a#docker:1"], ["/a#docker:1"], "srv", "shop")).toEqual({ key: "/a#docker:1", open: true });
  });
  it("finds a deploy still running in tmux whose tile was closed", () => {
    expect(findDeploySession(docker, [], ["/a#docker:1", "/a#docker:2"], "srv", "shop")).toEqual({ key: "/a#docker:1", open: false });
  });
  it("ignores ended sessions, other kinds and other hosts", () => {
    expect(findDeploySession(docker, [], [], "srv", "shop")).toBeNull();
    expect(findDeploySession(docker, [], ["/a#docker:2"], "srv", "shop")).toBeNull();
    expect(findDeploySession(docker, [], ["/b#docker:1"], "srv", "shop")).toBeNull();
  });
});

describe("blockedDeploy", () => {
  const deploy = { host: "srv", target: "shop", kind: "deploy" as const };
  it("refuses a fresh deploy session that was not confirmed in the panel", () => {
    expect(blockedDeploy(deploy, false, false)).toBe(true);
  });
  it("lets the confirmed click start it, and a running one be attached", () => {
    expect(blockedDeploy(deploy, false, true)).toBe(false);
    expect(blockedDeploy(deploy, true, false)).toBe(false);
  });
  it("leaves logs, shells and other tiles alone", () => {
    expect(blockedDeploy({ ...deploy, kind: "logs" }, false, false)).toBe(false);
    expect(blockedDeploy(undefined, false, false)).toBe(false);
  });
});
