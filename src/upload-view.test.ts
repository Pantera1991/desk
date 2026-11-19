import { beforeEach, describe, expect, it } from "vitest";
import type { UploadHost, UploadTile } from "./api";
import { barBottomHtml, barHtml, barTopHtml, blockedUpload, checkUploadHosts, closePlan, findUploadSession, formatSize, hostLabel, openPlan, quitPlan, uploadDraftAdd, uploadDraftRemove, uploadDraftRows, uploadDraftSet, uploadQuestion } from "./upload-view";
import { setLanguage, t } from "./i18n";

const h = (host: string, user = "deploy", key = ""): UploadHost => ({ host, user, key });
const ok = { rsync: true, ssh: true };

describe("upload view", () => {
  beforeEach(() => setLanguage("pl"));

  it("checks servers", () => {
    expect(checkUploadHosts([])).toBeNull();
    expect(checkUploadHosts([h("")])).toBe(t("settings.uploadHostEmpty"));
    expect(checkUploadHosts([h("a")].map((x) => ({ ...x, user: "" })))).toBe(t("settings.uploadUserEmpty", { host: "a" }));
    expect(checkUploadHosts([h("a;b")])).toBe(t("settings.uploadHostBad", { host: "a;b" }));
    expect(checkUploadHosts([h("a", "-x")])).toBe(t("settings.uploadUserBad", { user: "-x" }));
    expect(checkUploadHosts([h("a", "deploy", "~/k'ey")])).toBe(t("settings.uploadKeyBad", { key: "~/k'ey" }));
    expect(checkUploadHosts([h("example-dev"), h("EXAMPLE-dev", "DEPLOY")])).toBe(t("settings.uploadDup", { target: "DEPLOY@EXAMPLE-dev" }));
    expect(checkUploadHosts([h("example-dev", "deploy", "~/.ssh/id_ed25519"), h("example-dev", "root")])).toBeNull();
    expect(checkUploadHosts([h("a", "deploy", "/keys/id")])).toBeNull();
    // A key ssh would look for relative to the tile's folder, or in another user's home: refused.
    expect(checkUploadHosts([h("a", "deploy", "id.key")])).toBe(t("settings.uploadKeyBad", { key: "id.key" }));
    expect(checkUploadHosts([h("a", "deploy", "~user/id")])).toBe(t("settings.uploadKeyBad", { key: "~user/id" }));
    expect(checkUploadHosts([h("a", "deploy", "-i")])).toBe(t("settings.uploadKeyBad", { key: "-i" }));
  });

  it("drafts are pure", () => {
    const rows = [h("a"), h("b")];
    const snap = JSON.stringify(rows);
    expect(uploadDraftSet(rows, 1, "user", "root")[1].user).toBe("root");
    expect(uploadDraftAdd(rows)).toHaveLength(3);
    expect(uploadDraftRemove(rows, 0).map((x) => x.host)).toEqual(["b"]);
    expect(JSON.stringify(rows)).toBe(snap);
    const saved = [h("s")];
    expect(uploadDraftRows(null, saved)).toEqual(saved);
    expect(uploadDraftRows(null, saved)[0]).not.toBe(saved[0]);
    expect(uploadDraftRows([], saved)).toEqual([]);
    const copy = uploadDraftRows(null, saved);
    copy[0].host = "changed";
    expect(saved[0].host).not.toBe("changed");
  });

  it("formats sizes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1288490189)).toBe("1.2 GB");
  });

  it("asks, and flags production", () => {
    const dev = uploadQuestion("dumps/latest.sql", { size: 1536, name: "2024-11-19.sql" }, h("example-dev"));
    expect(dev.prod).toBe(false);
    // The project file, and where it lands: the canonical file's name in the home folder.
    expect(dev.message).toBe("Wysłać dumps/latest.sql (1.5 KB) do deploy@example-dev:~/2024-11-19.sql? Plik o tej nazwie na serwerze zostanie nadpisany.");
    expect(uploadQuestion("a.sql", { size: 1, name: "a.sql" }, h("example-prod")).prod).toBe(true);
    expect(hostLabel(h("x"))).toBe("deploy@x");
  });

  it("blocks a tile that would start unconfirmed", () => {
    const tile: UploadTile = { host: "a", user: "u", file: "f" };
    expect(blockedUpload(tile, false, false)).toBe(true);
    expect(blockedUpload(tile, true, false)).toBe(false);
    expect(blockedUpload(tile, false, true)).toBe(false);
    expect(blockedUpload(undefined, false, false)).toBe(false);
  });

  it("finds a session by host, user and file", () => {
    const up = { k1: { host: "a", user: "deploy", file: "f" }, k2: { host: "a", user: "root", file: "f" } };
    expect(findUploadSession(up, ["k1", "k2"], { host: "a", user: "root", file: "f" })).toBe("k2");
    expect(findUploadSession(up, ["k1"], { host: "a", user: "root", file: "f" })).toBeNull();
    expect(findUploadSession(up, ["k1", "k2"], { host: "a", user: "x", file: "f" })).toBeNull();
  });

  it("asks before quitting only while uploads run, in the right plural", () => {
    expect(quitPlan([])).toBeNull();
    expect(quitPlan(["a"])).toEqual({ message: "Trwa 1 wysyłka. Przerwać i wyjść?", okLabel: t("upload.stopQuit") });
    expect(quitPlan(["a", "b"])?.message).toBe("Trwają 2 wysyłki. Przerwać i wyjść?");
    expect(quitPlan(["a", "b", "c", "d", "e"])?.message).toBe("Trwa 5 wysyłek. Przerwać i wyjść?");
    setLanguage("en");
    expect(quitPlan(["a"])?.message).toBe("1 upload is running. Stop it and quit?");
    expect(quitPlan(["a", "b"])?.message).toBe("2 uploads are running. Stop them and quit?");
    expect(quitPlan(["a", "b", "c", "d", "e"])?.message).toBe("5 uploads are running. Stop them and quit?");
  });

  it("closing asks only while rsync runs", () => {
    expect(closePlan(true)).toBe("ask");
    expect(closePlan(false)).toBe("close");
  });

  it("a second send focuses a running upload, replaces a finished one, else starts anew", () => {
    expect(openPlan("running")).toBe("focus");
    expect(openPlan("finished")).toBe("replace");
    expect(openPlan(null)).toBe("new");
  });

  it("renders the bar in its four states", () => {
    const base = { project: "desk", tools: ok, hosts: [h("example<b>")], host: null, file: null };
    const none = barHtml({ ...base, project: null });
    expect(none).toContain(t("upload.noProject"));
    expect(none).not.toContain("<select");
    expect(none).not.toContain('data-u="send"');
    const tools = barHtml({ ...base, tools: { rsync: true, ssh: false }, file: "a.sql" });
    expect(tools).toContain(t("upload.noTools"));
    expect(tools).not.toContain('data-u="send"');
    const pick = barHtml(base);
    expect(pick).toContain(t("upload.pickFile"));
    expect(pick).not.toContain('data-u="send"');
    const full = barHtml({ ...base, file: "a&b.sql" });
    expect(full).toContain('data-u="send"');
    expect(full).toContain("a&#38;b.sql");
    expect(full).toContain("deploy@example&#60;b&#62;");
    expect(full).not.toContain("example<b>");
    // The select goes above the tree, the file and "Wyślij" below it.
    expect(barTopHtml({ ...base, file: "a.sql" })).toContain("<select");
    expect(barTopHtml({ ...base, file: "a.sql" })).not.toContain('data-u="send"');
    expect(barBottomHtml({ ...base, file: "a.sql" })).toContain('data-u="send"');
    expect(barBottomHtml({ ...base, file: "a.sql" })).not.toContain("<select");
  });
});
