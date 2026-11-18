//! Persistent layout and options in `layout.json`: lanes (columns) of project
//! paths and their sizes, projects started with the app, hand-added folders.

use serde::{Deserialize, Serialize};
use std::path::Path;

pub const DEFAULT_LANES: usize = 4;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Layout {
    pub version: u32,
    /// Each lane is a column of tiles, top to bottom, identified by project path.
    pub lanes: Vec<Vec<String>>,
    /// Projects whose sessions are opened when the app starts.
    pub autostart: Vec<String>,
    /// Folders added by hand, listed even when discovery does not find them.
    pub extra_folders: Vec<String>,
    pub notifications: bool,
    /// Color picked by hand per project path (index into the UI palette);
    /// projects not listed get a color derived from their path.
    pub colors: std::collections::BTreeMap<String, u32>,
    /// Agents added by hand (built-ins are always available).
    pub agents: Vec<crate::agents::CustomAgent>,
    /// Command of each "run" session (⌘U), by session key, to start it again.
    pub runs: std::collections::BTreeMap<String, String>,
    /// Card a session sits in when it is not its own project's, by key (none are
    /// set now; ⌘R conversations used to join the active card).
    pub cards: std::collections::BTreeMap<String, String>,
    /// Where "new project" creates folders; None = a usual folder such as
    /// ~/Projects if one exists, else ~ (new_project::default_parent).
    pub projects_dir: Option<String>,
    /// desk places newly opened projects (a lane of their own while there is
    /// room) and drops empty lanes; off = a fixed number of lanes, set by hand.
    pub auto_layout: bool,
    /// Width of each lane, as a weight (index = lane); missing ones are 1.
    pub widths: Vec<f64>,
    /// Height of each project's card in its lane, as a weight, by card (project
    /// path); cards not listed follow their sessions.
    pub heights: std::collections::BTreeMap<String, f64>,
    /// Room of each session in its card, as a weight, by session key; agents
    /// not listed get 1, shells and ⌘U commands less.
    pub sizes: std::collections::BTreeMap<String, f64>,
    /// How a card shows its sessions, by card: "row" side by side, "tabs" one
    /// at a time; not listed = one under another.
    pub modes: std::collections::BTreeMap<String, String>,
    /// The session a card in tabs shows, by card.
    pub tabs: std::collections::BTreeMap<String, String>,
    /// Color theme id (see src/themes.ts).
    pub theme: String,
    /// Where web pages open outside desk: "auto" (Brave, then Chrome),
    /// "brave", "chrome" or "system" (see browser.rs).
    pub browser: String,
    /// What a plain click on a terminal link does: "desk" (side panel),
    /// "browser" or "none" (see linkTarget in src/links.ts).
    pub link_click: String,
    /// Terminal font size in px (⌘= / ⌘- / ⌘0, Options).
    pub font_size: f64,
    /// Size of the window's own text and bars (not terminals), one of
    /// 0.9, 1, 1.1, 1.25, 1.5; see uiScale in src/ui-scale.ts.
    pub ui_scale: f64,
    /// Session keys whose tiles are folded to their header (⌘J).
    pub minimized: Vec<String>,
    /// Names given to tiles by hand, by session key.
    pub titles: std::collections::BTreeMap<String, String>,
    /// Claude conversations saved under a name (a named tile), by project
    /// path, then by conversation id: ⌘S lists them first, however old.
    pub saved: std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>,
    /// ⌘` slides the window down from the top of the screen (see dropdown.rs).
    pub dropdown: bool,
    /// Height of the dropped-down window, in percent of the screen.
    pub dropdown_height: u32,
    /// The dropdown goes up when another app takes the focus.
    pub dropdown_autohide: bool,
    /// Its shortcut, as "Super+Backquote" (see dropdown::DEFAULT_HOTKEY).
    pub dropdown_hotkey: String,
    /// How long it slides, in ms (0: no slide).
    pub dropdown_animation: u32,
    /// desk's shortcuts changed in Options, by binding id (src/keys.ts).
    pub keys: std::collections::BTreeMap<String, String>,
    /// A right click in a terminal opens tmux's menu (split, swap, kill...)
    /// when the program in it does not take the mouse.
    pub tmux_menu: bool,
    /// Interface language, "pl" or "en" (src/i18n.ts). Empty until the first
    /// launch takes the system's; layouts from before it stay Polish.
    pub language: String,
    /// Ctrl+G in Claude rewrites the prompt with the company LLM (prompt_ai.rs).
    pub prompt_ai: PromptAi,
    /// Claude accounts (accounts.rs); the first one is the default. Empty or
    /// one: every session uses Claude Code's default account, as before.
    pub claude_accounts: Vec<crate::accounts::ClaudeAccount>,
    /// The account each Claude session was started with, by session key.
    pub tile_accounts: std::collections::BTreeMap<String, String>,
    /// The account new Claude sessions of a project use, by project path.
    pub project_accounts: std::collections::BTreeMap<String, String>,
    /// What desk does when hot: "off", "slow", "together" or "fans"
    /// (thermal::Mode; "fansFirst" from older files becomes "together").
    pub thermal_mode: String,
    /// Slow the sessions while the CPU is hotter than this, °C (thermal.rs).
    /// Files from before modes used 0 for "never" (see `load`).
    pub thermal_limit: u32,
    /// The fan steps in modes "together" and "fans" (thermal::Step), repaired
    /// on load (thermal::normalize_steps).
    pub fan_steps: Vec<crate::thermal::Step>,
    /// A fan step comes down this many °C below its threshold
    /// (thermal::StepDown, clamped there).
    pub fan_margin: u32,
    /// …and no sooner than this many seconds after the last change.
    pub fan_wait: u32,
    /// Files from before steps: fans at full speed from this, °C, in mode
    /// "fansFirst". Read for the migration in `load`, never written.
    #[serde(skip_serializing)]
    pub fan_limit: Option<u32>,
    /// Emergency stop: from `emergency_at` °C the work in every session is
    /// frozen until resumed by hand (thermal::Halt). Off unless turned on in
    /// Options.
    pub emergency_on: bool,
    /// Clamped to thermal::MIN_EMERGENCY..=MAX_EMERGENCY where it is used.
    pub emergency_at: u32,
    /// `emergency_at` was saved knowing the stop watches the hottest CPU core.
    /// Files without it hold the 90°C default meant for desk's own sensor,
    /// which `load` moves to today's default (thermal::OLD_DEFAULT_EMERGENCY).
    pub emergency_for_cores: bool,
    /// The temperature chip's colours, chosen in Options; None: from the
    /// slowing limit or the first fan step (src/thermal.ts).
    pub thermal_colors: Option<ThermalColors>,
    /// Parts of the temperature chip's panel hidden in Options, by id
    /// ("gauges", "state", "history", "details", "load", "top"; see
    /// src/cpu-view.ts). Empty: all shown, and so is any part added later.
    pub cpu_hidden: Vec<String>,
    /// The usage popover: "tabs" (one view at a time) or "all" (everything at once).
    pub usage_layout: String,
    /// How a session's share of the 5-hour window is worked out: "cost" (its
    /// cost in desk's history) or "transcripts" (Claude Code's transcripts).
    pub usage_share: String,
}

