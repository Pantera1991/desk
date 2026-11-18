// The Docker side panel, as HTML: a tree per server (compose projects with
// their containers, containers without compose, images, networks, volumes).
// Pure: open branches and busy buttons come in as sets. Data: docker.rs;
// behaviour: docker-panel.ts.
import type { DockerTile, DockerHost, DockerContainer, DockerHostView, DockerImage, DockerNamed, DockerOverview, GitSummary } from "./api";
import { t, tn } from "./i18n";
import { escapeHtml as esc } from "./notices";

export type Health = "up" | "partial" | "down";

/** All running: up; none running: down; anything else (also restarting, paused): partial. */
export function health(containers: DockerContainer[]): Health {
  const running = containers.filter((c) => c.state === "running").length;
  if (running === containers.length) return "up";
  const wavering = containers.some((c) => c.state === "restarting" || c.state === "paused");
  return running === 0 && !wavering ? "down" : "partial";
}

const NONE = "<none>";

/** What `docker image rm` takes: `repo:tag`, or the id of an untagged image. */
export function imageTarget(img: DockerImage): string {
  return img.repository === NONE || img.tag === NONE ? img.id : `${img.repository}:${img.tag}`;
}

/** The confirmation: a shared image only loses a tag, nothing is freed. */
export function removeQuestion(host: string, img: DockerImage, all: DockerImage[]): string {
  const image = imageTarget(img);
  const others = all.filter((o) => o.id === img.id && o !== img).map(imageTarget);
  if (others.length > 0) return t("docker.rmTag", { image, host, others: others.join(", ") });
  return t("docker.rmImage", { image, host, size: img.size });
}

/** The confirmation for restarting a container. */
export function restartQuestion(host: string, container: string): string {
  return t("docker.restartQuestion", { host, container });
}

/** The confirmation for a deploy; `git` null (not a repository) leaves out the branch part. Path as given. */
export function deployQuestion(host: string, project: string, path: string, git: GitSummary | null): string {
  let tail = "";
  if (git !== null) {
    const changes = git.dirty === 0 ? t("docker.deployClean") : tn("docker.deployDirty", git.dirty);
    tail = t("docker.deployBranch", { branch: git.branch ?? "HEAD", changes });
  }
  return t("docker.deployQuestion", { project, host, path, git: tail });
}

const base = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? "";

/** The open card (folder) a compose project is deployed from; only ever one of `openPaths`. */
export function deployFolder(project: string, containers: DockerContainer[], openPaths: readonly string[]): string | null {
  const byLabel = new Set(
    containers.filter((c) => c.project === project && c.workingDir !== null && openPaths.includes(c.workingDir)).map((c) => c.workingDir as string),
  );
  // Labels naming two open folders: no guess, and no falling back to the name either.
  if (byLabel.size > 0) return byLabel.size === 1 ? [...byLabel][0] : null;
  const named = [...new Set(openPaths.filter((p) => base(p).toLowerCase() === project.toLowerCase()))];
  return named.length === 1 ? named[0] : null;
}

/** The tile of that kind for a target on a server (its layout key), if any among `openKeys`. */
export function findDockerTile(
  docker: Record<string, DockerTile>,
  openKeys: readonly string[],
  host: string,
  target: string,
  kind: DockerTile["kind"],
): string | null {
  return openKeys.find((k) => docker[k]?.kind === kind && docker[k].host === host && docker[k].target === target) ?? null;
}

/** The session of that kind for a target on a server: its open tile, else one still
 *  running in tmux whose tile was closed (⌘Q keeps the session), to attach
 *  again instead of starting a second one (a second `compose up`, a twin logs tile). */
export function findDockerSession(
  docker: Record<string, DockerTile>,
  openKeys: readonly string[],
  runningKeys: readonly string[],
  host: string,
  target: string,
  kind: DockerTile["kind"],
): { key: string; open: boolean } | null {
  const open = findDockerTile(docker, openKeys, host, target, kind);
  if (open !== null) return { key: open, open: true };
  const running = findDockerTile(docker, runningKeys, host, target, kind);
  return running === null ? null : { key: running, open: false };
}

/** A deploy tile whose session would start anew (`compose up --build`) other
 *  than from a click confirmed in the Docker panel ("Przywróć", ⌘⇧T, resuming
 *  work): refused, so a deploy never runs again without asking. */
