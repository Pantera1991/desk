// Small UI helpers: confirm dialog and toasts (window.confirm is not available in the webview).
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { GithubRepo } from "./api";
import { matchRepos, repoName } from "./github";
import { t } from "./i18n";
import { historyHtml, noticeHtml, notices, type NoticeOptions, type NoticeTopic } from "./notices";
import { escapeHtml } from "./tile";

export function confirmBox(message: string, okLabel = t("common.yes")): Promise<boolean> {
  return choiceBox(message, okLabel).then((v) => v === "ok");
}

export interface ChoiceOptions {
  /** A second, stronger answer; chosen by click only (↵ stays the first). */
  altLabel?: string;
  /** Lines listed under the message. */
  details?: string[];
  /** Replaces "Cancel" on the first button. */
  cancelLabel?: string;
  /** A red line under the message. */
  warning?: string;
}

/** A confirm dialog that may offer a second answer ("alt"); null on Esc. */
export function choiceBox(message: string, okLabel: string, opts: ChoiceOptions = {}): Promise<"ok" | "alt" | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const details = opts.details?.length ? `<ul class="details">${opts.details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>` : "";
    const warning = opts.warning ? `<p class="choice-warning">${escapeHtml(opts.warning)}</p>` : "";
    const cancel = opts.cancelLabel ? escapeHtml(opts.cancelLabel) : t("common.cancel");
    const alt = opts.altLabel ? `<button data-v="alt" class="danger">${escapeHtml(opts.altLabel)}</button>` : "";
    overlay.innerHTML = `
      <div class="dialog confirm${alt ? " wide" : ""}">
        <p>${escapeHtml(message)}</p>${warning}${details}
        <div class="buttons"><button data-v="">${cancel} <kbd>esc</kbd></button>${alt}<button data-v="ok" class="danger">${escapeHtml(okLabel)} <kbd>↵</kbd></button></div>
      </div>`;
    const done = (v: "ok" | "alt" | null) => {
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        done(e.key === "Enter" ? "ok" : null);
      }
    };
    overlay.addEventListener("click", (e) => {
      const v = (e.target as HTMLElement).closest("button")?.dataset.v;
      if (v !== undefined) done(v === "ok" || v === "alt" ? v : null);
      else if (e.target === overlay) done(null);
    });
    window.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
  });
}

export interface BackgroundRow {
  key: string;
  name: string;
  /** Agent and sub-session: "claude", "codex #2". */
  label: string;
  path: string;
  /** Tile state ("working", "waiting"...) and its text. */
  state: string;
  stateLabel: string;
}

/** Sessions running without a tile: ↑↓, ↵ opens one in a tile (resolves to
 *  its key), ⌘⌫ or ✕ kills it, the button kills them all. Null on Esc. */