/// The temperature chip is yellow from `warm` and red from `hot`, °C.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThermalColors {
    pub warm: u32,
    pub hot: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PromptAi {
    pub enabled: bool,
    /// OpenAI-compatible server: base, `/v1` or the full chat endpoint. No
    /// default: desk is open source, each user enters their own.
    pub url: String,
    pub model: String,
}


impl Default for Layout {
    fn default() -> Self {
        Self {
            version: 1,
            lanes: vec![Vec::new(); DEFAULT_LANES],
            autostart: Vec::new(),
            extra_folders: Vec::new(),
            notifications: true,
            colors: Default::default(),
            agents: Vec::new(),
            runs: Default::default(),
            cards: Default::default(),
            projects_dir: None,
            auto_layout: true,
            widths: Vec::new(),
            heights: Default::default(),
            sizes: Default::default(),
            modes: Default::default(),
            tabs: Default::default(),
            theme: "desk".into(),
            browser: "auto".into(),
            link_click: "desk".into(),
            font_size: 11.5,
            ui_scale: 1.0,
            minimized: Vec::new(),
            titles: Default::default(),
            saved: Default::default(),
            // Ctrl+` belongs to editors' terminals on Windows and Linux: opt in there.
            dropdown: cfg!(target_os = "macos"),
            dropdown_height: 50,
            dropdown_autohide: true,
            dropdown_hotkey: crate::dropdown::DEFAULT_HOTKEY.into(),
            dropdown_animation: 200,
            keys: Default::default(),
            tmux_menu: false,
            language: String::new(),
            prompt_ai: PromptAi::default(),
            claude_accounts: Vec::new(),
            tile_accounts: Default::default(),
            project_accounts: Default::default(),
            thermal_mode: "slow".into(),
            thermal_limit: crate::thermal::DEFAULT_LIMIT,
            fan_steps: crate::thermal::default_steps(),
            fan_margin: crate::thermal::DEFAULT_FAN_MARGIN,
            fan_wait: crate::thermal::DEFAULT_FAN_WAIT,
            fan_limit: None,
            emergency_on: false,
            emergency_at: crate::thermal::DEFAULT_EMERGENCY,
            emergency_for_cores: true,
            thermal_colors: None,
            cpu_hidden: Vec::new(),
            usage_layout: "tabs".into(),
            usage_share: "cost".into(),
        }
    }
}

