# Upload Panel ("Wysyłka") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A side panel that sends one file from the active project to `user@server:~/` with rsync over SSH (keys only), running in a terminal tile.

**Architecture:** A copy of the Docker panel's shape. `layout.json` keeps only `{host, user, file}` per tile. Rust looks up the server in Options, checks every part, builds and quotes the command, and starts the session only from a confirmed click. The panel reuses `FileTree` from the files panel. Closing a tile while rsync still runs asks first. Rust checks this on demand by looking for an `rsync` process under the session.

**Tech Stack:** TypeScript (vanilla DOM, vitest), Rust/Tauri 2 (tmux or native PTY backends), rsync + OpenSSH.

**Spec:** `docs/superpowers/specs/2026-11-19-upload-panel-design.md`

## Global Constraints

- Branch `feat/upload-panel`, worktree `../desk-upload` (based on `feat/docker-panel`).
- Run every command from the main working dir (`desk-main`) with relative paths. Never `cd`. Use `git -C ../desk-upload`, `pnpm -C ../desk-upload`, `cargo … --manifest-path ../desk-upload/src-tauri/Cargo.toml`.
- Node: `source ~/.nvm/nvm.sh && nvm use 26` before any `pnpm`.
- Commit messages are in Polish, like the rest of history. End each with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- UI text goes in `src/locales/pl.ts` and `src/locales/en.ts`; Rust messages use `tr!(pl, en)`.
- New CSS sizes use `calc(<N>px * var(--ui-scale, 1))`, like the Docker panel.
- Agent id is `"upload"`. Tile command: `rsync -z --partial --progress -e '<ssh…>' -- '<abs file>' '<user>@<host>:'`.
- ssh options: `-i <key> -o IdentitiesOnly=yes` only when a key is set, then always `-o PasswordAuthentication=no -o KbdInteractiveAuthentication=no`. Never `StrictHostKeyChecking` and never `BatchMode`: the human answers the host-key question in the tile.
- Never `--delete`. Nothing starts without a confirmed click, never after a restart, "Przywróć" or ⌘⇧T.
- Windows: no panel (the topbar button and shortcut are hidden). `/etc/hosts` suggestions are empty there.

## Review Focus

1. **A file name with spaces, quotes or `$`** (`dump 2024 'old'.sql`) must reach rsync as one argument. Covered by a test in Task 1.
2. **A symlink in the project pointing outside it** (`dumps/latest.sql -> /etc/shadow`) must be refused, not sent. Covered by a test in Task 1.
3. **The project's home folder contains a space** (`/home/jan kowalski/.ssh/key`): an expanded key path with a space would break rsync's own `-e` splitting, so it is refused with a clear message. Covered by a test in Task 1.
4. **Closing a tile whose rsync is waiting at the host-key `yes/no` prompt** still counts as "running", so it asks. ssh is a child of rsync and rsync is alive. Covered by a test in Task 2 (a tree with rsync → ssh).
5. **The same server name with two users** (`example-dev` as `deploy` and as `root`) are two separate rows, and a tile must match both host and user. Covered by tests in Tasks 1 and 4.

---

### Task 1: Rust `upload.rs` – types, checks, command

**Files:**
- Create: `../desk-upload/src-tauri/src/upload.rs` (with `mod tests`)
- Modify: `../desk-upload/src-tauri/src/lib.rs` (`mod upload;`)