export function backgroundBox(load: () => Promise<BackgroundRow[]>, kill: (keys: string[]) => Promise<void>, killKeys: string): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog palette background">
        <header>${t("background.title")}</header>
        <div class="list"></div>
        <footer><kbd>↵</kbd> ${t("background.open")} <kbd>${escapeHtml(killKeys)}</kbd> ${t("background.kill")} <kbd>esc</kbd> ${t("common.close")}<span class="spacer"></span><button class="danger" data-all hidden></button></footer>
      </div>`;
    const list = overlay.querySelector<HTMLElement>(".list")!;
    const all = overlay.querySelector<HTMLButtonElement>("[data-all]")!;
    let rows: BackgroundRow[] = [];
    let sel = 0;
    let sure = false; // "kill all" was clicked once
    let busy = false;
    const draw = () => {
      sel = Math.min(sel, Math.max(0, rows.length - 1));
      list.innerHTML = rows.length
        ? rows
            .map(
              (r, n) =>
                `<div class="row ${n === sel ? "sel" : ""}" data-i="${n}"><span class="name">${escapeHtml(r.name)}</span><span class="agent">${escapeHtml(r.label)}</span><span class="path">${escapeHtml(r.path)}</span><span class="c-${escapeHtml(r.state)}">${escapeHtml(r.stateLabel)}</span><button class="kill" data-kill="${n}" title="${t("background.kill")}">✕</button></div>`,
            )
            .join("")
        : `<div class="empty">${t("background.none")}</div>`;
      all.hidden = rows.length < 2;
      all.textContent = t(sure ? "background.killAllSure" : "background.killAll", { n: rows.length });
      list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
    };
    const reload = async () => {
      rows = await load().catch(() => rows);
      draw();
    };
    const killRows = async (keys: string[]) => {
      if (busy || !keys.length) return;
      busy = true;
      sure = false;
      await kill(keys).catch((err) => toast(String(err), { topic: "sessions" }));
      await reload();
      busy = false;
    };
    const done = (v: string | null) => {
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const keys: Record<string, () => void> = {
        Escape: () => done(null),
        Enter: () => rows[sel] && done(rows[sel].key),
        ArrowDown: () => ((sel = Math.min(sel + 1, rows.length - 1)), draw()),
        ArrowUp: () => ((sel = Math.max(sel - 1, 0)), draw()),
        Backspace: () => mod && rows[sel] && void killRows([rows[sel].key]),
      };
      const f = keys[e.key];
      if (!f) return;
      e.preventDefault();
      e.stopPropagation();
      f();
    };
    overlay.addEventListener("click", (e) => {
      const el = e.target as HTMLElement;
      const k = el.closest<HTMLElement>("[data-kill]")?.dataset.kill;
      const i = el.closest<HTMLElement>(".row")?.dataset.i;
      if (el.closest("[data-all]")) {
        if (sure) void killRows(rows.map((r) => r.key));
        else {
          sure = true;
          draw();
        }
      } else if (k !== undefined) void killRows([rows[Number(k)].key]);
      else if (i !== undefined) done(rows[Number(i)].key);
      else if (e.target === overlay) done(null);
    });
    window.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    draw();
    void reload();
  });
}

export interface Picked {
  value: string;
  /** Chosen with ⌥↵ / ⌥-click. */
  alt: boolean;
}

export interface PickOptions {
  current?: string | null;
  /** Footer hint for ⌥↵, when it does something. */
  altHint?: string;
  /** Extra text after an item (e.g. where a command comes from). */
  note?: (item: string) => string;
}

const PICK_ROWS = 300;

/** Pick one of `items` (type to filter, ↑↓, ↵); resolves to null on Esc. */
export function pickBox(title: string, items: string[], opts: PickOptions = {}): Promise<Picked | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog palette pick">
        <input type="text" spellcheck="false" autocomplete="off" />
        <div class="list"></div>
        <footer><span class="dim"></span><kbd>↵</kbd> ${t("pick.choose")} ${
          opts.altHint ? `<kbd>⌥↵</kbd> ${escapeHtml(opts.altHint)} ` : ""
        }<kbd>esc</kbd> ${t("common.close")}</footer>
      </div>`;
    const input = overlay.querySelector("input")!;
    const list = overlay.querySelector<HTMLElement>(".list")!;
    input.placeholder = title;
    overlay.querySelector("footer .dim")!.textContent = title;
    let shown: string[] = [];
    let sel = 0;
    const draw = () => {
      const q = input.value.toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      shown = items.filter((i) => words.every((w) => i.toLowerCase().includes(w))).slice(0, PICK_ROWS);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.innerHTML = shown
        .map(
          (i, n) =>
            `<div class="row ${n === sel ? "sel" : ""}" data-i="${n}"><span class="name">${escapeHtml(i)}</span>${
              i === opts.current ? `<span class="dim">${t("pick.current")}</span>` : ""
            }${opts.note ? `<span class="dim">${escapeHtml(opts.note(i))}</span>` : ""}</div>`,
        )
        .join("");
      list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
    };
    const done = (v: Picked | null) => {
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      const keys: Record<string, () => void> = {
        Escape: () => done(null),
        Enter: () => done(shown[sel] === undefined ? null : { value: shown[sel], alt: e.altKey }),
        ArrowDown: () => ((sel = Math.min(sel + 1, shown.length - 1)), draw()),
        ArrowUp: () => ((sel = Math.max(sel - 1, 0)), draw()),
      };
      const f = keys[e.key];
      if (!f) return;
      e.preventDefault();
      e.stopPropagation();
      f();
    };
    input.addEventListener("input", () => ((sel = 0), draw()));
    overlay.addEventListener("click", (e) => {
      const i = (e.target as HTMLElement).closest<HTMLElement>(".row")?.dataset.i;
      if (i !== undefined) done({ value: shown[Number(i)], alt: e.altKey });
      else if (e.target === overlay) done(null);
    });
    window.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    draw();
    input.focus();
  });
}

/** Cards shown at once; older ones live on in the bell's history. */
const CARDS = 4;

/** A card in the top right corner, newest on top, and a line in the history
 *  (notices.ts). `opts` as a number: how long it stays, as before. */