impl Layout {
    /// At least one lane, and no project in two places.
    pub fn normalized(mut self) -> Self {
        if self.lanes.is_empty() {
            self.lanes = vec![Vec::new(); DEFAULT_LANES];
        }
        let mut seen = std::collections::HashSet::new();
        for lane in &mut self.lanes {
            lane.retain(|p| seen.insert(p.clone()));
        }
        let mut seen = std::collections::HashSet::new();
        self.autostart.retain(|p| seen.insert(p.clone()));
        let mut seen = std::collections::HashSet::new();
        self.extra_folders.retain(|p| seen.insert(p.clone()));
        self
    }
}

/// Missing file gives the default; an unreadable one is kept as
/// `layout.json.bak` and replaced by the default rather than failing startup.
pub fn load(path: &Path) -> Layout {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Layout::default();
    };
    match serde_json::from_str::<Layout>(&text) {
        Ok(mut l) => {
            if l.language.is_empty() {
                l.language = "pl".into(); // saved before languages: desk spoke Polish
            }
            if l.thermal_limit == 0 {
                // Saved before modes: 0 meant "never slow".
                l.thermal_mode = "off".into();
                l.thermal_limit = crate::thermal::DEFAULT_LIMIT;
            }
            let raw = serde_json::from_str::<serde_json::Value>(&text).ok();
            let has = |key: &str| raw.as_ref().is_some_and(|v| v.get(key).is_some());
            migrate_fan_steps(&mut l, has("fanSteps"));
            if !has("emergencyForCores") && l.emergency_at == crate::thermal::OLD_DEFAULT_EMERGENCY {
                // The old default sat 10°C over desk's sensor; the stop now
                // watches the cores, which run far hotter under plain load.
                l.emergency_at = crate::thermal::DEFAULT_EMERGENCY;
            }
            l.normalized()
        }
        Err(_) => {
            let _ = std::fs::rename(path, path.with_extension("json.bak"));
            Layout::default()
        }
    }
}

/// Files from before steps: each fan mode becomes one step at full speed
/// from the threshold it used ("fansFirst": the lower of its two limits, now
/// mode "together"), so nothing changes for anyone. Steps from the file are
/// repaired.
fn migrate_fan_steps(l: &mut Layout, had_steps: bool) {
    use crate::thermal::{MAX_LIMIT, MIN_LIMIT, Step, default_steps, normalize_steps};
    if !had_steps {
        let one = |celsius: u32| vec![Step { celsius: celsius.clamp(MIN_LIMIT, MAX_LIMIT), percent: 100 }];
        l.fan_steps = match l.thermal_mode.as_str() {
            "fansFirst" => one(l.fan_limit.unwrap_or(70).min(l.thermal_limit)),
            "together" | "fans" => one(l.thermal_limit),
            _ => default_steps(),
        };
    }
    l.fan_steps = normalize_steps(std::mem::take(&mut l.fan_steps));
    if l.thermal_mode == "fansFirst" {
        l.thermal_mode = "together".into();
    }
    l.fan_limit = None;
}

