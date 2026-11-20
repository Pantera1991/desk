// The files window's page: the side panel (tree, editor, page preview) in a
// window of its own. The main window drives it through `files:do` and gets
// `files:said` back (files-link.ts).

import { emitTo, listen } from "@tauri-apps/api/event";
import { api } from "./api";
import {
  applyFilesCommand,
  filesWindowKey,
  TO_FILES,
  TO_MAIN,
  type FilesCommand,
  type FilesReport,
  type FilesSettings,
} from "./files-link";
import { detectLanguage, isLanguage, setLanguage, t } from "./i18n";
import { actionFor, setCustomKeys } from "./keys";
import { Side } from "./side";
import { applyTheme, themeById } from "./themes";
import { applyUiScale, uiScale } from "./ui-scale";
import "./styles.css";

const say = (report: FilesReport): void => {
  void emitTo("main", TO_MAIN, report).catch(() => undefined);
};

async function start(root: HTMLElement): Promise<void> {
  const boot = await api.bootstrap();
  const l = boot.layout;
  let settings: FilesSettings = {
    browser: l.browser ?? "auto",
    linkClick: l.linkClick ?? "desk",
    fileEditor: l.fileEditor ?? "",
    language: l.language ?? "",
    theme: l.theme ?? "desk",
    uiScale: uiScale(l.uiScale),
    keys: l.keys ?? {},
    treeLeft: l.treeLeft ?? false,
  };
  let project: string | null = null;
  let side: Side | null = null;

  const apply = (s: FilesSettings): void => {
    settings = s;
    setLanguage(isLanguage(s.language) ? s.language : detectLanguage());
    setCustomKeys(s.keys);
    applyUiScale(s.uiScale);
    applyTheme(themeById(s.theme));
    side?.setTreeLeft(s.treeLeft);
    document.title = t("filesWin.title");
    document.documentElement.lang = isLanguage(s.language) ? s.language : detectLanguage();
  };
  apply(settings);

  let last = "";
  const report = (): void => {
    if (!side) return;
    const state = { op: "state", open: side.isOpen, filesShown: side.filesShown, shown: side.shown() } as const;
    const key = JSON.stringify(state);
    if (key === last) return;
    last = key;
    say(state);
  };

  side = new Side(
    report,
    {
      project: () => project,
      insert: (text) => say({ op: "insert", text }),
      terminal: (path) => say({ op: "terminal", path }),
      browser: () => settings.browser,
      linkClick: () => settings.linkClick,
      fileEditor: () => settings.fileEditor,
    },
    { detached: true, changed: report },
  );
  root.append(side.el);
  side.setTreeLeft(settings.treeLeft);
  side.relabel();
  void side.browserChanged();
  const panel = side;

  window.addEventListener(
    "keydown",
    (e) => {
      const key = filesWindowKey(actionFor(e));
      if (!key) return;
      e.preventDefault();
      e.stopPropagation();
      if (key === "showFiles") panel.showFiles();
      else if (key === "hide") panel.close();
      else
        void api
          .focusMainWindow()
          .catch(() => undefined)
          .then(() => say({ op: "find" }));
    },
    true,
  );
  // The window's own close button and the lock hide it from Rust: follow.
  document.addEventListener("visibilitychange", () => {
    // Minimize and restore fire this too: the flag follows both ways.
    panel.windowVisible(document.visibilityState === "visible");
    report();
  });

  await listen<FilesCommand>(TO_FILES, (e) => {
    applyFilesCommand(e.payload, {
      side: panel,
      setProject: (p) => {
        project = p;
      },
      setSettings: apply,
      say,
    });
    // Opens finish later: their own changes report again from the panel.
    report();
  });
  say({ op: "ready" });
}

const root = document.querySelector<HTMLElement>("#app")!;
start(root).catch((err) => {
  root.textContent = `desk: ${err}`;
});