**Interfaces:**
- Produces:
  - `#[serde(rename_all = "camelCase")] pub struct UploadHost { pub host: String, pub user: String, #[serde(default)] pub key: String }` (Clone, Debug, PartialEq, Serialize, Deserialize, Default).
  - `pub struct UploadTile { pub host: String, pub user: String, pub file: String }` (same derives).
  - `pub const UPLOAD_AGENT: &str = "upload";`
  - `pub fn valid_host(s: &str) -> bool`: ASCII alphanumerics plus `.-_`, 1–253 chars, first char alphanumeric.
  - `pub fn valid_user(s: &str) -> bool`: ASCII alphanumerics plus `._-`, 1–32 chars, does not start with `-`.
  - `pub fn valid_key(s: &str) -> bool`: empty is OK; otherwise ASCII alphanumerics plus `/._-~`, does not start with `-`.
  - `pub fn expand_key(key: &str, home: &Path) -> PathBuf`: `~/x` becomes `home/x`, anything else stays as it is.
  - `pub fn resolve_file(dir: &Path, rel: &str) -> Result<PathBuf, String>`: canonicalises `dir` and `dir.join(rel)`. Errors when the result is not under the canonical `dir`, or is not a regular file.
  - `pub fn may_start(start: bool) -> Result<(), String>`: `false` gives `tr!("Wyślij ponownie z panelu Wysyłka.", "Send again from the Upload panel.")`.
  - `pub fn tile_command(tile: &UploadTile, hosts: &[UploadHost], dir: &Path, home: &Path) -> Result<String, String>`
  - `pub fn parse_etc_hosts(text: &str) -> Vec<String>`
  - `#[derive(Serialize)] pub struct UploadTools { pub rsync: bool, pub ssh: bool }` and `pub fn tools() -> UploadTools` (`crate::agents::which`).

- [ ] **Step 1: Write the failing tests** in `upload.rs` `mod tests` (temp dirs via `tempfile`, as in `docker.rs`):
  - `builds_command_with_key`: host `{host:"example-dev", user:"deploy", key:"~/.ssh/server.key"}`, home `/home/u`, file `dumps/a.sql` (created in the temp project). The command equals
    `rsync -z --partial --progress -e 'ssh -i /home/u/.ssh/server.key -o IdentitiesOnly=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no' -- '<canon>/dumps/a.sql' 'deploy@example-dev:'`
  - `builds_command_without_key`: `-e 'ssh -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no'`.
  - `quotes_odd_file_names`: the file is `dump 2024 'old'$x.sql`. The command contains `shell_quote(<canonical path>)` exactly once, and the result still begins with `rsync -z`.
  - `refuses_unknown_host_or_user`: a tile with the right host but another user gives Err. So does an unknown host.
  - `refuses_file_outside_project`: `../x`, an absolute `/etc/hosts`, and a symlink `dumps/l -> <outside file>` (`#[cfg(unix)]`) all give Err.
  - `refuses_folder_and_missing_file`: both give Err.
  - `refuses_bad_parts`: a host `a;b`, a user `-oProxy`, a key `~/k'ey`, and a key that expands under home `/home/jan kowalski` all give Err.
  - `upload_never_starts_unconfirmed`: `may_start(false)` is Err and `may_start(true)` is Ok.
  - `parses_etc_hosts`: the input
    `"127.0.0.1 localhost\n::1 ip6-localhost ip6-loopback\n# c\n10.0.0.5 example-dev example-dev\n10.0.0.6 example-prod # x\n127.0.0.1 app.loc app.local kubernetes.docker.internal\n"`
    gives `["example-dev", "example-prod"]`. Order follows the file and duplicates are dropped. `localhost`, `ip6-*` and names ending in `.loc`, `.local` or `.internal` are skipped, and so is anything after `#`.

- [ ] **Step 2: Run them and see them fail**
  Run `cargo test --manifest-path ../desk-upload/src-tauri/Cargo.toml upload::` and expect a compile error or FAIL.

- [ ] **Step 3: Implement** the interfaces above. `tile_command`:
  1. find the host matching both host and user;
  2. run `valid_host`, `valid_user` and `valid_key` on the stored row;
  3. expand the key and check the expanded path with `valid_key`, which refuses spaces;
  4. call `resolve_file`;
  5. build the ssh string and quote the `-e` value, the file and the target with `crate::tmux::shell_quote`.

  `suggestions()` reads `/etc/hosts` (`#[cfg(windows)]` returns an empty vec) and calls `parse_etc_hosts`.

- [ ] **Step 4: Run the tests and see them pass**, with the same command as Step 2.

- [ ] **Step 5: Commit** with the message `Wysyłka: komenda rsync składana i sprawdzana w Rust`.

### Task 2: Rust – is rsync still running in a session

**Files:**
- Modify: `../desk-upload/src-tauri/src/proc.rs` (and its tests)
- Modify: `../desk-upload/src-tauri/src/tmux.rs`, `../desk-upload/src-tauri/src/backend.rs`

