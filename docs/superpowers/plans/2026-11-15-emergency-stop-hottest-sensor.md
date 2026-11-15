# Emergency Stop on the Hottest Sensor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The emergency stop compares its limit with the hottest of the SMC CPU core sensors (Stats' keys) and desk's own sensor, trips at once on macOS's critical thermal state, and says what it watches; the chip, slowing and fans stay as they are.

**Architecture:** A new pure module `core_temps.rs` maps the chip's brand string to Stats' CPU core key list and reads the hottest of them through the existing `fan_control::Smc` trait. The sensor thread hands `Guard::tick` a `Reading` (desk's sensor, cores, pressure, critical) instead of `(celsius, pressure)`. `Halt` gets the critical state, a cause and a typed refusal. `Status` carries `hottest`, `cores`, `haltedBy` and `sees`; the TypeScript side shows them in the tooltip, the toast and Options.

**Tech Stack:** Rust (Tauri 2, IOKit SMC through `smc.rs`, objc2 `NSProcessInfo`), TypeScript (vanilla DOM, vitest).

**Spec:** `docs/superpowers/specs/2026-11-15-emergency-stop-hottest-sensor-design.md`. It builds on PR 52 (the emergency stop, merged into `upstream/main`).

## Global Constraints

- **Base branch:** `fix/emergency-stop-hottest-sensor`, created from `upstream/main` (the local `main` and `origin/main` are stale).
- **Off by default, invisible when off.** With the stop off: `hottest` and `cores` are `null`, no new tooltip line, no new Options line. Nothing else changes.
- **Values:** default limit **90°C** (`DEFAULT_EMERGENCY` in `thermal.rs` and `thermal.ts`); range 60–110 unchanged; `RESUME_MARGIN` 5; average of `WINDOW` = 3 readings, 5 s apart.
- **Core keys exactly as Stats lists them** (`Modules/Sensors/values.swift`, MIT, credit in a comment): only `group: .CPU`, `type: .temperature`, `average: true` entries. No other keys.
- **Only macOS's `Critical` state** trips the stop (`Serious` stays with slowing and fans).
- **Readings unchanged:** the chip, slowing, fans and the CPU panel keep using desk's sensor (`celsius`). Linux and Windows read nothing new.
- **SMC is only read**, without rights or the `desk-fans` helper.
- **The fan chart's emergency mark** (`fanChart`, `lines.emergency`) stays as is.
- **Language and naming:**
  - Polish copy goes in `src/locales/pl.ts`, English in `src/locales/en.ts`, with the same placeholders; `src/i18n.test.ts` checks them.
  - Code and comments are in English.
  - Commit subjects are in English, in the repo's sentence style (e.g. "The emergency stop watches the hottest sensor"); commit bodies are in Polish.
  - No mention of AI assistance anywhere.
- **Checks:** `pnpm check` before each commit (typecheck, eslint, vitest, `cargo clippy --all-targets -- -D warnings`, `cargo test`). If `pnpm` answers "Run it? [y/N]" or is not on PATH, use `~/.nvm/versions/node/v24.15.0/bin/pnpm`, or run `./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/eslint .` and `./node_modules/.bin/vitest run` directly, then `cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test`.
- **Platforms:** Windows and Linux must still compile. `core_temps.rs` has no `cfg`; only the code that opens the SMC is macOS-only.

## Review Focus

1. **The SMC stops answering mid-run** (`cores` goes from a value to `None`). The stop goes on with desk's sensor alone: no panic, `hottest` equals `celsius`. *(Task 3: `the_stop_watches_the_hottest_sensor_and_says_so`.)*
2. **Nonsense or missing core keys** (−9201, 0, 400, a key this Mac lacks). They are skipped; with none left the reading is `None`, not 0. *(Task 1: `hottest_core_skips_missing_and_nonsense`.)*
3. **Critical and a hot average on the same tick, then critical clears while the average is still hot.** The cause is `System`; resume is then refused with `Hot(avg)`. *(Task 2: `after_critical_clears_a_hot_average_still_blocks_resume`.)*
4. **Critical while the stop is off, or the stop turned off while halted by the system.** Nothing trips; turning it off lets go. *(Task 2: `critical_with_the_stop_off_does_nothing`.)*
5. **Options before the first reading** (`thermal()` is `null`). No warning line. *(Task 4: `emergencyLines` cases.)*

---

### Task 1: The branch, and the hottest CPU core from the SMC

**Files:**
- Create: `src-tauri/src/core_temps.rs`
- Modify: `src-tauri/src/lib.rs` (declare `pub mod core_temps;` next to `pub mod fan_control;`, no `cfg`)
- Modify: `docs/superpowers/specs/2026-11-15-emergency-stop-hottest-sensor-design.md` (first paragraph of "Po co": the stop is merged in PR 52, not yet released)

**Interfaces:**
- Consumes: `crate::fan_control::Smc` (`read_f32(&mut self, key: &str) -> Result<f32, String>`), `crate::thermal::hottest(impl IntoIterator<Item = f32>) -> Option<f32>`.
- Produces:
  - `pub enum Chip { M1, M2, M3, M4, M5, M6, A18Pro }` (`Debug, Clone, Copy, PartialEq, Eq`)
  - `pub fn chip(brand: &str) -> Option<Chip>`: from `machdep.cpu.brand_string`.
  - `pub fn keys(chip: Chip) -> &'static [&'static str]`
  - `pub fn hottest_core(smc: &mut impl Smc, keys: &[&str]) -> Option<f32>`

- [ ] **Step 1: Create the branch**

```bash
git fetch upstream && git switch -c fix/emergency-stop-hottest-sensor upstream/main
```

The untracked spec and this plan come along. Expected: `git status` shows only them, untracked.

- [ ] **Step 2: Write the failing tests** in `core_temps.rs` (`#[cfg(test)] mod tests`, with a fake `Smc` over a `HashMap<&'static str, f32>` whose `read_f32` returns `Err` for a missing key and whose other methods return `Err`)

```rust
#[test]
fn chips_from_the_brand_string() {
    assert_eq!(chip("Apple M3 Pro"), Some(Chip::M3));
    assert_eq!(chip("Apple M1"), Some(Chip::M1));
    assert_eq!(chip("Apple M2 Max"), Some(Chip::M2));
    assert_eq!(chip("Apple M4"), Some(Chip::M4));
    assert_eq!(chip("Apple M5 Pro"), Some(Chip::M5));
    assert_eq!(chip("Apple M6"), Some(Chip::M6));
    assert_eq!(chip("Apple A18 Pro"), Some(Chip::A18Pro));
    for unknown in ["Apple M9", "Apple M10", "Apple A18", "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz", ""] {
        assert_eq!(chip(unknown), None, "{unknown}");
    }
}

#[test]
fn the_key_lists_are_stats_own() {
    assert_eq!(
        keys(Chip::M3),
        ["Te05", "Te0L", "Te0P", "Te0S", "Tf04", "Tf09", "Tf0A", "Tf0B", "Tf0D", "Tf0E", "Tf44", "Tf49", "Tf4A", "Tf4B", "Tf4D", "Tf4E"]
    );
    let lens = [Chip::M1, Chip::M2, Chip::M4, Chip::M5, Chip::M6, Chip::A18Pro].map(|c| keys(c).len());
    assert_eq!(lens, [10, 12, 12, 18, 18, 4]);
}

#[test]
fn hottest_core_skips_missing_and_nonsense() {
    let mut smc = fake(&[("Te05", 56.2), ("Te0P", 57.0), ("Te0S", -9201.1), ("Tf04", 400.0), ("Tf09", 0.0)]);
    assert_eq!(hottest_core(&mut smc, keys(Chip::M3)), Some(57.0));
    assert_eq!(hottest_core(&mut smc, keys(Chip::M1)), None);
    assert_eq!(hottest_core(&mut fake(&[]), keys(Chip::M3)), None);
}
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd src-tauri && cargo test core_temps`
Expected: does not compile (`chip`, `keys`, `hottest_core` missing).

- [ ] **Step 4: Implement `chip`, `keys` and `hottest_core`**

`chip`: after `"Apple "`, the token `M<n>` with `n` in 1..=6 picks the generation; `A18` followed by `Pro` is `A18Pro`; anything else is `None`. The key lists, copied verbatim from Stats:

```rust
const M1: &[&str] = &["Tp09", "Tp0T", "Tp01", "Tp05", "Tp0D", "Tp0H", "Tp0L", "Tp0P", "Tp0X", "Tp0b"];
const M2: &[&str] = &["Tp1h", "Tp1t", "Tp1p", "Tp1l", "Tp01", "Tp05", "Tp09", "Tp0D", "Tp0X", "Tp0b", "Tp0f", "Tp0j"];
const M3: &[&str] = &["Te05", "Te0L", "Te0P", "Te0S", "Tf04", "Tf09", "Tf0A", "Tf0B", "Tf0D", "Tf0E", "Tf44", "Tf49", "Tf4A", "Tf4B", "Tf4D", "Tf4E"];
const M4: &[&str] = &["Te05", "Te0S", "Te09", "Te0H", "Tp01", "Tp05", "Tp09", "Tp0D", "Tp0V", "Tp0Y", "Tp0b", "Tp0e"];
const M5: &[&str] = &["Tp00", "Tp04", "Tp08", "Tp0C", "Tp0G", "Tp0K", "Tp0O", "Tp0R", "Tp0U", "Tp0X", "Tp0a", "Tp0d", "Tp0g", "Tp0j", "Tp0m", "Tp0p", "Tp0u", "Tp0y"];
const M6: &[&str] = &["Tp0j", "Tp0g", "Tp09", "Tp07", "Tp0m", "Tp0L", "Tp0I", "Tp0d", "Tp0E", "Tp0G", "Tp0b", "Tp05", "Te07", "Te08", "Te09", "Te0c", "Te0h", "Te0i"];
const A18_PRO: &[&str] = &["Te05", "Te0S", "Tp05", "Tp0D"];
```

`hottest_core` reads each key with `read_f32`, drops errors, and returns `thermal::hottest` of the rest. The module doc says: the same keys Stats uses for "Hottest CPU", taken from `exelban/stats` (MIT); a new chip needs its list here.

- [ ] **Step 5: Run the tests and the checks**

Run: `cd src-tauri && cargo test core_temps && cargo clippy --all-targets -- -D warnings`
Expected: 3 passed, no warnings.

- [ ] **Step 6: Update the spec's status line, then commit**

In the spec's "Po co", replace "(gałąź `feat/thermal-emergency-stop`, jeszcze niewydane)" with "(PR 52, scalone, jeszcze niewydane)".

```bash
git add docs/superpowers/specs/2026-11-15-emergency-stop-hottest-sensor-design.md docs/superpowers/plans/2026-11-15-emergency-stop-hottest-sensor.md src-tauri/src/core_temps.rs src-tauri/src/lib.rs
git commit -m "desk reads the CPU core temperatures Stats reads"   # body in Polish
```

---

### Task 2: The stop trips on macOS's critical state and says why it refuses to resume

**Files:**
- Modify: `src-tauri/src/thermal.rs` (`DEFAULT_EMERGENCY`, `Halt`, `Guard::resume`, `Guard::tick` call to `halt.step`, tests)
- Modify: `src-tauri/src/lib.rs:751-762` (`thermal_resume`)
- Modify: `src-tauri/src/layout.rs:329` (the default in the test becomes 90)

**Interfaces:**
- Produces:
  - `pub const DEFAULT_EMERGENCY: u32 = 90;`
  - `#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")] pub enum HaltCause { Temperature, System }`
  - `#[derive(Debug, Clone, Copy, PartialEq)] pub enum Refusal { Hot(f32), Critical }`
  - `Halt::step(&mut self, celsius: Option<f32>, critical: bool, limit: u32) -> bool`
  - `Halt::cause(&self) -> Option<HaltCause>`: `Some` exactly while tripped.
  - `Halt::resume(&mut self, limit: u32) -> Result<(), Refusal>`
  - `Guard::resume(&self) -> Result<Status, Refusal>`

Rules:
- `limit` 0: untrip, no cause, `critical` ignored.
- Not tripped:
  - `critical` trips at once with `System`, even before the window is full;
  - else an average ≥ limit trips with `Temperature`;
  - both on one tick: `System`.
- Tripped: the cause stays until resumed.
- `resume` with `limit` > 0 refuses, checked in this order:
  - `Critical` while the last step said critical;
  - `Hot(avg)` while avg > limit − `RESUME_MARGIN`.

- [ ] **Step 1: Update the existing `Halt` tests and write the new ones**

In the existing tests:
- every `h.step(x, limit)` becomes `h.step(x, false, limit)`, `halt_run` included;
- `Err(91.0)` becomes `Err(Refusal::Hot(91.0))`;
- the guard test's `unwrap_err()` compares with `Refusal::Hot(97.0)`;
- `layout.rs` expects `(false, 90, None)`.

New tests:

```rust
#[test]
fn a_critical_macos_stops_at_once_and_blocks_resume() {
    let mut h = Halt::default();
    assert!(h.step(Some(50.0), true, 90));
    assert_eq!(h.cause(), Some(HaltCause::System));
    assert_eq!(h.resume(90), Err(Refusal::Critical));
    for _ in 0..3 {
        assert!(h.step(Some(50.0), false, 90), "cooled down: still frozen until resumed");
    }
    assert_eq!(h.resume(90), Ok(()));
    assert_eq!(h.cause(), None);
}

#[test]
fn critical_with_the_stop_off_does_nothing() {
    let mut h = Halt::default();
    assert!(!h.step(Some(99.0), true, 0));
    assert_eq!(h.cause(), None);
    assert!(h.step(Some(50.0), true, 90));
    assert!(!h.step(Some(50.0), true, 0), "turned off: lets go");
    assert_eq!(h.resume(0), Ok(()));
}

#[test]
fn the_cause_is_the_temperature_when_the_average_trips() {
    let mut h = Halt::default();
    for c in [91.0, 91.0, 91.0] {
        h.step(Some(c), false, 90);
    }
    assert_eq!(h.cause(), Some(HaltCause::Temperature));
    h.step(Some(91.0), true, 90);
    assert_eq!(h.cause(), Some(HaltCause::Temperature), "the first cause stays");
}

#[test]
fn after_critical_clears_a_hot_average_still_blocks_resume() {
    let mut h = Halt::default();
    for c in [95.0, 95.0, 95.0] {
        h.step(Some(c), true, 90);
    }
    assert_eq!(h.cause(), Some(HaltCause::System));
    for _ in 0..3 {
        h.step(Some(88.0), false, 90);
    }
    assert_eq!(h.resume(90), Err(Refusal::Hot(88.0)));
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd src-tauri && cargo test thermal::tests::`
Expected: does not compile (`HaltCause`, `Refusal`, three-argument `step`).

- [ ] **Step 3: Implement `Halt`, `Guard::resume` and `thermal_resume`**

- `Halt` keeps `critical: bool` from the last step and `cause: Option<HaltCause>`.
- Until Task 3, `Guard::tick` passes `false` for `critical`.
- `thermal_resume` maps `Refusal::Hot(avg)` and `Refusal::Critical` to exact copy:

```rust
Refusal::Hot(avg) => tr!(
    format!("Najgorętszy czujnik ma jeszcze {c}°C: karty wznowisz od {at}°C (albo wyłącz awaryjne zatrzymanie w Opcjach)."),
    format!("The hottest sensor is still at {c}°C: the tiles can resume from {at}°C (or turn the emergency stop off in Options).")
),
Refusal::Critical => tr!(
    "macOS wciąż zgłasza krytyczną temperaturę: karty wznowisz, gdy to minie (albo wyłącz awaryjne zatrzymanie w Opcjach).".to_string(),
    "macOS still reports a critical temperature: the tiles can resume once it passes (or turn the emergency stop off in Options).".to_string()
),
```

(`c` and `at` as today: `avg.round()` and `emergency − RESUME_MARGIN`.)

- [ ] **Step 4: Run the tests and the checks**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: all pass, no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/thermal.rs src-tauri/src/lib.rs src-tauri/src/layout.rs
git commit -m "A critical macOS stops the work at once, and the stop starts at 90°C"   # body in Polish
```

---

### Task 3: The guard reads the cores and macOS's critical state, and reports what the stop watches

**Files:**
- Modify: `src-tauri/src/thermal.rs` (`Reading`, `Sees`, `sees`, `Status`, `Guard::tick`, `spawn`, `os::Sensor::cores`, `os::critical` in all three `os` modules, tests)
- Modify: `src-tauri/src/lib.rs:944-950` (the `spawn` closure)

**Interfaces:**
- Consumes: `core_temps::{chip, keys, hottest_core}` (Task 1), `Halt::step` with three arguments and `HaltCause` (Task 2), `crate::smc::IoSmc::open() -> Result<IoSmc, String>` (macOS).
- Produces:
  - `#[derive(Debug, Clone, Copy, Default, PartialEq)] pub struct Reading { pub celsius: Option<f32>, pub cores: Option<f32>, pub pressure: bool, pub critical: bool }`
  - `#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")] pub enum Sees { Cores, Sensor, System, Cpu, Nothing }`
  - `pub fn sees(r: &Reading, macos: bool) -> Sees`. With `macos`: `cores` gives `Cores`, else `celsius` gives `Sensor`, else `System`. Without: `celsius` gives `Cpu`, else `Nothing`. The guard passes `cfg!(target_os = "macos")`.
  - `Status` gains (serialized camelCase):
    - `hottest: Option<i32>`
    - `cores: Option<i32>`
    - `halted_by: Option<HaltCause>`
    - `sees: Sees`

    The first two are `None` while the stop is off.
  - `Guard::tick(&self, r: Reading, roots: impl FnOnce() -> Vec<u32>) -> Option<Status>`
  - `pub fn spawn(tick: impl FnMut(Reading) + Send + 'static)`

The tick:
- slowing and the fans keep using `r.celsius` and `r.pressure`;
- the stop gets `hottest(r.celsius.into_iter().chain(r.cores))` and `r.critical`;
- `Status::hottest` and `Status::cores` round those values, only when `emergency > 0`.

The `os` modules:
- macOS:
  - `Sensor::cores(&mut self) -> Option<f32>` finds the chip once from `machdep.cpu.brand_string` (`libc::sysctlbyname`) and opens `IoSmc` once at the first call; if the open fails or the chip is unknown, it returns `None` from then on;
  - `critical()` is `thermalState().0 >= NSProcessInfoThermalState::Critical.0`.
- Linux and Windows: `cores` returns `None`, `critical` returns `false`.

The SMC is read every tick, whether the stop is on or not.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn the_stop_sees_what_this_computer_has() {
    let r = |celsius: Option<f32>, cores: Option<f32>| Reading { celsius, cores, ..Default::default() };
    assert_eq!(sees(&r(Some(54.0), Some(68.0)), true), Sees::Cores);
    assert_eq!(sees(&r(Some(54.0), None), true), Sees::Sensor);
    assert_eq!(sees(&r(None, None), true), Sees::System);
    assert_eq!(sees(&r(Some(54.0), None), false), Sees::Cpu);
    assert_eq!(sees(&r(None, None), false), Sees::Nothing);
}

#[cfg(unix)]
#[test]
fn the_stop_watches_the_hottest_sensor_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let guard = Guard::new(Mode::Off, 75, Vec::new(), StepDown::default(), 90, dir.path());
    let read = |celsius: f32, cores: Option<f32>| Reading { celsius: Some(celsius), cores, ..Default::default() };
    let s = guard.tick(read(54.0, Some(68.0)), Vec::new).unwrap();
    assert_eq!((s.celsius, s.hottest, s.cores), (Some(54), Some(68), Some(68)));
    // The SMC stops answering: desk's own sensor carries on.
    let s = guard.tick(read(55.0, None), Vec::new).unwrap();
    assert_eq!((s.hottest, s.cores), (Some(55), None));
    // Cores hot, desk's sensor cool: it stops on the average of the hottest.
    for _ in 0..3 {
        guard.tick(read(56.0, Some(91.0)), Vec::new);
    }
    let s = guard.status();
    assert!(s.halted && s.halted_by == Some(HaltCause::Temperature), "{s:?}");
    // Off: nothing of the stop in the status.
    guard.set_emergency(0);
    let s = guard.tick(read(56.0, Some(91.0)), Vec::new).unwrap();
    assert_eq!((s.hottest, s.cores, s.halted, s.halted_by), (None, None, false, None));
}

