# Docker panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 🐳 chip in the top bar opens a PhpStorm-like tree of Docker servers (compose projects, containers, images, networks, volumes) with logs/shell tiles and image removal.

**Architecture:** Rust shells out to the `docker` CLI (`-H <url>`, `--format '{{json .}}'`, 3 s timeout, hosts read from `layout.json`), the popover polls every 5 s only while open. Logs/shell tiles are a new session agent `docker`: the layout stores `{host, target, kind}`, Rust builds and quotes the command for hosts listed in `dockerHosts` only.

**Tech Stack:** Tauri 2, Rust (std::process, serde_json), TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-11-18-docker-panel-design.md`

## Global Constraints

- Branch `feat/docker-panel`. Commit messages: Polish sentence subject like the repo, end with the `Co-Authored-By` line from the session.
- Run all commands from the repo root; Rust via `cargo --manifest-path src-tauri/Cargo.toml …`; Node 22 (`nvm use 22`).
- **Never contact the real servers (192.0.2.x) in tests or while building.** Manual checks only in the last task, with the user's go-ahead.
- No background polling: the popover asks only while open, every `5000` ms, never two requests at once.
- Every `docker` call: timeout `3` s, child killed on timeout; arguments via `Command::arg`, never `sh -c` with text from Options.
- Server URL must start with `tcp://` or `unix://`; host names unique; container/project/image names for tiles must match `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` (images for removal: that, plus `/ : @`).
- Only server-changing action: `docker image rm <repo:tag|id>`, never `--force`, always after `confirmBox`.
- Docker tiles never come back after a reboot (restore of a `docker` session tmux lost is dropped).
- UI text only via `t()` (`src/locales/pl.ts` defines keys, `en.ts` must have all); Rust messages via `tr!`.
- Old `layout.json` without `dockerHosts`/`docker` loads unchanged.
- Done means `pnpm check` passes.

## Review Focus

- `docker` CLI missing from PATH → popover says so once, no errors per host, no tile buttons. (Task 1 test `overview_without_docker_cli`, Task 3 test `renders missing cli`.)
- A server that hangs (firewall drop) → that host shows the timeout after ~3 s, other hosts render, the window stays responsive. (Task 1 test `run_times_out_and_kills`.)
- Image with several tags / `<none>` → removal message says "only a tag" / removes by id. (Task 3 tests `confirm text for shared image`, `none image removes by id`.)
- Labels containing commas or `=` in values (compose labels like `com.docker.compose.config-hash`) → project still parsed. (Task 1 test `parses_labels_with_odd_values`.)
- Layout edited by hand with a `docker` tile pointing at an unknown host or a name like `x; rm -rf ~` → open refused, no command run. (Task 2 tests.)

---

### Task 1: Rust `docker.rs`: layout fields, CLI runner, parsing, overview, image removal

**Files:**
- Create: `src-tauri/src/docker.rs` (+ `mod docker;` in `src-tauri/src/lib.rs`)
- Modify: `src-tauri/src/layout.rs` (fields + defaults), `src-tauri/src/lib.rs` (commands + `invoke_handler`)
- Test: `#[cfg(test)] mod tests` in `docker.rs`, layout round-trip test in `layout.rs`