**Interfaces:**
- Produces:
  - `pub fn tree_has(table: &str, roots: &[u32], name: &str) -> bool` in `proc.rs`. `table` is the output of `ps -A -o pid=,ppid=,comm=`, one `pid ppid comm` per line. It returns true when a process in the trees under `roots` (the roots included) has the base name of `comm` equal to `name`. macOS prints full paths such as `/usr/bin/rsync`.
  - `pub fn process_table() -> String`: `/bin/ps -A -o pid=,ppid=,comm=` through `proc::run`, 3 s timeout. Empty on error or on Windows.
  - `Tmux::session_pane_pids(&self, slug: &str) -> Vec<u32>`, which reuses the `session_name\tpane_pid` listing at tmux.rs:163.
  - `Backend::roots_of(&self, slug: &str) -> Vec<u32>`: tmux uses the method above; native uses `Native::roots()` filtered by `info.slug`.
  - `Backend::runs(&self, slug: &str, name: &str) -> bool`, which is `proc::tree_has(&proc::process_table(), &self.roots_of(slug), name)`.

- [ ] **Step 1: Write failing tests** in `proc.rs`:
  - `tree_has_finds_child_and_grandchild`: table `"10 1 bash\n11 10 rsync\n12 11 ssh\n20 1 rsync\n"`.
    - roots `[10]` with `rsync` is true;
    - roots `[10]` with `ssh` is true;
    - roots `[30]` with `rsync` is false.
  - `tree_has_ignores_other_trees`: roots `[10]` and the table `"10 1 bash\n20 1 rsync\n"` with `rsync` is false.
  - `tree_has_matches_full_path`: `"10 1 /usr/bin/rsync\n"` with roots `[10]` and `rsync` is true.
- [ ] **Step 2: Run** `cargo test --manifest-path ../desk-upload/src-tauri/Cargo.toml proc::` and expect FAIL.
- [ ] **Step 3: Implement** the interfaces.
- [ ] **Step 4: Run** the same command and expect PASS.
- [ ] **Step 5: Commit** with the message `Sprawdzanie, czy w sesji trwa proces (rsync)`.

### Task 3: Rust wiring – layout, `open_session`, commands