export function toast(message: string, opts?: number | NoticeOptions): void {
  const n = notices.add(message, opts);
  const stack = noticeStack();
  stack.insertAdjacentHTML("afterbegin", noticeHtml(n));
  for (const old of [...stack.children].slice(CARDS)) old.remove();
}

function noticeStack(): HTMLElement {
  const found = document.querySelector<HTMLElement>(".notices");
  if (found) return found;
  const el = document.createElement("div");
  el.className = "notices";
  el.setAttribute("aria-live", "polite");
  // The thin bar at the bottom runs out (it waits while hovered): the card goes.
  el.addEventListener("animationend", (e) => {
    const bar = e.target as HTMLElement;
    if (bar.classList.contains("notice-timer")) bar.closest(".notice")?.remove();
  });
  el.addEventListener("click", (e) => noticeClick(e));
  document.body.appendChild(el);
  return el;
}

/** ✕, the action and "Kopiuj błąd", on a card or in the history. */
function noticeClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const box = target.closest<HTMLElement>("[data-notice]");
  const n = box ? notices.get(Number(box.dataset.notice)) : undefined;
  if (!box || !n) return;
  const card = box.classList.contains("notice");
  if (target.closest("[data-notice-close]")) {
    notices.seen(n.id);
    box.remove();
  } else if (target.closest("[data-notice-act]")) {
    notices.seen(n.id);
    if (card) box.remove();
    else closeNoticeHistory();
    n.action?.run();
  } else {
    const copy = target.closest<HTMLButtonElement>("[data-notice-copy]");
    if (!copy) return;
    void writeText(n.text).then(
      () => (copy.textContent = t("notice.copied")),
      (err) => (copy.textContent = String(err)),
    );
  }
}

let history: HTMLElement | null = null;
/** The topic the open history shows; null: all. It opens showing all. */
let historyTopic: NoticeTopic | null = null;

/** The bell's list over the bottom bar; the bell again, Esc or a click elsewhere closes it. */
export function toggleNoticeHistory(): void {
  if (history) return closeNoticeHistory();
  notices.seenAll();
  historyTopic = null;
  history = document.createElement("div");
  history.className = "notice-history";
  history.setAttribute("role", "dialog");
  history.setAttribute("aria-label", t("notice.history"));
  drawHistory();
  history.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const filter = target.closest<HTMLElement>("[data-notice-topic]");
    if (filter) {
      historyTopic = (filter.dataset.noticeTopic as NoticeTopic) || null;
      return drawHistory();
    }
    if (!target.closest("[data-notice-clear]")) return noticeClick(e);
    // What is shown: one topic, or all of them.
    notices.clear(historyTopic ?? undefined);
    historyTopic = null;
    if (notices.all().length) drawHistory();
    else closeNoticeHistory();
  });
  document.body.appendChild(history);
  document.addEventListener("mousedown", leaveHistory, true);
  window.addEventListener("keydown", escHistory, true);
  window.addEventListener("blur", closeNoticeHistory);
}

function drawHistory(): void {
  if (history) history.innerHTML = historyHtml(notices.all(), historyTopic);
}

function closeNoticeHistory(): void {
  history?.remove();
  history = null;
  document.removeEventListener("mousedown", leaveHistory, true);
  window.removeEventListener("keydown", escHistory, true);
  window.removeEventListener("blur", closeNoticeHistory);
}

function leaveHistory(e: MouseEvent): void {
  const target = e.target instanceof Element ? e.target : null;
  // The bell toggles it itself.
  if (target && (history?.contains(target) || target.closest("[data-notices-open]"))) return;
  closeNoticeHistory();
}

function escHistory(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  closeNoticeHistory();
}

export interface NewProject {
  parent: string;
  name: string;
  git: boolean;
  /** `owner/name` to clone instead of creating an empty folder. */
  repo: string | null;
}

/** Ask for a new project's name and parent folder; typing a name also
 * offers matching GitHub repos to clone. */