**Interfaces:**
- Produces (Rust, all `#[serde(rename_all = "camelCase")]`, `Serialize, Deserialize, Clone, Debug, PartialEq`):
  - `pub struct DockerHost { pub name: String, pub url: String }`
  - `pub struct DockerTile { pub host: String, pub target: String, pub kind: DockerTileKind }`
  - `pub enum DockerTileKind { Logs, ProjectLogs, Shell }` (serde: `"logs" | "projectLogs" | "shell"`)
  - `Layout.docker_hosts: Vec<DockerHost>` (`dockerHosts`), `Layout.docker: BTreeMap<String, DockerTile>` (`docker`)
  - `pub struct Container { id, name, image, state, status: String, project: Option<String>, service: Option<String> }`
  - `pub struct Image { id, repository, tag, size, created: String }`
  - `pub struct Named { name, driver: String }`
  - `pub struct HostView { name, url: String, error: Option<String>, containers: Vec<Container>, images: Vec<Image>, networks: Vec<Named>, volumes: Vec<Named> }`
  - `pub struct Overview { cli: bool, compose: bool, hosts: Vec<HostView> }`
  - `pub fn parse_containers(stdout: &str) -> Vec<Container>`, `parse_images(&str) -> Vec<Image>`, `parse_named(&str) -> Vec<Named>`
  - `pub fn valid_url(url: &str) -> bool`, `pub fn valid_name(s: &str) -> bool`, `pub fn valid_image(s: &str) -> bool`
  - `fn run(program: &Path, args: &[&str], timeout: Duration) -> Result<String, String>`
  - `pub fn overview(hosts: &[DockerHost]) -> Overview`
  - `pub fn image_rm(hosts: &[DockerHost], host: &str, image: &str) -> Result<(), String>`
  - Tauri: `#[tauri::command(async)] fn docker_overview(app: State<App>) -> docker::Overview` (hosts from `layout::load(&app.layout_path)`), `#[tauri::command(async)] fn docker_image_rm(app: State<App>, host: String, image: String) -> Result<(), String>`

- [ ] **Step 1: Write failing tests** in `docker.rs`:
  - `parses_ps_lines`: two `{{json .}}` lines (fields `ID, Names, Image, State, Status, Labels`), `Labels` = `"com.docker.compose.project=web,com.docker.compose.service=app"` → `project == Some("web")`, `service == Some("app")`; a container without compose labels → both `None`; blank lines and a non-JSON line are skipped.
  - `parses_labels_with_odd_values`: `Labels` `"a=b=c,com.docker.compose.project=mm-back,x="` → project `mm-back`.
  - `parses_images_networks_volumes`: image line (`ID, Repository, Tag, Size, CreatedSince`) → `Image { tag: "latest", size: "412MB", created: "3 days ago", .. }`; `<none>` repo/tag kept as `"<none>"`; network/volume lines (`Name, Driver`).
  - `validates_inputs`: `valid_url("tcp://192.0.2.10:2375")`, `valid_url("unix:///var/run/docker.sock")` true; `"http://x"`, `"tcp://"`, `"tcp://a b"` false. `valid_name("web-app_1.x")` true; `""`, `"-x"`, `"a;b"`, `"a b"` false. `valid_image("mm/web:1.4")`, `valid_image("sha256:ab12")` true; `"x;y"` false.
  - `run_times_out_and_kills` (unix only): `run(Path::new("sleep"), &["5"], 300ms)` → `Err` containing the timeout text, returns in < 2 s.
  - `overview_without_docker_cli`: with a host list and `PATH` pointing at an empty temp dir (use the existing test pattern for `which`, or make `overview` take the program path via an inner `fn overview_with(docker: Option<PathBuf>, hosts)`) → `cli == false`, `hosts` empty-error-free.
  - `image_rm_rejects_unknown_host_and_bad_image`: `image_rm(&hosts, "nope", "x")` → `Err`; `image_rm(&hosts, "Docker1", "x;y")` → `Err`; neither runs a process.
  - In `layout.rs`: old JSON without the keys loads with empty `docker_hosts`/`docker`; a layout with both round-trips.

- [ ] **Step 2: Run** `cargo --manifest-path src-tauri/Cargo.toml test docker` — expect compile errors / FAIL.