export function blockedDeploy(tile: DockerTile | undefined, running: boolean, confirmed: boolean): boolean {
  return tile?.kind === "deploy" && !running && !confirmed;
}

const ICON: Record<Health, string> = { up: "●", partial: "◐", down: "○" };

const CLOSED = "closed:";

/** Servers (`host:<name>`) are unfolded unless the user folded them (stored as `closed:<id>`); every other branch is folded unless stored as open. */
export function isOpen(id: string, open: ReadonlySet<string>): boolean {
  return id.startsWith("host:") ? !open.has(CLOSED + id) : open.has(id);
}

/** The state after a click on a branch. */
export function flipOpen(id: string, open: ReadonlySet<string>): Set<string> {
  const next = new Set(open);
  const key = id.startsWith("host:") ? CLOSED + id : id;
  if (!next.delete(key)) next.add(key);
  return next;
}

function toggle(id: string, open: ReadonlySet<string>, inner: string, body: string): string {
  const o = isOpen(id, open);
  return `<div class="dk-branch${o ? " open" : ""}"><div class="dk-row dk-toggle" data-open="${esc(id)}"><span class="dk-caret">${o ? "▾" : "▸"}</span>${inner}</div>${o ? `<div class="dk-children">${body}</div>` : ""}</div>`;
}

function btn(kind: string, host: string, target: string, label: string, disabled: boolean): string {
  return `<button type="button" class="dk-btn" data-d="${kind}" data-host="${esc(host)}" data-target="${esc(target)}"${disabled ? " disabled" : ""}>${esc(label)}</button>`;
}

function containerRow(host: string, c: DockerContainer, busy: ReadonlySet<string>): string {
  const h: Health = c.state === "running" ? "up" : c.state === "restarting" || c.state === "paused" ? "partial" : "down";
  return `<div class="dk-row dk-container"><span class="dk-dot dk-${h}">${ICON[h]}</span><span class="dk-name">${esc(c.name)}</span><span class="dk-image">${esc(c.image)}</span><span class="dk-status">${esc(c.status)}</span>${btn("logs", host, c.name, t("docker.logs"), false)}${btn("shell", host, c.name, t("docker.shell"), c.state !== "running")}${btn("restart", host, c.name, t("docker.restart"), busy.has(`${host}|${c.name}`))}</div>`;
}

function deployBtn(host: string, project: string, path: string): string {
  return `<button type="button" class="dk-btn" data-d="deploy" data-host="${esc(host)}" data-target="${esc(project)}" data-path="${esc(path)}">${esc(t("docker.deploy"))}</button>`;
}

function projectBranch(host: string, name: string, list: DockerContainer[], compose: boolean, open: ReadonlySet<string>, busy: ReadonlySet<string>, path: string | undefined): string {
  const h = health(list);
  const up = list.filter((c) => c.state === "running").length;
  const inner = `<span class="dk-dot dk-${h}" title="${esc(t(`docker.health.${h}` as const))}">${ICON[h]}</span><span class="dk-name">${esc(name)}</span><span class="dk-count">${up}/${list.length}</span>${compose ? btn("projectLogs", host, name, t("docker.logs"), false) : ""}${compose && path !== undefined ? deployBtn(host, name, path) : ""}`;
  return toggle(`proj:${host}/${name}`, open, inner, list.map((c) => containerRow(host, c, busy)).join(""));
}

function imageRow(host: string, img: DockerImage, all: DockerImage[], busy: ReadonlySet<string>): string {
  const target = imageTarget(img);
  const label = img.repository === NONE ? `${NONE} ${img.id}` : `${img.repository}:${img.tag}`;
  const q = removeQuestion(host, img, all);
  return `<div class="dk-row dk-img"><span class="dk-name">${esc(label)}</span><span class="dk-size">${esc(img.size)}</span><span class="dk-age">${esc(img.created)}</span><button type="button" class="dk-btn" data-d="rm" data-host="${esc(host)}" data-target="${esc(target)}" data-question="${esc(q)}"${busy.has(`${host}|${target}`) ? " disabled" : ""}>${esc(t("docker.remove"))}</button></div>`;
}

function namedRow(n: DockerNamed): string {
  return `<div class="dk-row"><span class="dk-name">${esc(n.name)}</span><span class="dk-image">${esc(n.driver)}</span></div>`;
}

function group(id: string, label: string, count: number, body: string, open: ReadonlySet<string>): string {
  return toggle(id, open, `<span class="dk-name">${esc(label)} (${count})</span>`, body);
}