#[cfg(unix)]
#[test]
fn a_critical_macos_stops_the_guard_until_it_passes() {
    let dir = tempfile::tempdir().unwrap();
    let guard = Guard::new(Mode::Off, 75, Vec::new(), StepDown::default(), 90, dir.path());
    let s = guard.tick(Reading { celsius: Some(50.0), critical: true, ..Default::default() }, Vec::new).unwrap();
    assert_eq!(s.halted_by, Some(HaltCause::System));
    assert_eq!(guard.resume().unwrap_err(), Refusal::Critical);
}
```

Also:
- the existing guard test's `tick` closure becomes `guard.tick(Reading { celsius: Some(c), ..Default::default() }, || vec![root])`;
- `reads_this_computer` also prints `Sensor::cores()` and `os::critical()`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd src-tauri && cargo test thermal::tests::`
Expected: does not compile (`Reading`, `Sees`, `sees`, new `Status` fields).

- [ ] **Step 3: Implement `Reading`, `Sees`, `sees`, the new `Status` fields, `Guard::tick`, `spawn`, `os::Sensor::cores`, `os::critical` and the `lib.rs` closure** (`thermal::spawn(move |reading| { … guard.tick(reading, roots) … })`)

- [ ] **Step 4: Run the tests, the checks, and the live reading**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo test reads_this_computer -- --ignored --nocapture`
Expected:
- all pass, no warnings;
- on the M3 Pro, the live line shows `cores` a few °C above desk's sensor at rest (about 5) and `critical: false`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/thermal.rs src-tauri/src/lib.rs
git commit -m "The emergency stop watches the hottest of the CPU cores and desk's sensor"   # body in Polish
```