- [ ] **Step 3: Implement.** Notes the tests don't pin:
  - `run`: `Command::new(program).args(args).stdin(null).stdout(piped).stderr(piped).spawn()`; poll `try_wait` every 20 ms until deadline, then `kill()` + `wait()`; non-zero exit → `Err(stderr trimmed)`. Timeout text via `tr!("serwer nie odpowiada (3 s)", "server did not answer (3 s)")`.
  - `overview`: `agents::which("docker")` (None → `cli: false`, no hosts work); `compose` = `docker compose version` succeeds (no `-H`, local only). Hosts in parallel with `std::thread::scope`, per host the four commands `ps -a`, `image ls`, `network ls`, `volume ls` with `["-H", url, …, "--format", "{{json .}}"]`; first error → `HostView.error`, lists empty. Invalid stored URL → error without running anything.
  - Register both commands in `tauri::generate_handler!` and add permission files the build autogenerates (commit them).

- [ ] **Step 4: Run** `cargo --manifest-path src-tauri/Cargo.toml test` and `cargo --manifest-path src-tauri/Cargo.toml clippy --all-targets -- -D warnings` — PASS.

- [ ] **Step 5: Commit** `git add src-tauri && git commit` — „Rust czyta serwery Dockera przez komendę docker”.

### Task 2: Rust: `docker` tiles in `open_session`

**Files:**
- Modify: `src-tauri/src/docker.rs` (tile command), `src-tauri/src/lib.rs:224` (`open_session` branch)
- Test: `docker.rs` tests

**Interfaces:**
- Consumes: `DockerHost`, `DockerTile`, `DockerTileKind`, `valid_name`, `valid_url` (Task 1).
- Produces: `pub const DOCKER_AGENT: &str = "docker";`, `pub fn tile_command(tile: &DockerTile, hosts: &[DockerHost]) -> Result<String, String>`. `open_session(agent = "docker")` takes `command = Some(<JSON of DockerTile>)`.

- [ ] **Step 1: Write failing tests:**
  - `builds_logs_command`: host `Docker1` → `tcp://192.0.2.10:2375`, target `web-app-1`, `Logs` → `docker -H 'tcp://192.0.2.10:2375' logs -f --tail 500 'web-app-1'` (each value through `tmux::shell_quote`).
  - `builds_project_logs_command`: `ProjectLogs`, target `web` → `docker -H '…' compose -p 'web' logs -f --tail 200`.
  - `builds_shell_command`: `Shell` → `docker -H '…' exec -it 'web-app-1' sh -c 'command -v bash >/dev/null && exec bash || exec sh'`.
  - `refuses_unknown_host`, `refuses_bad_target` (`"x; rm -rf ~"`), `refuses_invalid_stored_url` → `Err`.
- [ ] **Step 2: Run** `cargo --manifest-path src-tauri/Cargo.toml test docker::tests::builds` — FAIL.
- [ ] **Step 3: Implement** `tile_command`, then in `open_session` before the `RUN_AGENT` branch: `agent == DOCKER_AGENT` → if `restore` return `Err(tr!("kafelek Dockera nie wraca po restarcie", "a Docker tile does not come back after a restart"))`; parse `command` as `DockerTile` (bad JSON → `Err`), `tile_command(&tile, &layout.docker_hosts)?`. The early return for a live tmux session (lib.rs:200) stays first, so reopening desk reattaches. `run`'s `run_targets` check is untouched.
- [ ] **Step 4: Run** full `cargo test` + clippy — PASS.
- [ ] **Step 5: Commit** — „Kafelki z logami i powłoką kontenera; komendę składa Rust”.

### Task 3: TS types, API and pure view `docker-view.ts`

**Files:**
- Modify: `src/api.ts` (types, `Layout.dockerHosts`, `Layout.docker`, wrappers)
- Create: `src/docker-view.ts`, `src/docker-view.test.ts`
- Modify: `src/locales/pl.ts`, `src/locales/en.ts` (keys `docker.*`)