function hostBranch(o: DockerOverview, h: DockerHostView, open: ReadonlySet<string>, busy: ReadonlySet<string>, deployable: ReadonlyMap<string, string>): string {
  if (h.error !== null) {
    const msg = h.error === "" ? t("docker.errorFallback") : t("docker.hostError", { error: h.error });
    return `<div class="dk-branch"><div class="dk-row dk-host dk-err"><span class="dk-dot dk-down">✕</span><span class="dk-name">${esc(h.name)}</span><span class="dk-error">${esc(msg)}</span></div></div>`;
  }
  const projects = new Map<string, DockerContainer[]>();
  const loose: DockerContainer[] = [];
  for (const c of h.containers) {
    if (c.project === null) loose.push(c);
    else projects.set(c.project, [...(projects.get(c.project) ?? []), c]);
  }
  const hh = health(h.containers);
  const inner = `<span class="dk-dot dk-${hh}">${ICON[hh]}</span><span class="dk-name">${esc(h.name)}</span><span class="dk-count">${esc(tn("docker.containers", h.containers.length))}</span>`;
  const body =
    [...projects].map(([name, list]) => projectBranch(h.name, name, list, o.compose, open, busy, deployable.get(`${h.name}|${name}`))).join("") +
    group(`nocompose:${h.name}`, t("docker.noCompose"), loose.length, loose.map((c) => containerRow(h.name, c, busy)).join(""), open) +
    group(`images:${h.name}`, t("docker.images"), h.images.length, h.images.map((i) => imageRow(h.name, i, h.images, busy)).join(""), open) +
    group(`networks:${h.name}`, t("docker.networks"), h.networks.length, h.networks.map(namedRow).join(""), open) +
    group(`volumes:${h.name}`, t("docker.volumes"), h.volumes.length, h.volumes.map(namedRow).join(""), open);
  return toggle(`host:${h.name}`, open, inner, body);
}

/** `busy` holds "host|target" of the images being removed or containers restarting; `open` the branch state (see isOpen);
 *  `deployable` maps "host|project" to the local folder it deploys from. */
export function renderDocker(o: DockerOverview | null, open: ReadonlySet<string>, busy: ReadonlySet<string>, deployable: ReadonlyMap<string, string>): string {
  if (!o) return `<div class="dk-empty">${esc(t("docker.loading"))}</div>`;
  if (!o.cli) return `<div class="dk-empty">${esc(t("docker.noCli"))}</div>`;
  if (o.hosts.length === 0) return `<div class="dk-empty">${esc(t("docker.noHosts"))}</div>`;
  return o.hosts.map((h) => hostBranch(o, h, open, busy, deployable)).join("");
}

/** The same rule as Rust's valid_url (docker.rs): `tcp://` or `unix://`, then
 *  ASCII alphanumerics and `.:/_-[]@%` only, so Rust never refuses what Options took. */
const URL_RULE = /^(?:tcp|unix):\/\/[A-Za-z0-9.:/_\-[\]@%]+$/;

/** Options → Docker: null when the servers can be saved, else the message to show. */
export function checkHosts(hosts: DockerHost[]): string | null {
  const seen = new Set<string>();
  for (const h of hosts) {
    const name = h.name.trim();
    if (!name) return t("settings.dockerNameEmpty");
    if (!URL_RULE.test(h.url.trim())) return t("settings.dockerUrlBad", { name });
    const key = name.toLowerCase();
    if (seen.has(key)) return t("settings.dockerNameDup", { name });
    seen.add(key);
  }
  return null;
}

/** Options → Docker: the rows as typed and not saved yet (kept across tab switches). Pure edits on copies. */
export function draftRows(draft: DockerHost[] | null, saved: DockerHost[]): DockerHost[] {
  return (draft ?? saved).map((h) => ({ ...h }));
}

export function draftSet(rows: DockerHost[], i: number, field: "name" | "url", value: string): DockerHost[] {
  return rows.map((h, j) => (j === i ? { ...h, [field]: value } : { ...h }));
}

export function draftAdd(rows: DockerHost[]): DockerHost[] {
  return [...rows.map((h) => ({ ...h })), { name: "", url: "" }];
}

export function draftRemove(rows: DockerHost[], i: number): DockerHost[] {
  return rows.filter((_, j) => j !== i).map((h) => ({ ...h }));
}