/// Atomic write: temp file in the same directory, then rename.
pub fn save(path: &Path, layout: &Layout) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&layout.clone().normalized())?;
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::thermal::{Step, default_steps};

    #[test]
    fn missing_file_gives_default_with_four_lanes_and_no_autostart() {
        let tmp = tempfile::tempdir().unwrap();
        let l = load(&tmp.path().join("layout.json"));
        assert_eq!(l.lanes.len(), 4);
        assert!(l.autostart.is_empty());
    }

    #[test]
    fn round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("sub/layout.json");
        let l = Layout {
            lanes: vec![vec!["/a".into(), "/b".into()], vec![], vec!["/c".into()]],
            autostart: vec!["/a".into()],
            extra_folders: vec!["/x".into()],
            notifications: false,
            colors: [("/a".to_string(), 3)].into(),
            language: "en".into(),
            widths: vec![1.5, 1.0, 0.5],
            heights: [("/a".to_string(), 2.0)].into(),
            sizes: [("shell#0:/a".to_string(), 0.4)].into(),
            modes: [("/a".to_string(), "tabs".to_string())].into(),
            tabs: [("/a".to_string(), "shell#0:/a".to_string())].into(),
            thermal_mode: "together".into(),
            fan_steps: vec![st(65, 50), st(80, 100)],
            emergency_on: true,
            emergency_at: 98,
            thermal_colors: Some(ThermalColors { warm: 60, hot: 85 }),
            cpu_hidden: vec!["details".into(), "top".into()],
            ..Layout::default()
        };
        save(&p, &l).unwrap();
        assert_eq!(load(&p), l);
        assert!(!p.with_extension("json.tmp").exists());
    }

    #[test]
    fn files_from_before_the_emergency_stop_have_it_off_and_the_old_colours() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("layout.json");
        std::fs::write(&p, r#"{"version":1,"thermalLimit":80}"#).unwrap();
        let l = load(&p);
        assert_eq!((l.emergency_on, l.emergency_at, l.thermal_colors), (false, crate::thermal::DEFAULT_EMERGENCY, None));
        std::fs::write(&p, r#"{"thermalColors":{"warm":55,"hot":70},"emergencyOn":true,"emergencyAt":95}"#).unwrap();
        let l = load(&p);
        assert_eq!((l.emergency_on, l.emergency_at), (true, 95));
        assert_eq!(l.thermal_colors, Some(ThermalColors { warm: 55, hot: 70 }));
    }

    #[test]
    fn the_old_90_degree_default_moves_to_the_core_default_once() {
        use crate::thermal::DEFAULT_EMERGENCY;
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("layout.json");
        std::fs::write(&p, r#"{"version":1,"emergencyOn":true,"emergencyAt":90}"#).unwrap();
        let l = load(&p);
        assert_eq!((l.emergency_on, l.emergency_at, l.emergency_for_cores), (true, DEFAULT_EMERGENCY, true));
        // Saved again, a 90 picked by hand stays 90.
        save(&p, &Layout { emergency_at: 90, ..l }).unwrap();
        assert_eq!(load(&p).emergency_at, 90);
    }

    #[test]
    fn files_from_before_the_cpu_panel_options_show_all_of_it() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("layout.json");
        std::fs::write(&p, r#"{"version":1}"#).unwrap();
        assert!(load(&p).cpu_hidden.is_empty());
        std::fs::write(&p, r#"{"cpuHidden":["history"]}"#).unwrap();
        assert_eq!(load(&p).cpu_hidden, ["history"]);
    }

    #[test]
    fn link_click_is_desk_unless_the_file_says_otherwise() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("layout.json");
        std::fs::write(&p, r#"{"version":1,"browser":"brave"}"#).unwrap();
        assert_eq!(load(&p).link_click, "desk");
        std::fs::write(&p, r#"{"version":1,"linkClick":"none"}"#).unwrap();
        assert_eq!(load(&p).link_click, "none");
    }

    #[test]
    fn ui_scale_is_one_in_old_files_and_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("layout.json");
        std::fs::write(&p, r#"{"version":1}"#).unwrap();
        assert_eq!(load(&p).ui_scale, 1.0);
        let l = Layout { ui_scale: 1.25, ..Layout::default() };
        save(&p, &l).unwrap();
        assert_eq!(load(&p).ui_scale, 1.25);
    }

    #[test]
    fn usage_options_default_unless_the_file_says_otherwise() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("layout.json");
        std::fs::write(&p, r#"{"version":1}"#).unwrap();
        let l = load(&p);
        assert_eq!((l.usage_layout.as_str(), l.usage_share.as_str()), ("tabs", "cost"));
        std::fs::write(&p, r#"{"version":1,"usageLayout":"all","usageShare":"transcripts"}"#).unwrap();
        let l = load(&p);
        assert_eq!((l.usage_layout.as_str(), l.usage_share.as_str()), ("all", "transcripts"));
    }

    #[test]
    fn corrupt_file_is_backed_up() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("layout.json");
        std::fs::write(&p, "{not json").unwrap();
        assert_eq!(load(&p), Layout::default());
        assert!(p.with_extension("json.bak").exists());
    }

    #[test]
    fn partial_file_fills_defaults_and_dedupes() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("layout.json");
        std::fs::write(
            &p,
            r#"{"lanes":[["/a","/b"],["/a"]],"autostart":["/a","/a"]}"#,
        )
        .unwrap();
        let l = load(&p);
        assert_eq!(l.lanes, vec![vec!["/a".to_string(), "/b".into()], vec![]]);
        assert_eq!(l.autostart, vec!["/a".to_string()]);
        assert!(l.notifications);
        assert_eq!(l.dropdown, cfg!(target_os = "macos"));
        assert_eq!((l.dropdown_height, l.dropdown_autohide), (50, true));
        assert_eq!(l.language, "pl");
    }

    #[test]
    fn old_file_with_slowing_off_becomes_mode_off() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("layout.json");
        std::fs::write(&p, r#"{"thermalLimit":0}"#).unwrap();
        let l = load(&p);
        assert_eq!((l.thermal_mode.as_str(), l.thermal_limit), ("off", 75));
        assert_eq!(l.fan_steps, default_steps());
    }

    #[test]
    fn old_file_with_a_limit_keeps_slowing() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("layout.json");
        std::fs::write(&p, r#"{"thermalLimit":80}"#).unwrap();
        let l = load(&p);
        assert_eq!((l.thermal_mode.as_str(), l.thermal_limit), ("slow", 80));
        assert_eq!(l.fan_steps, default_steps());
    }

    #[test]
    fn first_launch_has_no_language_yet() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(load(&tmp.path().join("layout.json")).language, "");
    }

    fn loaded(json: &str) -> Layout {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("layout.json");
        std::fs::write(&p, json).unwrap();
        load(&p)
    }

    fn st(celsius: u32, percent: u8) -> Step {
        Step { celsius, percent }
    }

    #[test]
    fn fans_first_becomes_together_with_the_fan_limit_as_one_step() {
        let l = loaded(r#"{"thermalMode":"fansFirst","thermalLimit":80,"fanLimit":65}"#);
        assert_eq!((l.thermal_mode.as_str(), l.thermal_limit, l.fan_steps.clone()), ("together", 80, vec![st(65, 100)]));
        let l = loaded(r#"{"thermalMode":"fansFirst","thermalLimit":75,"fanLimit":90}"#);
        assert_eq!(l.fan_steps, vec![st(75, 100)]);
    }

    #[test]
    fn together_and_fans_keep_their_limit_as_one_step() {
        assert_eq!(loaded(r#"{"thermalMode":"together","thermalLimit":78}"#).fan_steps, vec![st(78, 100)]);
        assert_eq!(loaded(r#"{"thermalMode":"fans","thermalLimit":60}"#).fan_steps, vec![st(60, 100)]);
        assert_eq!(loaded(r#"{"thermalMode":"slow","thermalLimit":80}"#).fan_steps, vec![st(70, 100)]);
    }

    #[test]
    fn broken_steps_in_the_file_are_repaired() {
        let l = loaded(
            r#"{"thermalMode":"together","fanSteps":[{"celsius":80,"percent":100},{"celsius":65,"percent":45}]}"#,
        );
        assert_eq!(l.fan_steps, vec![st(65, 50), st(80, 100)]);
    }

    #[test]
    fn an_old_file_gets_the_default_way_down() {
        let l = loaded(r#"{"thermalMode":"fans"}"#);
        assert_eq!((l.fan_margin, l.fan_wait), (7, 60));
        let l = loaded(r#"{"thermalMode":"fans","fanMargin":4,"fanWait":30}"#);
        assert_eq!((l.fan_margin, l.fan_wait), (4, 30));
        // 0 is a margin of its own ("none"), not a missing one.
        let l = loaded(r#"{"thermalMode":"fans","fanMargin":0}"#);
        assert_eq!(l.fan_margin, 0);
    }

    #[test]
    fn the_old_fan_limit_is_not_written_back() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("layout.json");
        std::fs::write(&p, r#"{"thermalMode":"fansFirst","fanLimit":65}"#).unwrap();
        save(&p, &load(&p)).unwrap();
        assert!(!std::fs::read_to_string(&p).unwrap().contains("fanLimit"));
    }
}