---

### Task 4: The tooltip, the toast and Options say what the stop watches

**Files:**
- Modify: `src/api.ts:242-269` (`ThermalStatus`, new `StopSees`)
- Modify: `src/thermal.ts` (`DEFAULT_EMERGENCY`, `haltLines`, `thermalToast`, new `emergencyLines`)
- Modify: `src/settings.ts:262-268` (`emergencyHtml`)
- Modify: `src/locales/pl.ts`, `src/locales/en.ts`
- Test: `src/thermal.test.ts`

**Interfaces:**
- Consumes: `Status` from Task 3, serialized as `hottest`, `cores`, `haltedBy` (`"temperature" | "system" | null`) and `sees`.
- Produces:
  - `export type StopSees = "cores" | "sensor" | "system" | "cpu" | "nothing";`
  - `ThermalStatus` gains `hottest: number | null; cores: number | null; haltedBy: "temperature" | "system" | null; sees: StopSees;`
  - `export function emergencyLines(sees: StopSees | null): MessageKey[]`:
    - `cores` → `["settings.emergencyWatchesCores"]`
    - `sensor` → `["settings.emergencySensorOnly"]`
    - `system` → `["settings.emergencySystemOnly"]`
    - `nothing` → `["settings.emergencyNothing"]`
    - `cpu` and `null` → `[]`
  - `export const DEFAULT_EMERGENCY = 90;`