**Files:**
- Modify: `../desk-upload/src-tauri/src/layout.rs` (fields, defaults, test)
- Modify: `../desk-upload/src-tauri/src/lib.rs` (`open_session`, new commands, `generate_handler!`)
- Modify: `../desk-upload/src-tauri/build.rs` (command list), `../desk-upload/src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces:
  - Layout: `upload_hosts: Vec<UploadHost>` and `uploads: BTreeMap<String, UploadTile>`, both empty by default. In JSON they are `uploadHosts` and `uploads`.
  - Tauri commands:
    - `upload_tools() -> UploadTools`;
    - `upload_suggestions() -> Vec<String>`;
    - `upload_file_size(path: String, file: String) -> Result<u64, String>` (`resolve_file`, then `metadata().len()`);
    - `upload_running(app, slug: String) -> bool` (`app.sessions.runs(&slug, "rsync")`).
  - Permissions: `allow-upload-tools`, `allow-upload-suggestions`, `allow-upload-file-size`, `allow-upload-running`.

- [ ] **Step 1: Failing test** `upload_fields_default_empty_and_round_trip` in `layout.rs`, modeled on `docker_fields_default_empty_and_round_trip`:
  - an old file `{"version":1}` loads with empty `upload_hosts` and empty `uploads`;
  - a layout with one host `{example-dev, deploy, ~/.ssh/server.key}` and one tile survives save and load.
- [ ] **Step 2: Run** `cargo test --manifest-path ../desk-upload/src-tauri/Cargo.toml layout::` and expect FAIL.
- [ ] **Step 3: Implement** the fields. In `open_session`, add a branch after the Docker one:
  - `agent == upload::UPLOAD_AGENT` with `restore` gives `Err(tr!("kafelek wysyłki nie wraca po restarcie", "an upload tile does not come back after a restart"))`;
  - otherwise parse `UploadTile` from `command`, then `upload::may_start(start_deploy)?`, then `upload::tile_command(&tile, &layout.upload_hosts, dir, &home)?`.

  Also widen the `start_deploy` doc comment to "a start confirmed by a click: a deploy or an upload". Register the four commands in `generate_handler!`, in `build.rs` and in `capabilities/default.json`.
- [ ] **Step 4: Run** `pnpm -C ../desk-upload check` (with nvm) and expect clippy clean and every test passing. The Rust half of `check` runs `cd src-tauri` inside the npm script; that is the project's own script, not our shell.
- [ ] **Step 5: Commit** with the message `Wysyłka: pola w layout.json i komendy Tauri`.

### Task 4: TS – API and pure functions (`upload-view.ts`)

**Files:**
- Modify: `../desk-upload/src/api.ts`
- Create: `../desk-upload/src/upload-view.ts`, `../desk-upload/src/upload-view.test.ts`
- Modify: `../desk-upload/src/locales/pl.ts`, `../desk-upload/src/locales/en.ts`

**Interfaces:**
- Consumes: the Tauri commands from Task 3.
- Produces:
  - `api.ts`:
    - `export interface UploadHost { host: string; user: string; key: string }`
    - `export interface UploadTile { host: string; user: string; file: string }`
    - `Layout.uploadHosts: UploadHost[]` and `Layout.uploads: Record<string, UploadTile>`
    - `api.uploadTools(): Promise<{ rsync: boolean; ssh: boolean }>`
    - `api.uploadSuggestions(): Promise<string[]>`
    - `api.uploadFileSize(path: string, file: string): Promise<number>`
    - `api.uploadRunning(slug: string): Promise<boolean>`
  - `upload-view.ts`:
    - `HOST_RULE`, `USER_RULE`, `KEY_RULE`: regexes that mirror Task 1.
    - `hostLabel(h: {host: string; user: string}): string`, which gives `"deploy@example-dev"`.
    - `checkUploadHosts(hosts: UploadHost[]): string | null`. Messages, in order:
      - `settings.uploadHostEmpty`;
      - `settings.uploadUserEmpty` `{host}`;
      - `settings.uploadHostBad` `{host}`;
      - `settings.uploadUserBad` `{user}`;
      - `settings.uploadKeyBad` `{key}`;
      - `settings.uploadDup` `{target}`, for the same `user@host` case-insensitively.
    - `uploadDraftRows(draft: UploadHost[] | null, saved: UploadHost[]): UploadHost[]`
    - `uploadDraftSet(rows, i, field: "host" | "user" | "key", value)`
    - `uploadDraftAdd(rows)`
    - `uploadDraftRemove(rows, i)`
    - All four take pure copies, like the Docker draft helpers.
    - `formatSize(bytes: number): string`, base 1024. `512` gives `"512 B"`, `1536` gives `"1.5 KB"`, `1288490189` gives `"1.2 GB"`.
    - `uploadQuestion(file: string, size: number, h: UploadHost): { message: string; prod: boolean }`. `prod` is `/prod/i.test(h.host)`.
    - `blockedUpload(tile: UploadTile | undefined, running: boolean, confirmed: boolean): boolean`, which is `tile !== undefined && !running && !confirmed`.
    - `findUploadSession(uploads: Record<string, UploadTile>, keys: readonly string[], t: UploadTile): string | null`, matching on host, user and file.
    - `barHtml(s: { project: string | null; tools: { rsync: boolean; ssh: boolean } | null; hosts: UploadHost[]; host: string | null; file: string | null }): string`. It returns the panel's top (server `<select>`) and bottom (selected file + "Wyślij") as HTML. The tree is mounted separately. Rules:
      - no project gives `upload.noProject`, with no select and no button;
      - tools present but `rsync` or `ssh` false gives `upload.noTools`, with no button;
      - `file === null` gives `upload.pickFile`, with no button;
      - otherwise the file and a `<button data-u="send">`.
  - Locale keys (pl / en):
    - `upload.title`: Wysyłka / Upload
    - `upload.send`: Wyślij / Send
    - `upload.noProject`: Otwórz kartę projektu / Open a project tab
    - `upload.noTools`: Brak rsync albo ssh / rsync or ssh is missing
    - `upload.pickFile`: Wybierz plik / Pick a file
    - `upload.confirm`: Wysłać {file} ({size}) do {target}:~/? Plik o tej samej nazwie na serwerze zostanie nadpisany. / Send {file} ({size}) to {target}:~/? A file with the same name on the server will be overwritten.
    - `upload.prodWarning`: To serwer produkcyjny. / This is a production server.
    - `upload.tile`: wyślij: {file} → {host} / send: {file} → {host}
    - `upload.sendAgain`: Wyślij ponownie z panelu Wysyłka. / Send again from the Upload panel.
    - `upload.closeRunning`: Trwa wysyłanie {file} do {host}. Przerwać i zamknąć? / {file} is still being sent to {host}. Stop and close?
    - `upload.stopClose`: Przerwij i zamknij / Stop and close
    - `upload.continue`: Kontynuuj / Continue
    - `upload.quitRunning`: Trwa {n} wysyłek. Przerwać i wyjść? / {n} uploads are running. Stop them and quit?
    - `upload.stopQuit`: Przerwij i wyjdź / Stop and quit
    - `upload.back`: Wróć / Back
    - `settings.upload`: Wysyłka / Upload
    - `settings.uploadHost`: serwer / server
    - `settings.uploadUser`: użytkownik / user
    - `settings.uploadKey`: klucz (opcjonalnie) / key (optional)
    - plus the six check messages above.

- [ ] **Step 1: Failing tests** in `upload-view.test.ts`:
  - `checkUploadHosts`:
    - `[]` gives null;
    - an empty host gives `uploadHostEmpty`;
    - `a;b` gives `uploadHostBad`;
    - user `-x` gives `uploadUserBad`;
    - key `~/k'ey` gives `uploadKeyBad`;
    - `deploy@EXAMPLE-dev` twice gives `uploadDup`;
    - the same host with users `deploy` and `root` gives null (Review Focus 5).
  - Drafts: `uploadDraftSet`, `uploadDraftAdd` and `uploadDraftRemove` never change their input.
  - `formatSize`: the three values above.
  - `uploadQuestion`: host `example-prod` gives `prod: true` and `example-dev` gives `prod: false`. The message contains `deploy@example-dev`.
  - `blockedUpload`:
    - `(tile, false, false)` is true;
    - `(tile, true, false)` is false;
    - `(tile, false, true)` is false;
    - `(undefined, false, false)` is false.
  - `findUploadSession`: matches on all three fields, and returns null when only the user differs.
  - `barHtml`: one case for each of the four states, checking whether `data-u="send"` is present. Server names are HTML-escaped.
