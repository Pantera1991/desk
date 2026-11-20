//! Upload panel backend: validates an upload tile and builds the `rsync`
//! command a terminal tile runs.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A saved upload server: the host name, the ssh user and an optional key.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadHost {
    pub host: String,
    pub user: String,
    #[serde(default)]
    pub key: String,
    /// How the file goes: rsync (resumable) or scp (for servers without rsync).
    #[serde(default)]
    pub method: Method,
}

/// The program a server's uploads run; rsync unless Options say scp.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    #[default]
    Rsync,
    Scp,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadTile {
    pub host: String,
    pub user: String,
    /// File path relative to the project folder.
    pub file: String,
}

/// Agent id of a tile that runs a command built by `tile_command`.
pub const UPLOAD_AGENT: &str = "upload";

pub fn valid_host(s: &str) -> bool {
    (1..=253).contains(&s.len())
        && s.starts_with(|c: char| c.is_ascii_alphanumeric())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

pub fn valid_user(s: &str) -> bool {
    (1..=32).contains(&s.len())
        && !s.starts_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// An empty key (ssh's own defaults) is fine; otherwise a plain full path,
/// from `/` or `~/` (ssh would look for a relative one in the tile's folder).
pub fn valid_key(s: &str) -> bool {
    s.is_empty()
        || ((s.starts_with('/') || s.starts_with("~/"))
            && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '~')))
}

/// `~/x` becomes `<home>/x`; anything else stays as it is.
pub fn expand_key(key: &str, home: &Path) -> PathBuf {
    match key.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(key),
    }
}

/// The file `rel` inside `dir`, canonical. Refuses a path (or a symlink)
/// that leads outside `dir`, and anything that is not a regular file.
pub fn resolve_file(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let bad = || tr!("nieprawidłowy plik", "invalid file").to_string();
    let root = dir.canonicalize().map_err(|_| bad())?;
    let file = dir.join(rel).canonicalize().map_err(|_| bad())?;
    if !file.starts_with(&root) {
        return Err(tr!("plik jest poza projektem", "the file is outside the project").into());
    }
    if !file.is_file() {
        return Err(tr!("to nie jest plik", "not a regular file").into());
    }
    Ok(file)
}

/// What the confirmation shows of a project file: its size and the name it
/// gets in the server's home folder (the canonical file's, so a symlink's target).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UploadFile {
    pub size: u64,
    pub name: String,
}

/// The file `rel` of `dir` as the upload would send it, refused like `resolve_file`.
pub fn file_info(dir: &Path, rel: &str) -> Result<UploadFile, String> {
    let file = resolve_file(dir, rel)?;
    let size = std::fs::metadata(&file).map_err(|e| e.to_string())?.len();
    let name = file
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| tr!("nieprawidłowy plik", "invalid file").to_string())?
        .to_string();
    Ok(UploadFile { size, name })
}

/// Whether an upload tile with no live session may start its command. It
/// starts only from a click confirmed in the Upload panel.
pub fn may_start(start: bool) -> Result<(), String> {
    if start {
        Ok(())
    } else {
        Err(tr!("Wyślij ponownie z panelu Wysyłka.", "Send again from the Upload panel.").into())
    }
}

/// The rsync command line of an upload tile. Only a saved server row and a
/// file inside the project get in, each part single-quoted. No host-key or
/// batch options: the person answers the host-key question in the tile.
pub fn tile_command(
    tile: &UploadTile,
    hosts: &[UploadHost],
    dir: &Path,
    home: &Path,
) -> Result<String, String> {
    use crate::tmux::shell_quote;
    let h = hosts
        .iter()
        .find(|h| h.host == tile.host && h.user == tile.user)
        .ok_or_else(|| tr!("nieznany serwer wysyłki", "unknown upload server").to_string())?;
    if !valid_host(&h.host) {
        return Err(tr!("nieprawidłowa nazwa serwera", "invalid server name").into());
    }
    if !valid_user(&h.user) {
        return Err(tr!("nieprawidłowy użytkownik", "invalid user").into());
    }
    if !valid_key(&h.key) {
        return Err(tr!("nieprawidłowa ścieżka klucza", "invalid key path").into());
    }
    let mut ssh = String::new();
    if !h.key.is_empty() {
        let key = expand_key(&h.key, home);
        let key = key.to_str().filter(|k| valid_key(k)).ok_or_else(|| {
            tr!(
                "ścieżka klucza ma niedozwolone znaki (np. spację)",
                "the key path has characters that are not allowed (e.g. a space)"
            )
            .to_string()
        })?;
        ssh.push_str(&format!("-i {key} -o IdentitiesOnly=yes "));
    }
    ssh.push_str("-o PasswordAuthentication=no -o KbdInteractiveAuthentication=no");
    let file = resolve_file(dir, &tile.file)?;
    let file = file
        .to_str()
        .ok_or_else(|| tr!("nieprawidłowy plik", "invalid file").to_string())?;
    let target = shell_quote(&format!("{}@{}:", h.user, h.host));
    // The ssh options hold only checked characters (no spaces in the key path),
    // so scp may take them as they are.
    Ok(match h.method {
        Method::Rsync => format!(
            "rsync -z --partial --progress -e {} -- {} {target}",
            shell_quote(&format!("ssh {ssh}")),
            shell_quote(file),
        ),
        Method::Scp => format!("scp {ssh} -- {} {target}", shell_quote(file)),
    })
}