Behaviour:
- **`haltLines`, not halted:**
  - with `cores` and `celsius` → `thermal.emergencyCores` `{ limit, cores, c }`;
  - else with `hottest` → `thermal.emergencyCpu` `{ limit, c: hottest }`;
  - else `thermal.emergencyReady` as today.
- **`haltLines`, halted:** as today, plus `thermal.haltedSystem` when `haltedBy === "system"`.
- **`thermalToast` on a new halt:**
  - `haltedBy === "system"` → `tn("thermal.haltedSystemToast", frozen)`;
  - else `thermal.halted` with `c = next.hottest ?? next.celsius ?? "?"`.
- **`emergencyHtml`:** only when `layout.emergencyOn`, the keys of `emergencyLines(this.ctx.thermal()?.sees ?? null)` go above the "about" paragraph:
  - `settings.emergencyWatchesCores` as `<p class="dim small" data-row>`;
  - the three warnings as `<p class="error" data-row>`.

Copy (Polish, English):

| key | pl | en |
|---|---|---|
| `thermal.emergencyCores` | Awaryjne zatrzymanie od {limit}°C: rdzenie {cores}°C, czujnik desk {c}°C. | Emergency stop from {limit}°C: cores {cores}°C, desk's sensor {c}°C. |
| `thermal.emergencyCpu` | Awaryjne zatrzymanie od {limit}°C: procesor {c}°C. | Emergency stop from {limit}°C: CPU {c}°C. |
| `thermal.haltedSystem` | Wywołał je macOS: zgłosił krytyczną temperaturę. | macOS triggered it: it reported a critical temperature. |
| `thermal.haltedSystemToast` | macOS zgłosił krytyczną temperaturę: desk awaryjnie zatrzymał pracę w kartach ({n} proces). Wznów przyciskiem ▶ w górnym pasku.\|… ({n} procesy) …\|… ({n} procesów) … | macOS reported a critical temperature: desk stopped the work in its tiles ({n} process). Resume with ▶ in the top bar.\|… ({n} processes) … |
| `settings.emergencyWatchesCores` | Patrzy na najgorętszy z czujników: rdzenie procesora (te same co w Stats) i czujnik desk. Zatrzymuje też od razu, gdy macOS zgłosi krytyczną temperaturę. | It watches the hottest sensor: the CPU cores (the same as in Stats) and desk's own. It also stops at once when macOS reports a critical temperature. |
| `settings.emergencySensorOnly` | Rdzeni tego procesora desk jeszcze nie zna: zatrzymanie patrzy na czujnik desk i na krytyczny stan macOS. | desk does not know this processor's cores yet: the stop watches desk's sensor and macOS's critical state. |
| `settings.emergencySystemOnly` | desk nie odczytuje tu temperatury: zatrzyma pracę tylko, gdy macOS zgłosi krytyczną. | desk cannot read the temperature here: it stops the work only when macOS reports a critical one. |
| `settings.emergencyNothing` | desk nie odczytuje tu temperatury, więc zatrzymanie nie zadziała. | desk cannot read the temperature here, so the stop will not work. |