- [ ] **Step 2: Run** `pnpm -C ../desk-upload exec vitest run src/upload-view.test.ts` and expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command and expect PASS, then `pnpm -C ../desk-upload typecheck`.
- [ ] **Step 5: Commit** with the message `Wysyłka: typy, sprawdzanie serwerów i widok panelu`.

### Task 5: Options → Wysyłka

**Files:**
- Modify: `../desk-upload/src/settings.ts` (Group `"upload"`, label, rows, bind, `SettingsContext.setUploadHosts`)
- Modify: `../desk-upload/src/app.ts` (`setUploadHosts` in the settings context, next to `setDockerHosts` at app.ts:~411)
- Modify: `../desk-upload/src/styles.css`

**Interfaces:**
- Consumes: from Task 4, the drafts, `checkUploadHosts`, `api.uploadSuggestions` and the locale keys.
- Produces: `SettingsContext.setUploadHosts(hosts: UploadHost[]): void`.

- [ ] **Step 1: Failing test.** The repo has no settings render tests; the logic is covered by Task 4. Add an `it` in `upload-view.test.ts`: `uploadDraftRows(null, saved)` copies `saved`, and changing the copy leaves `saved` unchanged.
- [ ] **Step 2: Run** and expect PASS, since it is pure.
- [ ] **Step 3: Implement**, modeled on `dockerDraft`, `dockerRowHtml` and `bindDocker` (settings.ts:165-210, 943-953, 1155):
  - one row per server: `host` with `list="upload-hosts"`, `user`, `key`, and ✕;
  - one `<datalist id="upload-hosts">`, filled from `api.uploadSuggestions()` the first time the group renders;
  - Add and Save buttons, with Save calling `checkUploadHosts` first;
  - the error line;
  - hide the group on `PLATFORM === "windows"`.