**Interfaces:**
- Consumes: Rust `Overview`, `docker_overview`, `docker_image_rm` (Task 1).
- Produces:
  - `api.dockerOverview(): Promise<DockerOverview>`, `api.dockerImageRm(host: string, image: string): Promise<void>`
  - TS mirrors: `DockerHost`, `DockerTile { host; target; kind: "logs" | "projectLogs" | "shell" }`, `DockerOverview`, `DockerHostView`, `DockerContainer`, `DockerImage`, `DockerNamed`.
  - `export type Health = "up" | "partial" | "down";` `export function health(containers: DockerContainer[]): Health` (all `running` → up; none running → down; else partial; `restarting`/`paused` count as partial).
  - `export function imageTarget(img: DockerImage): string` (`repo:tag`, or `id` when `<none>`).
  - `export function removeQuestion(host: string, img: DockerImage, all: DockerImage[]): string` (other tags with the same `id` → the "only a tag" text from the spec; else "Usunąć obraz … (size) z host?").
  - `export function renderDocker(o: DockerOverview | null, open: ReadonlySet<string>, busy: ReadonlySet<string>): string` — HTML with `data-open="<branch id>"` on toggles and `data-d="logs|projectLogs|shell|rm"` + `data-host`, `data-target` on buttons.

- [ ] **Step 1: Write failing tests** (`docker-view.test.ts`):
  - `health`: `[running, running]` → up; `[running, exited]` → partial; `[exited]` → down; `[restarting]` → partial.
  - `renders missing cli`: `{cli: false, …}` → contains `t("docker.noCli")`, no `data-d`.
  - `renders host error`: host with `error: "server did not answer (3 s)"` → error text shown, other host's projects still rendered.
  - `groups by compose project`: containers with `project` grouped, the rest under `t("docker.noCompose")`; project row has `data-d="projectLogs"` only when `compose: true`.
  - `shell disabled when not running`: exited container's shell button has `disabled`.
  - `confirm text for shared image`: two images same `id`, tags `latest`/`1.4` → `removeQuestion` mentions the other tag; single image → mentions size.
  - `none image removes by id`: `imageTarget({repository:"<none>", tag:"<none>", id:"ab12"})` → `"ab12"`.
  - `escapes names`: container named `<b>` is escaped.
- [ ] **Step 2: Run** `pnpm vitest run src/docker-view.test.ts` — FAIL.
- [ ] **Step 3: Implement** following `src/cpu-view.ts` style (pure string HTML, `escapeHtml`). Polish copy from the spec (statuses, "Kontenery bez compose", "Obrazy", "Sieci", "Woluminy", "Logi", "Powłoka", "Usuń", missing CLI); English translated.
- [ ] **Step 4: Run** `pnpm vitest run src/docker-view.test.ts` and `pnpm typecheck` — PASS.
- [ ] **Step 5: Commit** — „Widok drzewa Dockera”.

### Task 4: Popover, top bar chip, tiles and removal in the app

**Files:**
- Create: `src/docker-popover.ts`
- Modify: `src/topbar.ts` (`dockerHtml(show: boolean): string` with a whale line-icon SVG, `data-top="docker"`), `src/app.ts` (construct popover next to `CpuPopover` ~:197, toggle in the `[data-top]` handler ~:432, chip in `renderChrome` top bar ~:1774, tile opening, forget keys ~:920, `AUX_SIZE` list ~:1266, restore skip in `createTile` ~:571), `src/styles.css`
- Test: `src/docker-popover.test.ts` (timer behaviour with fake timers)

**Interfaces:**
- Consumes: Task 3 exports, `api.openSession` (`command` = `JSON.stringify(layout.docker[key])` for agent `docker`), `confirmBox` (`src/ui.ts:9`), `toast`.
- Produces: `export class DockerPopover { constructor(host: HTMLElement, ctx: DockerPopoverContext); toggle(): void; close(): void; get isOpen(): boolean }`, `export interface DockerPopoverContext { overview(): Promise<DockerOverview>; open(tile: DockerTile, title: string): void; removeImage(host: string, image: string): Promise<void> }`, `export const DOCKER_EVERY_MS = 5000`.