export function newProjectBox(
  defaultParent: string,
  pickFolder: () => Promise<string | null>,
  agent: string,
  opts: { name?: string; repos: Promise<GithubRepo[]>; isLocal: (name: string) => boolean },
): Promise<NewProject | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog new-project">
        <h2>${t("newProject.title")} <span class="dim">· ${escapeHtml(agent)}</span></h2>
        <label class="line">${t("newProject.name")} <input type="text" data-k="name" spellcheck="false" autocomplete="off" placeholder="${t("newProject.namePlaceholder")}" /></label>
        <div class="gh-list"></div>
        <label class="line">${t("newProject.parent")} <input type="text" data-k="parent" spellcheck="false" /><button data-k="pick">${t("newProject.pick")}</button></label>
        <label class="line" data-k="git-line"><input type="checkbox" data-k="git" checked /> ${t("newProject.git")}</label>
        <div class="line gh-chosen" hidden>${t("newProject.clone")} <b data-k="repo"></b><button data-k="unpick" title="${t("newProject.unpick")}">✕</button></div>
        <div class="buttons"><button data-v="0">${t("common.cancel")} <kbd>esc</kbd></button><button data-v="1"><span data-k="ok">${t("newProject.create")}</span> <kbd>↵</kbd></button></div>
      </div>`;
    const $ = <T extends HTMLElement>(k: string) => overlay.querySelector<T>(`[data-k="${k}"]`)!;
    const name = $<HTMLInputElement>("name");
    const parent = $<HTMLInputElement>("parent");
    const git = $<HTMLInputElement>("git");
    const list = overlay.querySelector<HTMLElement>(".gh-list")!;
    const chosenLine = overlay.querySelector<HTMLElement>(".gh-chosen")!;
    parent.value = defaultParent;
    name.value = opts.name ?? "";

    let repos: GithubRepo[] | null = null;
    let error = "";
    let shown: GithubRepo[] = [];
    let sel = -1;
    let chosen: GithubRepo | null = null;
    const draw = () => {
      chosenLine.hidden = !chosen;
      $("git-line").hidden = !!chosen;
      $("repo").textContent = chosen?.fullName ?? "";
      $("ok").textContent = chosen ? t("newProject.cloneOpen") : t("newProject.create");
      shown = chosen || !repos ? [] : matchRepos(repos, name.value);
      sel = Math.min(sel, shown.length - 1);
      const status =
        chosen || !name.value.trim()
          ? ""
          : error
            ? `<div class="gh-status">GitHub: ${escapeHtml(error)}</div>`
            : !repos
              ? `<div class="gh-status">GitHub: ${t("newProject.loadingRepos")}</div>`
              : "";
      list.innerHTML =
        status +
        shown
          .map(
            (r, i) => `<div class="row ${i === sel ? "sel" : ""}" data-i="${i}">
              <span class="name">${escapeHtml(r.fullName)}</span>
              <span class="desc">${escapeHtml(r.description ?? "")}</span>
              ${opts.isLocal(repoName(r)) ? `<span class="tag">${t("newProject.local")}</span>` : ""}
              ${r.private ? `<span class="tag">${t("common.private")}</span>` : ""}</div>`,
          )
          .join("");
    };
    const choose = (repo: GithubRepo | null) => {
      chosen = repo;
      sel = -1;
      if (repo) name.value = repoName(repo);
      draw();
      name.focus();
    };
    opts.repos.then(
      (r) => {
        repos = r;
        draw();
      },
      (err) => {
        error = String(err);
        draw();
      },
    );
    name.addEventListener("input", () => {
      sel = -1;
      draw();
    });
    const done = (ok: boolean) => {
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(
        ok && name.value.trim()
          ? { parent: parent.value.trim(), name: name.value.trim(), git: git.checked, repo: chosen?.fullName ?? null }
          : null,
      );
    };
    const onKey = (e: KeyboardEvent) => {
      const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (move && shown.length && document.activeElement === name) {
        e.preventDefault();
        sel = sel + move < -1 ? shown.length - 1 : sel + move >= shown.length ? -1 : sel + move;
        draw();
      } else if (e.key === "Enter" && sel >= 0 && shown[sel]) {
        e.preventDefault();
        e.stopPropagation();
        choose(shown[sel]!);
      } else if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        done(e.key === "Enter");
      }
    };
    overlay.addEventListener("click", async (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("button");
      const row = (e.target as HTMLElement).closest<HTMLElement>(".gh-list [data-i]");
      if (row) choose(shown[Number(row.dataset.i)] ?? null);
      else if (btn?.dataset.k === "unpick") choose(null);
      else if (btn?.dataset.k === "pick") {
        const picked = await pickFolder();
        if (picked) parent.value = picked;
      } else if (btn?.dataset.v !== undefined) done(btn.dataset.v === "1");
      else if (e.target === overlay) done(false);
    });
    window.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    draw();
    name.focus();
  });
}