- [ ] **Step 4: Run** `pnpm -C ../desk-upload typecheck`, `lint` and `test`, and expect PASS.
- [ ] **Step 5: Commit** with the message `Opcje → Wysyłka: serwery, użytkownicy i klucze`.

### Task 6: The panel, topbar button and shortcut

**Files:**
- Create: `../desk-upload/src/upload-panel.ts`, `../desk-upload/src/upload-panel.test.ts`
- Modify: `../desk-upload/src/ui.ts` (`ChoiceOptions`)
- Modify: `../desk-upload/src/keys.ts`, `../desk-upload/src/keys.test.ts`
- Modify: `../desk-upload/src/topbar.ts`
- Modify: `../desk-upload/src/app.ts` (build the panel, put it in the DOM between `dockerPanel.el` and `side.el` at app.ts:258, topbar click at ~465, action at ~2245, hide at ~1905, project change where `side.projectChanged` is called)
- Modify: `../desk-upload/src/styles.css`

**Interfaces:**
- Consumes: Task 4 (`barHtml`, `uploadQuestion`, `formatSize`, `hostLabel`, api) and `FileTree` (treeview.ts).
- Produces:
  - `export interface UploadContext { project(): string | null; hosts(): UploadHost[]; send(tile: UploadTile, title: string): Promise<void>; onLayout(): void }`
  - `export class UploadPanel { readonly el: HTMLElement; get isOpen(): boolean; toggle(): void; open(): void; close(): void; projectChanged(): void; hostsChanged(): void }`
  - `ChoiceOptions.cancelLabel?: string`, which replaces `common.cancel`.
  - `ChoiceOptions.warning?: string`, shown as `<p class="choice-warning">` (red) under the message.
  - `keys.ts`: `{ id: "upload", group: "window", action: { type: "upload" }, mac: ["Super+Shift+KeyU"], other: ["Control+Shift+KeyU"] }`. Before adding it, grep that both are free and not in the reserved maps.
  - `topbar.ts`: `uploadHtml(show: boolean, pressed: boolean): string` with `data-top="upload"` and the icon `⇪`.

- [ ] **Step 1: Failing tests** in `upload-panel.test.ts`, modeled on `docker-panel.test.ts`'s fake `api` and context:
  - `open loads tools once and the tree of ctx.project()`;
  - `send asks with size and target, and opens nothing on cancel`;
  - `send on a prod host passes a warning`;
  - `send confirmed calls ctx.send with {host,user,file} and title "wyślij: dumps/a.sql → example-dev"`;
  - `picking a folder clears the selected file`;
  - `the chosen server is remembered (desk.uploadHost) and falls back to the first when it was removed`;
  - `hostsChanged with none left closes the panel`.

  In `keys.test.ts`: `upload` maps to `Super+Shift+KeyU` on mac and `Control+Shift+KeyU` elsewhere.
- [ ] **Step 2: Run** `pnpm -C ../desk-upload exec vitest run src/upload-panel.test.ts src/keys.test.ts` and expect FAIL.
- [ ] **Step 3: Implement.**
  - The panel is `aside.side.dock.upload`, reusing the `.dock-*` styles.
  - Width lives in `desk.uploadWidth` (default 340, min 260); the open state lives in `desk.uploadPanel`.
  - The splitter follows docker-panel.ts:347.
  - `FileTree` events: `file(rel)` selects the file, `folder` clears the selection, `edit(rel)` selects the file.
  - The send click runs `api.uploadFileSize`, then `uploadQuestion`, then `choiceBox(message, t("upload.send"), { warning: prod ? t("upload.prodWarning") : undefined })`, then `ctx.send`.
  - The panel and topbar button show only when `uploadHosts.length > 0` and `PLATFORM !== "windows"`.
- [ ] **Step 4: Run** the same command and expect PASS, then the full `pnpm -C ../desk-upload test`.
- [ ] **Step 5: Commit** with the message `Panel Wysyłka: drzewo projektu, serwer i Wyślij z potwierdzeniem`.

### Task 7: Upload tiles – start, restore, close, quit

