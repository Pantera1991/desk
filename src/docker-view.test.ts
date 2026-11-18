import { beforeEach, describe, expect, it } from "vitest";
import type { DockerContainer, DockerHostView, DockerImage, DockerOverview } from "./api";
import { checkHosts, health, imageTarget, removeQuestion, renderDocker } from "./docker-view";
import { setLanguage, t } from "./i18n";

const c = (name: string, state: string, project: string | null = null): DockerContainer => ({
  id: `id-${name}`,
  name,
  image: "nginx:1.27",
  state,
  status: state === "running" ? "Up 3 days" : "Exited (1)",
  project,
  service: project ? "web" : null,
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
    const html = renderDocker({ cli: false, compose: false, hosts: [] }, none, none);
    expect(html).toContain(t("docker.noCli"));
    expect(html).not.toContain("data-d");
  });

  it("renders host error and keeps other hosts", () => {
    const html = renderDocker(
      ov([host("bad", { error: "server did not answer (3 s)" }), host("good", { containers: [c("web-1", "running", "web")] })]),
      new Set(["host:good", "proj:good/web"]),
      none,
    );
    expect(html).toContain("server did not answer (3 s)");
    expect(html).toContain("web-1");
  });

  it("empty error string is still an error", () => {
    const html = renderDocker(ov([host("bad", { error: "" })]), none, none);
    expect(html).toContain(t("docker.errorFallback"));
  });

  it("groups by compose project", () => {
    const o = ov([host("h", { containers: [c("a-1", "running", "web"), c("lone", "running")] })]);
    const open = new Set(["host:h", "proj:h/web", "nocompose:h"]);
    const html = renderDocker(o, open, none);
    expect(html).toContain(t("docker.noCompose"));
    expect(html).toContain('data-d="projectLogs"');
    expect(renderDocker({ ...o, compose: false }, open, none)).not.toContain('data-d="projectLogs"');
  });

  it("shell disabled when not running", () => {
    const o = ov([host("h", { containers: [c("up", "running"), c("down", "exited")] })]);
    const html = renderDocker(o, new Set(["host:h", "nocompose:h"]), none);
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
    const html = renderDocker(o, new Set(["host:h", "images:h"]), new Set(["h|web:1.4"]));
    expect(html).toMatch(/<button[^>]*data-d="rm"[^>]*disabled/);
  });

  it("escapes names", () => {
    const o = ov([host("h", { containers: [c("<b>", "running")] })]);
    const html = renderDocker(o, new Set(["host:h", "nocompose:h"]), none);
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