- [ ] **Step 1: Write failing tests** (vitest fake timers, stub ctx):
  - `asks only while open`: no `overview` call before `toggle()`; one immediately on open; next after 5000 ms; none after `close()` even when 20 s pass.
  - `never overlaps`: `overview` returning a pending promise → advancing 15 s still one call in flight.
  - `remove asks first`: clicking `data-d="rm"` with `confirmBox` stubbed `false` → `removeImage` not called; `true` → called with `(host, imageTarget)` and an immediate refresh.
- [ ] **Step 2: Run** `pnpm vitest run src/docker-popover.test.ts` — FAIL.
- [ ] **Step 3: Implement** like `src/cpu-popover.ts` (Esc, click outside, keep scroll, `aria-expanded`), branch open state in `localStorage` key `desk.dockerOpen` (try/catch). App wiring:
  - chip shown only when `layout.dockerHosts.length > 0`; popover closes when it becomes 0.
  - `open(tile, title)`: path = known project (`api.listProjects`) whose folder name equals `tile.target` or the container's compose project (case-insensitive), else `this.home` (the same fallback as `openTerminal` at `src/app.ts:2108`); key `keyOf({ path, agent: "docker", instance: nextInstance(taken, path, "docker") })`; set `layout.docker[key]`, `layout.titles[key]` (`logi: x` / `sh: x`), then `openTile(key)`.
  - `createTile(key, restore)`: `spec.agent === "docker" && restore && fresh` → delete `layout.docker[key]`, `layout.titles[key]`, persist, return `null` (no toast).
  - forget-keys block also deletes `layout.docker[key]`; `AUX_SIZE` list includes `"docker"`.
- [ ] **Step 4: Run** `pnpm vitest run` + `pnpm typecheck` + `pnpm lint` — PASS.
- [ ] **Step 5: Commit** — „Dymek Dockera w górnym pasku”.

### Task 5: Options → Docker

**Files:**
- Modify: `src/settings.ts` (`Group` gets `"docker"` after `"power"`, `GROUP_NAMES`, section, `SettingsContext.setDockerHosts`), `src/app.ts` (implement `setDockerHosts`: assign, persist at once, re-render chrome), locales
- Test: `src/settings.test.ts` or a new `src/docker-hosts.test.ts` for `export function checkHosts(hosts: DockerHost[]): string | null` (in `src/docker-view.ts`)

**Interfaces:**
- Consumes: `DockerHost` (Task 3).
- Produces: `SettingsContext.setDockerHosts: (hosts: DockerHost[]) => Promise<void>`, `checkHosts` (null = ok, else `t()` message).

- [ ] **Step 1: Write failing tests** for `checkHosts`: empty list ok; `http://x` → url error; duplicate names → duplicate error; empty name → name error; `tcp://192.0.2.10:2375` ok.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the section: one row per host (name input, URL input, ✕), "Dodaj serwer" button, "Zapisz" saves only when `checkHosts` returns null, else shows the message (pattern: the VPN field's error span in the `claude` group). Settings search picks up the new labels automatically (`words()`).
- [ ] **Step 4: Run** `pnpm check` — PASS (all of typecheck, lint, vitest, clippy, cargo test).
- [ ] **Step 5: Commit** — „Serwery Dockera w Opcjach”.

### Task 6: Live check (only with the user's go-ahead)

- [ ] **Step 1:** Ask the user before contacting any server. With a yes: `pnpm tauri dev`, add `Docker1` in Options, open the popover: same 9 projects / 13 containers as PhpStorm, `web` shown partial.
- [ ] **Step 2:** Measure CPU with the popover closed for 2 min (expect ~0%, no `docker` child processes: `pgrep -P <desk pid> docker` empty) and open (one burst per 5 s).
- [ ] **Step 3:** Open logs and shell tiles of a container the user names; close desk (not the computer) and reopen: tiles reattach.
- [ ] **Step 4:** Image removal only on an image the user names.
- [ ] **Step 5:** Push branch to `fork`, open PR to `knehrybecki/desk` with the spec link and what was checked live.