**Files:**
- Modify: `../desk-upload/src/app.ts`
- Test: `../desk-upload/src/upload-view.test.ts` (pure parts)

**Interfaces:**
- Consumes: `blockedUpload` and `findUploadSession` (Task 4), `api.uploadRunning` (Task 3), `ChoiceOptions.cancelLabel` (Task 6).
- Produces: `App.openUploadTile(tile: UploadTile, title: string): Promise<void>`, wired as `UploadContext.send`.

- [ ] **Step 1: Failing test** in `upload-view.test.ts`: `quitPlan(running: string[])` returns `null` for `[]`; for `["a"]` it returns `{ message: t("upload.quitRunning", { n: 1 }), okLabel: t("upload.stopQuit") }`. Put `quitPlan` in `upload-view.ts`.
- [ ] **Step 2: Run** it and expect FAIL.
- [ ] **Step 3: Implement** in `app.ts`:
  - Rename `confirmedDeploys` to `confirmedStarts` (it now covers deploys and uploads) and update its comment.
  - `openUploadTile`, modeled on `openDockerTile`/`openDockerTileNow` (app.ts:785-813):
    - deduplicate through `findUploadSession`, which focuses the existing tile;
    - the key is `keyOf({ path: project, agent: "upload", instance: nextInstance(...) })`;
    - set `layout.uploads[key]` and `layout.titles[key]`;
    - add the key to `confirmedStarts`;
    - call `openTile`;
    - run `forgetKey` when the tile did not open.
  - `createTile`:
    - `restore && fresh` drops the tile for `"upload"` too;
    - for `"upload"`, `blockedUpload(this.layout.uploads[key], !fresh, confirmed)` gives forget, clear `closed` and toast `upload.sendAgain`;
    - the command is `JSON.stringify(this.layout.uploads[key])`;
    - the catch branch mirrors Docker's.
  - Startup loop (app.ts:581): `"upload"` keys that did not open are removed like `"docker"` ones.
  - `forgetKey` and the `forgotten` list in `endSession` also cover `layout.uploads`. Tile size: add `"upload"` to the `AUX_SIZE` list (app.ts:1396).
  - `closeByUser(key)`: when the agent is `"upload"`, call `void this.closeUpload(key)` instead.
    - `closeUpload` runs `api.uploadRunning(slug).catch(() => false)`.
    - If rsync is not running, call `endSession(key)` with no question.
    - If it is running, call `choiceBox(t("upload.closeRunning", {file, host}), t("upload.stopClose"), { cancelLabel: t("upload.continue") })`. On `"ok"`, call `endSession(key)`; otherwise do nothing.
  - `quit()`: before the existing dialog, list the upload sessions (`agent === "upload"`) for which `api.uploadRunning` is true.
    - If `quitPlan(...)` is not null, show `choiceBox(plan.message, plan.okLabel, { cancelLabel: t("upload.back"), details: <"file → host" per upload> })`.
    - On anything other than `"ok"`, return.
    - On `"ok"`, kill those sessions and continue with the existing quit dialog, which no longer lists them.
- [ ] **Step 4: Run** `pnpm -C ../desk-upload check` and expect it all green.
- [ ] **Step 5: Commit** with the message `Kafelek wysyłki: start tylko z kliknięcia, pytanie przy zamykaniu i wyjściu`.

### Task 8: Build and manual check on Linux

- [ ] **Step 1:** Run `pnpm -C ../desk-upload tauri build --bundles deb --config src-tauri/tauri.deb.conf.json`. Expect `desk_*.deb` under `../desk-upload/src-tauri/target/release/bundle/deb/`.
- [ ] **Step 2:** Hand the owner `sudo apt install --reinstall ./<path to deb>` and the checklist from the spec's "Ręcznie na Linuksie":
  - a dump to `example-dev`;
  - Ctrl+C, then send again so `--partial` finishes it;
  - the first connection's yes/no prompt;
  - a wrong key gives an error with no password prompt;
  - ✕ during a send: "Kontynuuj", then "Przerwij", and rsync really stops (`pgrep rsync`);
  - quitting desk during a send asks first.
- [ ] **Step 3:** Record the results in the PR description. Open the PR (English) against `main`, stacked on #73.