(The "…" rows repeat the first form with only the plural changed, as `thermal.halted` does.)

- [ ] **Step 1: Write the failing tests**

`at()` gains `hottest: null, cores: null, haltedBy: null, sees: "cpu"`. In `describe("emergency stop")`:

```ts
it("the title shows the cores and desk's sensor, or the CPU alone", () => {
  expect(thermalTitle(at(54, { emergency: 90, hottest: 68, cores: 68, sees: "cores" }))).toContain(
    "Awaryjne zatrzymanie od 90°C: rdzenie 68°C, czujnik desk 54°C.",
  );
  expect(thermalTitle(at(54, { emergency: 90, hottest: 54, sees: "cpu" }))).toContain("Awaryjne zatrzymanie od 90°C: procesor 54°C.");
  expect(thermalTitle(at(54, { hottest: null, cores: null }))).not.toContain("Awaryjne");
});

it("the toast names the hottest reading, or macOS", () => {
  const hot = at(56, { emergency: 90, halted: true, frozen: 12, hottest: 91, cores: 91, haltedBy: "temperature" });
  expect(thermalToast(at(56, { emergency: 90 }), hot)).toBe(
    "Procesor ma 91°C: desk awaryjnie zatrzymał pracę w kartach (12 procesów). Wznów przyciskiem ▶ w górnym pasku.",
  );
  const sys = { ...hot, haltedBy: "system" as const };
  expect(thermalToast(at(56, { emergency: 90 }), sys)).toBe(
    "macOS zgłosił krytyczną temperaturę: desk awaryjnie zatrzymał pracę w kartach (12 procesów). Wznów przyciskiem ▶ w górnym pasku.",
  );
  expect(thermalTitle(sys)).toContain("Wywołał je macOS");
});

it("Options says what the stop watches, and warns when it sees less", () => {
  expect(emergencyLines("cores")).toEqual(["settings.emergencyWatchesCores"]);
  expect(emergencyLines("sensor")).toEqual(["settings.emergencySensorOnly"]);
  expect(emergencyLines("system")).toEqual(["settings.emergencySystemOnly"]);
  expect(emergencyLines("nothing")).toEqual(["settings.emergencyNothing"]);
  expect(emergencyLines("cpu")).toEqual([]);
  expect(emergencyLines(null)).toEqual([]);
});
```

