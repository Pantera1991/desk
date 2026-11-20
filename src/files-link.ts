// The files window and the main window talk through two events. Both pages
// import this file, so the two sides cannot drift apart.

import type { Action } from "./keys";

/** What the files window needs from Options (the main window owns them). */
export interface FilesSettings {
  browser: string;
  linkClick: string;
  fileEditor: string;
  language: string;
  theme: string;
  uiScale: number;
  keys: Record<string, string>;
  /** The file tree on the left of the panel (Layout.treeLeft). */
  treeLeft: boolean;
}

/** main -> files. */
export type FilesCommand =
  | { op: "showFiles" }
  /** Show the panel; never hides it (the window may already have been shown by the time this arrives). */
  | { op: "reveal" }
  | { op: "browse" }
  | { op: "open"; link: string; project?: string }
  | { op: "openAt"; file: string; line: number; project: string }
  | { op: "project"; project: string | null }
  | { op: "settings"; settings: FilesSettings }
  /** The mode is being switched off: save the edit (as ✎ does), then answer `released` with this `id`. */
  | { op: "release"; id: number }
  /** A main page that came after the window (reloaded): answer `ready` again. */
  | { op: "hello" };

/** files -> main. */
export type FilesReport =
  | { op: "ready" }
  | { op: "state"; open: boolean; filesShown: boolean; shown: string | null }
  | { op: "insert"; text: string }
  | { op: "terminal"; path: string }
  | { op: "find" }
  /** `ok` false: the edit did not save, the window must stay. `shown`: after the save. `id`: the `release` answered. */
  | { op: "released"; id: number; ok: boolean; shown: string | null };

export const TO_FILES = "files:do";
export const TO_MAIN = "files:said";

/** The files window's key: what desk shortcuts do there (null: nothing). */
export function filesWindowKey(action: Action | null): "showFiles" | "hide" | "find" | null {
  switch (action?.type) {
    case "files":
      return "showFiles";
    case "preview":
      return "hide";
    case "findInFiles":
      return "find";
    default:
      return null;
  }
}

/** The part of the panel a command can reach. */
export interface SideLike {
  relabel(): void;
  open(link: string, project?: string): Promise<void>;
  openAt(file: string, line: number, project?: string): Promise<void>;
  showFiles(): void;
  reveal(): void;
  browse(): void;
  projectChanged(): void;
  browserChanged(): Promise<void>;
  /** Save and leave the editor; false when the save failed. `reload`: show the page again, reloaded. */
  stopEditing(reload?: boolean): Promise<boolean>;
  shown(): string | null;
}

export interface FilesDeps {
  side: SideLike;
  setProject(project: string | null): void;
  /** Keeps the copy and applies language, theme, scale and keys. */
  setSettings(settings: FilesSettings): void;
  /** Answer the main window. */
  say(report: FilesReport): void;
}

/** One command from the main window. Errors of opening a page are shown by the panel itself. */
export function applyFilesCommand(cmd: FilesCommand, deps: FilesDeps): void {
  const { side } = deps;
  switch (cmd.op) {
    case "showFiles":
      return side.showFiles();
    case "reveal":
      return side.reveal();
    case "browse":
      return side.browse();
    case "open":
      void side.open(cmd.link, cmd.project).catch(() => undefined);
      return;
    case "openAt":
      void side.openAt(cmd.file, cmd.line, cmd.project).catch(() => undefined);
      return;
    case "project":
      deps.setProject(cmd.project);
      return side.projectChanged();
    case "settings":
      // Language first: relabel reads it.
      deps.setSettings(cmd.settings);
      side.relabel();
      void side.browserChanged().catch(() => undefined);
      return;
    case "release":
      // No reload: the window goes right after a good save.
      void side
        .stopEditing(false)
        .catch(() => false)
        .then((ok) => deps.say({ op: "released", id: cmd.id, ok, shown: side.shown() }));
      return;
    case "hello":
      return deps.say({ op: "ready" });
  }
}
