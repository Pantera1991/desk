// The Upload side panel: pure helpers (checking servers, Options drafts, size,
// confirm question, start gate) and the panel's top and bottom as HTML. The
// file tree is mounted separately. Data: upload.rs; behaviour: upload-panel.ts.
import type { UploadHost, UploadMethod, UploadTile } from "./api";
import { t, tn } from "./i18n";
import { escapeHtml as esc } from "./notices";

// Mirror upload.rs valid_host / valid_user / valid_key.
export const HOST_RULE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
export const USER_RULE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$/;
// A key is a full path (from / or ~/): ssh would look for a relative one in the tile's folder.
export const KEY_RULE = /^(?:(?:\/|~\/)[A-Za-z0-9._~/-]*)?$/;

/** `user@host`, as shown and as rsync takes it. */
export function hostLabel(h: { host: string; user: string }): string {
  return `${h.user}@${h.host}`;
}

/** Options → Upload: null when the servers can be saved, else the message to show. */
export function checkUploadHosts(hosts: UploadHost[]): string | null {
  const seen = new Set<string>();
  for (const h of hosts) {
    const host = h.host.trim();
    const user = h.user.trim();
    const key = h.key.trim();
    if (!host) return t("settings.uploadHostEmpty");
    if (!user) return t("settings.uploadUserEmpty", { host });
    if (!HOST_RULE.test(host)) return t("settings.uploadHostBad", { host });
    if (!USER_RULE.test(user)) return t("settings.uploadUserBad", { user });
    if (!KEY_RULE.test(key)) return t("settings.uploadKeyBad", { key });
    const id = hostLabel({ host, user }).toLowerCase();
    if (seen.has(id)) return t("settings.uploadDup", { target: hostLabel({ host, user }) });
    seen.add(id);
  }
  return null;
}

/** Options → Upload: the rows as typed and not saved yet. Pure edits on copies. */
export function uploadDraftRows(draft: UploadHost[] | null, saved: UploadHost[]): UploadHost[] {
  return (draft ?? saved).map((h) => ({ ...h }));
}

export function uploadDraftSet(rows: UploadHost[], i: number, field: "host" | "user" | "key" | "method", value: string): UploadHost[] {
  return rows.map((h, j) => (j === i ? { ...h, [field]: value } : { ...h }));
}

export function uploadDraftAdd(rows: UploadHost[]): UploadHost[] {
  return [...rows.map((h) => ({ ...h })), { host: "", user: "", key: "", method: "rsync" }];
}

/** A server's upload program: scp only when Options say so. */
export function methodOf(h: UploadHost | undefined): UploadMethod {
  return h?.method === "scp" ? "scp" : "rsync";
}

export function uploadDraftRemove(rows: UploadHost[], i: number): UploadHost[] {
  return rows.filter((_, j) => j !== i).map((h) => ({ ...h }));
}

/** Bytes as B, KB, MB, GB or TB, base 1024, one decimal above bytes. */
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return u === 0 ? `${bytes} B` : `${n.toFixed(1)} ${units[u]}`;
}

/** The confirmation: the project file and where it lands, `~/<name>` (`name`:
 *  the canonical file's, a symlink's target). `prod` (a production-looking
 *  name) asks for a stronger warning. */
export function uploadQuestion(file: string, info: { size: number; name: string }, h: UploadHost): { message: string; prod: boolean } {
  const message = t("upload.confirm", { file, size: formatSize(info.size), target: hostLabel(h), name: info.name });
  return { message, prod: /prod/i.test(h.host) };
}

/** An upload tile whose session would start anew other than from a click
 *  confirmed in the Upload panel (restore, ⌘⇧T, resuming work): refused. */
export function blockedUpload(tile: UploadTile | undefined, running: boolean, confirmed: boolean): boolean {
  return tile !== undefined && !running && !confirmed;
}

/** The open tile sending that file to that user@host, if any among `keys`. */
export function findUploadSession(uploads: Record<string, UploadTile>, keys: readonly string[], t: UploadTile): string | null {
  return keys.find((k) => uploads[k]?.host === t.host && uploads[k].user === t.user && uploads[k].file === t.file) ?? null;
}

/** Quitting desk while uploads run (one entry each): the question to ask first,
 *  null when none runs. Its ok stops them and quits (no second question). */
export function quitPlan(running: readonly string[]): { message: string; okLabel: string } | null {
  if (running.length === 0) return null;
  return { message: tn("upload.quitRunning", running.length), okLabel: t("upload.stopQuit") };
}

/** ✕ or ⌘Q on an upload tile: asked while rsync runs, else closed (its session ends). */
export function closePlan(running: boolean): "ask" | "close" {
  return running ? "ask" : "close";
}

/** "Wyślij" of a file that may have an upload session already (`existing`): one
 *  still sending is shown (never a second concurrent rsync), one that finished
 *  ends and a new one starts after the question (`--partial` resumes), else new. */
export function openPlan(existing: "running" | "finished" | null): "focus" | "replace" | "new" {
  if (existing === "running") return "focus";
  return existing === "finished" ? "replace" : "new";
}

export interface UploadBar {
  project: string | null;
  tools: { rsync: boolean; scp: boolean; ssh: boolean } | null;
  hosts: UploadHost[];
  host: string | null;
  file: string | null;
}

/** The panel's top: the server select (nothing without a project). `host` is a `user@host` label. */
export function barTopHtml(s: UploadBar): string {
  if (s.project === null) return "";
  const options = s.hosts
    .map((h) => {
      const label = hostLabel(h);
      return `<option value="${esc(label)}"${label === s.host ? " selected" : ""}>${esc(label)}</option>`;
    })
    .join("");
  return `<div class="ul-top"><select data-u="host">${options}</select></div>`;
}

/** The panel's bottom, under the tree: what is missing, or the selected file and "Wyślij". */
export function barBottomHtml(s: UploadBar): string {
  if (s.project === null) return `<div class="ul-empty">${esc(t("upload.noProject"))}</div>`;
  if (s.tools !== null) {
    const tool = methodOf(s.hosts.find((h) => hostLabel(h) === s.host) ?? s.hosts[0]);
    if (!s.tools[tool] || !s.tools.ssh) return `<div class="ul-empty">${esc(t("upload.noTools", { tool }))}</div>`;
  }
  if (s.file === null) return `<div class="ul-empty">${esc(t("upload.pickFile"))}</div>`;
  return `<div class="ul-bottom"><span class="ul-file" title="${esc(s.file)}">${esc(s.file)}</span><button data-u="send">${esc(t("upload.send"))}</button></div>`;
}

/** Both halves in one string (top, then bottom). */
export function barHtml(s: UploadBar): string {
  return barTopHtml(s) + barBottomHtml(s);
}
