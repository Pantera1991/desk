//! Docker panel backend: reads containers, images, networks and volumes of
//! the saved Docker servers through the `docker` CLI (`-H <url>`), and
//! removes an image.

use serde::{Deserialize, Serialize};
use crate::proc::run;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerHost {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerTile {
    pub host: String,
    pub target: String,
    pub kind: DockerTileKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DockerTileKind {
    Logs,
    ProjectLogs,
    Shell,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub project: Option<String>,
    pub service: Option<String>,
    /// Folder the compose project was started from (compose label).
    pub working_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size: String,
    pub created: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Named {
    pub name: String,
    pub driver: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostView {
    pub name: String,
    pub url: String,
    pub error: Option<String>,
    pub containers: Vec<Container>,
    pub images: Vec<Image>,
    pub networks: Vec<Named>,
    pub volumes: Vec<Named>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// The `docker` program was found in PATH.
    pub cli: bool,
    /// `docker compose` works locally.
    pub compose: bool,
    pub hosts: Vec<HostView>,
}

const TIMEOUT: Duration = Duration::from_secs(3);
const COMPOSE_PROJECT: &str = "com.docker.compose.project";
const COMPOSE_SERVICE: &str = "com.docker.compose.service";
const COMPOSE_WORKING_DIR: &str = "com.docker.compose.project.working_dir";

/// One JSON object per non-blank line; lines that are not JSON are skipped.
fn json_lines(stdout: &str) -> impl Iterator<Item = serde_json::Value> + '_ {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
}

fn field(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or_default().to_string()
}

/// Value of a label in docker's `k=v,k=v` list (values may hold `=`).
fn label(labels: &str, key: &str) -> Option<String> {
    labels
        .split(',')
        .find_map(|kv| kv.strip_prefix(key)?.strip_prefix('='))
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

pub fn parse_containers(stdout: &str) -> Vec<Container> {
    json_lines(stdout)
        .map(|v| {
            let labels = field(&v, "Labels");
            Container {
                id: field(&v, "ID"),
                name: field(&v, "Names"),
                image: field(&v, "Image"),
                state: field(&v, "State"),
                status: field(&v, "Status"),
                project: label(&labels, COMPOSE_PROJECT),
                service: label(&labels, COMPOSE_SERVICE),
                working_dir: label(&labels, COMPOSE_WORKING_DIR),
            }
        })
        .collect()
}

pub fn parse_images(stdout: &str) -> Vec<Image> {
    json_lines(stdout)
        .map(|v| Image {
            id: field(&v, "ID"),
            repository: field(&v, "Repository"),
            tag: field(&v, "Tag"),
            size: field(&v, "Size"),
            created: field(&v, "CreatedSince"),
        })
        .collect()
}

pub fn parse_named(stdout: &str) -> Vec<Named> {
    json_lines(stdout)
        .map(|v| Named { name: field(&v, "Name"), driver: field(&v, "Driver") })
        .collect()
}

/// `tcp://host:port` or `unix:///path`; a strict charset, so quoting never
/// meets a metacharacter in POSIX sh or PowerShell.
pub fn valid_url(url: &str) -> bool {
    let rest = url.strip_prefix("tcp://").or_else(|| url.strip_prefix("unix://"));
    rest.is_some_and(|r| !r.is_empty() && r.chars().all(|c| c.is_ascii_alphanumeric() || ".:/_-[]@%".contains(c)))
}

/// Container, project or service name: no leading dash, no shell characters.
pub fn valid_name(s: &str) -> bool {
    !s.starts_with(['-', '.', '_'])
        && !s.is_empty()
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Image reference or id: `repo/name:tag`, `name@sha256:...`, `sha256:...`.
pub fn valid_image(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':' | '@'))
}

fn list(docker: &Path, url: &str, args: &[&str]) -> Result<String, String> {
    let mut full = vec!["-H", url];
    full.extend_from_slice(args);
    full.extend_from_slice(&["--format", "{{json .}}"]);
    run(docker, &full, TIMEOUT)
}

fn host_view(docker: &Path, host: &DockerHost) -> HostView {
    let mut v = HostView {
        name: host.name.clone(),
        url: host.url.clone(),
        error: None,
        containers: Vec::new(),
        images: Vec::new(),
        networks: Vec::new(),
        volumes: Vec::new(),
    };
    if !valid_url(&host.url) {
        v.error = Some(tr!("nieprawidłowy adres serwera", "invalid server address").into());
        return v;
    }
    let fetch = || -> Result<_, String> {
        Ok((
            parse_containers(&list(docker, &host.url, &["ps", "-a"])?),
            parse_images(&list(docker, &host.url, &["image", "ls"])?),
            parse_named(&list(docker, &host.url, &["network", "ls"])?),
            parse_named(&list(docker, &host.url, &["volume", "ls"])?),
        ))
    };
    match fetch() {
        Ok((c, i, n, vol)) => (v.containers, v.images, v.networks, v.volumes) = (c, i, n, vol),
        Err(e) => v.error = Some(e),
    }
    v
}

pub fn overview(hosts: &[DockerHost]) -> Overview {
    overview_with(crate::agents::which("docker").as_deref(), hosts)
}

fn overview_with(docker: Option<&Path>, hosts: &[DockerHost]) -> Overview {
    let Some(docker) = docker else {
        return Overview { cli: false, compose: false, hosts: Vec::new() };
    };
    let compose = run(docker, &["compose", "version"], TIMEOUT).is_ok();
    let views = std::thread::scope(|s| {
        let handles: Vec<_> = hosts.iter().map(|h| s.spawn(move || host_view(docker, h))).collect();
        handles.into_iter().map(|h| h.join().expect("docker host thread")).collect()
    });
    Overview { cli: true, compose, hosts: views }
}

pub fn image_rm(hosts: &[DockerHost], host: &str, image: &str) -> Result<(), String> {
    let h = hosts
        .iter()
        .find(|h| h.name == host)
        .ok_or_else(|| tr!("nieznany serwer Dockera", "unknown Docker server").to_string())?;
    if !valid_url(&h.url) {
        return Err(tr!("nieprawidłowy adres serwera", "invalid server address").into());
    }
    if !valid_image(image) {
        return Err(tr!("nieprawidłowa nazwa obrazu", "invalid image name").into());
    }
    let docker = crate::agents::which("docker")
        .ok_or_else(|| tr!("brak programu docker", "docker is not installed").to_string())?;
    run(&docker, &["-H", &h.url, "image", "rm", image], Duration::from_secs(30)).map(|_| ())
}

pub fn restart(hosts: &[DockerHost], host: &str, container: &str) -> Result<(), String> {
    let h = hosts
        .iter()
        .find(|h| h.name == host)
        .ok_or_else(|| tr!("nieznany serwer Dockera", "unknown Docker server").to_string())?;
    if !valid_url(&h.url) {
        return Err(tr!("nieprawidłowy adres serwera", "invalid server address").into());
    }
    if !valid_name(container) {
        return Err(tr!("nieprawidłowa nazwa", "invalid name").into());
    }
    let docker = crate::agents::which("docker")
        .ok_or_else(|| tr!("brak programu docker", "docker is not installed").to_string())?;
    run(&docker, &["-H", &h.url, "restart", container], Duration::from_secs(30)).map(|_| ())
}

/// Agent id of a tile that runs a `docker` command built by `tile_command`.
pub const DOCKER_AGENT: &str = "docker";

/// The command line of a Docker tile. Only a saved server and validated names
/// get in, each single-quoted, so a stored layout cannot inject a command.
pub fn tile_command(tile: &DockerTile, hosts: &[DockerHost]) -> Result<String, String> {
    use crate::tmux::shell_quote;
    let h = hosts
        .iter()
        .find(|h| h.name == tile.host)
        .ok_or_else(|| tr!("nieznany serwer Dockera", "unknown Docker server").to_string())?;
    if !valid_url(&h.url) {
        return Err(tr!("nieprawidłowy adres serwera", "invalid server address").into());
    }
    if !valid_name(&tile.target) {
        return Err(tr!("nieprawidłowa nazwa", "invalid name").into());
    }
    let head = format!("docker -H {}", shell_quote(&h.url));
    let target = shell_quote(&tile.target);
    Ok(match tile.kind {
        DockerTileKind::Logs => format!("{head} logs -f --tail 500 {target}"),
        DockerTileKind::ProjectLogs => format!("{head} compose -p {target} logs -f --tail 200"),
        DockerTileKind::Shell => format!(
            "{head} exec -it {target} sh -c 'command -v bash >/dev/null && exec bash || exec sh'"
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> Vec<DockerHost> {
        vec![DockerHost { name: "Docker1".into(), url: "tcp://192.0.2.10:2375".into() }]
    }
    fn tile(target: &str, kind: DockerTileKind) -> DockerTile {
        DockerTile { host: "Docker1".into(), target: target.into(), kind }
    }

    #[test]
    fn builds_logs_command() {
        assert_eq!(
            tile_command(&tile("web-app-1", DockerTileKind::Logs), &host()).unwrap(),
            "docker -H 'tcp://192.0.2.10:2375' logs -f --tail 500 'web-app-1'"
        );
    }

    #[test]
    fn builds_project_logs_command() {
        assert_eq!(
            tile_command(&tile("web", DockerTileKind::ProjectLogs), &host()).unwrap(),
            "docker -H 'tcp://192.0.2.10:2375' compose -p 'web' logs -f --tail 200"
        );
    }

    #[test]
    fn builds_shell_command() {
        assert_eq!(
            tile_command(&tile("web-app-1", DockerTileKind::Shell), &host()).unwrap(),
            "docker -H 'tcp://192.0.2.10:2375' exec -it 'web-app-1' sh -c 'command -v bash >/dev/null && exec bash || exec sh'"
        );
    }

    #[test]
    fn refuses_unknown_host() {
        let mut t = tile("web", DockerTileKind::Logs);
        t.host = "Other".into();
        assert!(tile_command(&t, &host()).is_err());
    }

    #[test]
    fn refuses_bad_target() {
        assert!(tile_command(&tile("x; rm -rf ~", DockerTileKind::Logs), &host()).is_err());
    }

    #[test]
    fn refuses_invalid_stored_url() {
        let hosts = vec![DockerHost { name: "Docker1".into(), url: "tcp://a b; rm".into() }];
        assert!(tile_command(&tile("web", DockerTileKind::Logs), &hosts).is_err());
        for url in ["tcp://x';calc;'", "tcp://a$b", "tcp://a`b", "http://192.0.2.10:2375"] {
            let hosts = vec![DockerHost { name: "Docker1".into(), url: url.into() }];
            assert!(tile_command(&tile("web", DockerTileKind::Logs), &hosts).is_err(), "{url}");
        }
    }

    #[test]
    fn parses_ps_lines() {
        let out = r#"{"ID":"a1","Names":"web-app-1","Image":"web:1","State":"running","Status":"Up 2 hours","Labels":"com.docker.compose.project=web,com.docker.compose.service=app"}

not json
{"ID":"b2","Names":"redis","Image":"redis","State":"exited","Status":"Exited (0)","Labels":""}
"#;
        let c = parse_containers(out);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].id, "a1");
        assert_eq!(c[0].name, "web-app-1");
        assert_eq!(c[0].image, "web:1");
        assert_eq!(c[0].state, "running");
        assert_eq!(c[0].status, "Up 2 hours");
        assert_eq!(c[0].project.as_deref(), Some("web"));
        assert_eq!(c[0].service.as_deref(), Some("app"));
        assert_eq!(c[1].project, None);
        assert_eq!(c[1].service, None);
    }

    #[test]
    fn parses_labels_with_odd_values() {
        let out = r#"{"ID":"a","Names":"n","Image":"i","State":"running","Status":"Up","Labels":"a=b=c,com.docker.compose.project=mm-back,x="}"#;
        assert_eq!(parse_containers(out)[0].project.as_deref(), Some("mm-back"));
    }

    #[test]
    fn parses_images_networks_volumes() {
        let imgs = parse_images(
            r#"{"ID":"sha256:1","Repository":"web","Tag":"latest","Size":"412MB","CreatedSince":"3 days ago"}
{"ID":"sha256:2","Repository":"<none>","Tag":"<none>","Size":"1MB","CreatedSince":"1 week ago"}"#,
        );
        assert_eq!(imgs.len(), 2);
        assert_eq!(imgs[0].repository, "web");
        assert_eq!(imgs[0].tag, "latest");
        assert_eq!(imgs[0].size, "412MB");
        assert_eq!(imgs[0].created, "3 days ago");
        assert_eq!(imgs[1].repository, "<none>");
        assert_eq!(imgs[1].tag, "<none>");
        let n = parse_named(r#"{"Name":"bridge","Driver":"bridge"}
{"Name":"data","Driver":"local"}"#);
        assert_eq!(n, vec![
            Named { name: "bridge".into(), driver: "bridge".into() },
            Named { name: "data".into(), driver: "local".into() },
        ]);
    }

    #[test]
    fn validates_inputs() {
        assert!(valid_url("tcp://192.0.2.10:2375"));
        assert!(valid_url("unix:///var/run/docker.sock"));
        assert!(!valid_url("http://x"));
        assert!(!valid_url("tcp://"));
        assert!(!valid_url("tcp://a b"));
        assert!(valid_url("tcp://[::1]:2375"));
        for bad in ["tcp://x';calc;'", "tcp://a$b", "tcp://a`b", "http://192.0.2.10:2375"] {
            assert!(!valid_url(bad), "{bad:?}");
        }
        assert!(valid_name("web-app_1.x"));
        for bad in ["", "-x", "a;b", "a b"] {
            assert!(!valid_name(bad), "{bad:?}");
        }
        assert!(valid_image("mm/web:1.4"));
        assert!(valid_image("sha256:ab12"));
        assert!(!valid_image("x;y"));
    }

    fn hosts() -> Vec<DockerHost> {
        vec![DockerHost { name: "Docker1".into(), url: "tcp://192.0.2.10:2375".into() }]
    }

    #[test]
    fn overview_without_docker_cli() {
        let o = overview_with(None, &hosts());
        assert!(!o.cli);
        assert!(!o.compose);
        assert!(o.hosts.is_empty());
    }

    #[test]
    fn image_rm_rejects_unknown_host_and_bad_image() {
        assert!(image_rm(&hosts(), "nope", "x").is_err());
        assert!(image_rm(&hosts(), "Docker1", "x;y").is_err());
    }

    #[test]
    fn parses_working_dir_label() {
        let out = r#"{"ID":"a","Names":"n","Image":"i","State":"running","Status":"Up","Labels":"com.docker.compose.project=mm,com.docker.compose.project.working_dir=/home/u/PhpstormProjects/mm-general"}
{"ID":"b","Names":"m","Image":"i","State":"running","Status":"Up","Labels":"com.docker.compose.project=mm"}"#;
        let c = parse_containers(out);
        assert_eq!(c[0].working_dir.as_deref(), Some("/home/u/PhpstormProjects/mm-general"));
        assert_eq!(c[0].project.as_deref(), Some("mm"));
        assert_eq!(c[1].working_dir, None);
    }

    #[test]
    fn restart_rejects_unknown_host_and_bad_name() {
        assert!(restart(&hosts(), "nope", "web").is_err());
        assert!(restart(&hosts(), "Docker1", "a;b").is_err());
        assert!(restart(&hosts(), "Docker1", "-x").is_err());
    }
}