/// Server names worth suggesting from an `/etc/hosts` text: in file order,
/// without duplicates, loopback and local-only names, or comments.
pub fn parse_etc_hosts(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or_default();
        for name in line.split_whitespace().skip(1) {
            let skip = name == "localhost"
                || name.starts_with("ip6-")
                || [".loc", ".local", ".internal"].iter().any(|s| name.ends_with(s));
            if !skip && valid_host(name) && !out.iter().any(|n| n == name) {
                out.push(name.to_string());
            }
        }
    }
    out
}

/// Names from `/etc/hosts` for the server form (none on Windows).
#[cfg(not(windows))]
pub fn suggestions() -> Vec<String> {
    std::fs::read_to_string("/etc/hosts").map(|t| parse_etc_hosts(&t)).unwrap_or_default()
}

#[cfg(windows)]
pub fn suggestions() -> Vec<String> {
    Vec::new()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct UploadTools {
    pub rsync: bool,
    pub scp: bool,
    pub ssh: bool,
}

pub fn tools() -> UploadTools {
    UploadTools {
        rsync: crate::agents::which("rsync").is_some(),
        scp: crate::agents::which("scp").is_some(),
        ssh: crate::agents::which("ssh").is_some(),
    }
}

/// rsync by its process name: `rsync`, macOS's `openrsync`, or a build
/// named after it (`rsync_samba`).
pub fn is_transfer(name: &str) -> bool {
    name == "openrsync" || name == "scp" || name.starts_with("rsync")
}

/// True when a process whose name `is` matches runs in the trees under
/// `roots` (the roots included), e.g. rsync inside an upload tile's shell.
/// An empty process table (ps failed) reads as not running.
pub fn runs_in(roots: &[u32], table: &[crate::thermal::Proc], is: impl Fn(&str) -> bool) -> bool {
    let live = crate::thermal::descendants(roots, table);
    table.iter().any(|p| is(&p.name) && live.contains(&p.pid))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::tmux::shell_quote;

    #[cfg(unix)]
    const SSH_OFF: &str = "-o PasswordAuthentication=no -o KbdInteractiveAuthentication=no";

    fn hosts() -> Vec<UploadHost> {
        vec![UploadHost { host: "example-dev".into(), user: "deploy".into(), key: "~/.ssh/server.key".into(), ..Default::default() }]
    }
    fn tile(file: &str) -> UploadTile {
        UploadTile { host: "example-dev".into(), user: "deploy".into(), file: file.into() }
    }
    fn project() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("dumps")).unwrap();
        std::fs::write(tmp.path().join("dumps/a.sql"), "x").unwrap();
        tmp
    }
    #[cfg(unix)]
    fn canon(tmp: &tempfile::TempDir) -> String {
        tmp.path().canonicalize().unwrap().to_str().unwrap().to_string()
    }

    // POSIX paths (`/home/u`, `/` separators): the panel and its commands
    // exist only on macOS and Linux; Windows has no rsync (see the spec).
    #[test]
    #[cfg(unix)]
    fn builds_command_with_key() {
        let tmp = project();
        let cmd = tile_command(&tile("dumps/a.sql"), &hosts(), tmp.path(), Path::new("/home/u")).unwrap();
        assert_eq!(
            cmd,
            format!(
                "rsync -z --partial --progress -e 'ssh -i /home/u/.ssh/server.key -o IdentitiesOnly=yes {SSH_OFF}' -- '{}/dumps/a.sql' 'deploy@example-dev:'",
                canon(&tmp)
            )
        );
    }

    // POSIX paths (`/home/u`, `/` separators): the panel and its commands
    // exist only on macOS and Linux; Windows has no rsync (see the spec).
    #[test]
    #[cfg(unix)]
    fn builds_scp_command() {
        let tmp = project();
        let mut h = hosts();
        h[0].method = Method::Scp;
        let cmd = tile_command(&tile("dumps/a.sql"), &h, tmp.path(), Path::new("/home/u")).unwrap();
        assert_eq!(
            cmd,
            format!(
                "scp -i /home/u/.ssh/server.key -o IdentitiesOnly=yes {SSH_OFF} -- '{}/dumps/a.sql' 'deploy@example-dev:'",
                canon(&tmp)
            )
        );
        h[0].key = String::new();
        let cmd = tile_command(&tile("dumps/a.sql"), &h, tmp.path(), Path::new("/home/u")).unwrap();
        assert_eq!(cmd, format!("scp {SSH_OFF} -- '{}/dumps/a.sql' 'deploy@example-dev:'", canon(&tmp)));
    }

    #[test]
    fn method_defaults_to_rsync_and_reads_scp() {
        let old: UploadHost = serde_json::from_str(r#"{"host":"example-dev","user":"deploy","key":""}"#).unwrap();
        assert_eq!(old.method, Method::Rsync);
        let scp: UploadHost = serde_json::from_str(r#"{"host":"example-dev","user":"deploy","key":"","method":"scp"}"#).unwrap();
        assert_eq!(scp.method, Method::Scp);
    }

    // POSIX paths (`/home/u`, `/` separators): the panel and its commands
    // exist only on macOS and Linux; Windows has no rsync (see the spec).
    #[test]
    #[cfg(unix)]
    fn builds_command_without_key() {
        let tmp = project();
        let mut h = hosts();
        h[0].key = String::new();
        let cmd = tile_command(&tile("dumps/a.sql"), &h, tmp.path(), Path::new("/home/u")).unwrap();
        assert_eq!(
            cmd,
            format!(
                "rsync -z --partial --progress -e 'ssh {SSH_OFF}' -- '{}/dumps/a.sql' 'deploy@example-dev:'",
                canon(&tmp)
            )
        );
    }

    // POSIX paths (`/home/u`, `/` separators): the panel and its commands
    // exist only on macOS and Linux; Windows has no rsync (see the spec).
    #[test]
    #[cfg(unix)]
    fn quotes_odd_file_names() {
        let tmp = project();
        let name = "dump 2024 'old'$x.sql";
        std::fs::write(tmp.path().join(name), "x").unwrap();
        let cmd = tile_command(&tile(name), &hosts(), tmp.path(), Path::new("/home/u")).unwrap();
        let quoted = shell_quote(&format!("{}/{name}", canon(&tmp)));
        assert_eq!(cmd.matches(&quoted).count(), 1, "{cmd}");
        assert!(cmd.starts_with("rsync -z"));
    }

    #[test]
    fn refuses_unknown_host_or_user() {
        let tmp = project();
        let home = Path::new("/home/u");
        let mut t = tile("dumps/a.sql");
        t.user = "root".into();
        assert!(tile_command(&t, &hosts(), tmp.path(), home).is_err());
        let mut t = tile("dumps/a.sql");
        t.host = "other".into();
        assert!(tile_command(&t, &hosts(), tmp.path(), home).is_err());
    }

    #[test]
    fn refuses_file_outside_project() {
        let tmp = project();
        let outside = tempfile::tempdir().unwrap();
        let out_file = outside.path().join("secret.sql");
        std::fs::write(&out_file, "x").unwrap();
        let home = Path::new("/home/u");
        assert!(tile_command(&tile("../x"), &hosts(), tmp.path(), home).is_err());
        assert!(tile_command(&tile("/etc/hosts"), &hosts(), tmp.path(), home).is_err());
        assert!(resolve_file(tmp.path(), "/etc/hosts").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&out_file, tmp.path().join("dumps/l")).unwrap();
            assert!(tile_command(&tile("dumps/l"), &hosts(), tmp.path(), home).is_err());
        }
    }

    #[test]
    fn refuses_folder_and_missing_file() {
        let tmp = project();
        let home = Path::new("/home/u");
        assert!(tile_command(&tile("dumps"), &hosts(), tmp.path(), home).is_err());
        assert!(tile_command(&tile("dumps/none.sql"), &hosts(), tmp.path(), home).is_err());
    }

    // POSIX paths (`/home/u`, `/` separators): the panel and its commands
    // exist only on macOS and Linux; Windows has no rsync (see the spec).
    #[test]
    #[cfg(unix)]
    fn refuses_bad_parts() {
        let tmp = project();
        let home = Path::new("/home/u");
        let row = |host: &str, user: &str, key: &str| {
            let h = vec![UploadHost { host: host.into(), user: user.into(), key: key.into(), ..Default::default() }];
            let t = UploadTile { host: host.into(), user: user.into(), file: "dumps/a.sql".into() };
            tile_command(&t, &h, tmp.path(), home)
        };
        assert!(row("a;b", "deploy", "").is_err());
        assert!(row("example", "-oProxy", "").is_err());
        assert!(row("example", "deploy", "~/k'ey").is_err());
        let t = UploadTile { host: "example".into(), user: "deploy".into(), file: "dumps/a.sql".into() };
        let h = vec![UploadHost { host: "example".into(), user: "deploy".into(), key: "~/.ssh/k".into(), ..Default::default() }];
        assert!(tile_command(&t, &h, tmp.path(), Path::new("/home/jan kowalski")).is_err());
        assert!(row("example", "deploy", "~/.ssh/k").is_ok());
        assert!(row("example", "deploy", "/keys/id").is_ok());
        // ssh would look for a relative key in the tile's folder; `~user/` is not expanded.
        assert!(row("example", "deploy", "id.key").is_err());
        assert!(row("example", "deploy", "~user/id").is_err());
    }

    #[test]
    fn valid_key_wants_a_full_path() {
        assert!(valid_key(""));
        assert!(valid_key("~/keys/id"));
        assert!(valid_key("/keys/id"));
        for bad in ["id.key", "keys/id", "~user/id", "~", "-i", "~/k'ey", "/a b"] {
            assert!(!valid_key(bad), "{bad}");
        }
    }

    #[test]
    fn file_info_gives_size_and_the_canonical_name() {
        let tmp = project();
        let info = file_info(tmp.path(), "dumps/a.sql").unwrap();
        assert_eq!(info, UploadFile { size: 1, name: "a.sql".into() });
        #[cfg(unix)]
        {
            std::fs::write(tmp.path().join("dumps/2024-11-19.sql"), "xyz").unwrap();
            std::os::unix::fs::symlink(tmp.path().join("dumps/2024-11-19.sql"), tmp.path().join("dumps/latest.sql")).unwrap();
            let info = file_info(tmp.path(), "dumps/latest.sql").unwrap();
            assert_eq!(info, UploadFile { size: 3, name: "2024-11-19.sql".into() });
        }
        assert!(file_info(tmp.path(), "../x").is_err());
        assert!(file_info(tmp.path(), "dumps").is_err());
    }

    #[test]
    fn upload_never_starts_unconfirmed() {
        assert!(may_start(false).is_err());
        assert!(may_start(true).is_ok());
    }

    #[test]
    fn parses_etc_hosts() {
        let text = "127.0.0.1 localhost\n::1 ip6-localhost ip6-loopback\n# c\n10.0.0.5 example-dev example-dev\n10.0.0.6 example-prod # x\n127.0.0.1 app.loc app.local kubernetes.docker.internal\n";
        assert_eq!(parse_etc_hosts(text), vec!["example-dev", "example-prod"]);
    }

    fn proc(pid: u32, parent: u32, name: &str) -> crate::thermal::Proc {
        crate::thermal::Proc { pid, parent, name: name.into(), tty: None, group: None, stopped: false }
    }

    #[test]
    fn runs_in_finds_child_and_grandchild() {
        let table = vec![
            proc(1010, 1, "bash"),
            proc(1011, 1010, "rsync"),
            proc(1012, 1011, "ssh"),
            proc(1020, 1, "rsync"),
        ];
        assert!(runs_in(&[1010], &table, is_transfer));
        assert!(runs_in(&[1010], &table, |n| n == "ssh"));
        assert!(!runs_in(&[1030], &table, is_transfer));
    }

    #[test]
    fn runs_in_ignores_other_trees() {
        let table = vec![proc(1010, 1, "bash"), proc(1020, 1, "rsync")];
        assert!(!runs_in(&[1010], &table, is_transfer));
    }

    #[test]
    fn runs_in_false_after_rsync_exits() {
        let table = vec![proc(1010, 1, "bash")];
        assert!(!runs_in(&[1010], &table, is_transfer));
        // No process table (ps failed): read as not running.
        assert!(!runs_in(&[1010], &[], is_transfer));
    }

    #[test]
    fn runs_in_knows_macos_openrsync() {
        let table = vec![proc(1010, 1, "zsh"), proc(1011, 1010, "openrsync"), proc(1012, 1011, "ssh")];
        assert!(runs_in(&[1010], &table, is_transfer));
        let table = vec![proc(1010, 1, "zsh"), proc(1011, 1010, "rsync_samba")];
        assert!(runs_in(&[1010], &table, is_transfer));
    }

    #[test]
    fn is_transfer_names() {
        for name in ["rsync", "openrsync", "rsync_samba", "scp"] {
            assert!(is_transfer(name), "{name}");
        }
        for name in ["ssh", "zsh", "xrsync", "open"] {
            assert!(!is_transfer(name), "{name}");
        }
    }
}