In the existing clamp test, `NaN` now maps to `90`.

- [ ] **Step 2: Run them to see them fail**

Run: `./node_modules/.bin/vitest run src/thermal.test.ts`
Expected: FAIL (no `emergencyLines` export, titles and toasts without the new lines).

- [ ] **Step 3: Implement the types, `emergencyLines`, `haltLines`, `thermalToast`, `emergencyHtml` and the copy**

- [ ] **Step 4: Run the whole check**

Run: `pnpm check` (or the fallbacks under Global Constraints)
Expected: typecheck, eslint and vitest pass (including `i18n.test.ts` placeholders); clippy and cargo test pass.

- [ ] **Step 5: Commit**

```bash
git add src/api.ts src/thermal.ts src/settings.ts src/locales/pl.ts src/locales/en.ts src/thermal.test.ts
git commit -m "The temperature tooltip and Options say what the emergency stop watches"   # body in Polish
```

---

### Task 5: README, and the branch done

**Files:**
- Modify: `README.md`:
  - the "Temperatura" row: "Awaryjne zatrzymanie";
  - the technical notes bullet "Awaryjne zatrzymanie".

- [ ] **Step 1: Update the README**

In the "Temperatura" row:
- "domyślnie 95°C" becomes "domyślnie 90°C";
- the trigger becomes "gdy średnia z 15 s najgorętszego czujnika (rdzenie procesora, te same co w Stats, albo czujnik desk) dojdzie do progu, a od razu, gdy macOS zgłosi krytyczną temperaturę".

The technical bullet gains one sentence on macOS: the cores come from the SMC keys Stats uses for "Hottest CPU" (read without rights), the maximum with IOHID `PMU tdie*`, and `NSProcessInfo.thermalState` critical. It also says what Intel Macs and Linux/Windows watch.

- [ ] **Step 2: Run the whole check**

Run: `pnpm check`
Expected: all green.

- [ ] **Step 3: Commit, then finish the branch**

```bash
git add README.md
git commit -m "The README says what the emergency stop watches"   # body in Polish
```

Then use superpowers:finishing-a-development-branch (PR into `upstream/main`, PR title in English, body in Polish with `Dlaczego`, `Nowości`/`Zmiany`, `Uwagi do review`; the `Dlaczego` tells the M3 Pro measurement: desk 56°C, Stats 81°C in one build).
