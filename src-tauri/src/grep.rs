//! Find in Files: the lines of the project's files that match a query, with
//! the matches marked for highlighting. `git grep` in a repository, else a
//! walk over the files `project::files` lists.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct GrepOptions {
    pub case: bool,
    pub word: bool,
    pub regex: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrepHit {
    pub file: String,
    pub line: u32,
    pub text: String,
    /// UTF-16 `[start, end)` ranges in `text`.
    pub marks: Vec<[u32; 2]>,
    /// UTF-16 units of the line cut off before `text` (0 when not cut; else
    /// `text` starts with "…"), so a mark's place in the whole line is
    /// `mark - 1 + cut`.
    pub cut: u32,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GrepResult {
    pub hits: Vec<GrepHit>,
    pub files: u32,
    pub more: bool,
}

/// At most this many hits in one file, and in all.
const PER_FILE: usize = 50;
const TOTAL: usize = 500;
/// A longer line is cut to this many UTF-16 units around its first match,
/// keeping up to `BEFORE` of them ahead of it.
const LINE_MAX: usize = 200;
const BEFORE: usize = 60;
/// Files the walk skips: bigger than this, or with a NUL this early.
const MAX_SIZE: u64 = 1024 * 1024;
const BINARY_PROBE: usize = 8 * 1024;
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// A hit before marking: file, line number, the whole line.
type Raw = (String, u32, String);

/// Lines of the files under `root` that match `query`: in a repository
/// `git grep` (untracked files too, ignored ones not), else the files of
/// [`crate::project::files`]. An empty query, or one with a NUL (no text
/// line has one), finds nothing.
pub fn grep(root: &Path, query: &str, opts: GrepOptions) -> Result<GrepResult, String> {
    if query.is_empty() || query.contains('\0') {
        return Ok(GrepResult::default());
    }
    let re = pattern(query, opts)?;
    let (hits, cut) = match git_grep(root, query, opts)? {
        Some(found) => found,
        None => walk_with_deadline(root, &re, std::time::Instant::now() + TIMEOUT),
    };
    finish(hits, cut, &re)
}

/// The result from up to `TOTAL + 1` raw hits; `cut` when the search
/// stopped early (its deadline), so there may be more. Cut before any hit,
/// the search took too long: nothing found would not be true.
fn finish(mut hits: Vec<Raw>, cut: bool, re: &Matcher) -> Result<GrepResult, String> {
    if cut && hits.is_empty() {
        return Err(too_long());
    }
    let more = cut || hits.len() > TOTAL;
    hits.truncate(TOTAL);
    let hits: Vec<GrepHit> = hits
        .into_iter()
        .map(|(file, line, raw)| {
            let (text, marks, cut) = marked_line(&raw, re);
            GrepHit { file, line, text, marks, cut }
        })
        .collect();
    // Both git and the walk give a file's hits together, so dedup counts files.
    let mut files: Vec<&str> = hits.iter().map(|h| h.file.as_str()).collect();
    files.dedup();
    Ok(GrepResult {
        files: files.len() as u32,
        hits,
        more,
    })
}

/// Finds the matches of a query in a line, as the search does.
pub struct Matcher {
    re: regex::Regex,
    /// Whole words only, as `git grep -w`.
    word: bool,
}

impl Matcher {
    /// The matches in `line`; for `word` only those with no word character
    /// right before or after them (so `$pre` and `->pre(` work, unlike `\b`).
    pub fn find_iter<'a>(&'a self, line: &'a str) -> impl Iterator<Item = regex::Match<'a>> + 'a {
        let is_word = |c: char| c.is_alphanumeric() || c == '_';
        self.re.find_iter(line).filter(move |m| {
            !self.word
                || (!line[..m.start()].chars().next_back().is_some_and(is_word)
                    && !line[m.end()..].chars().next().is_some_and(is_word))
        })
    }

    pub fn is_match(&self, line: &str) -> bool {
        self.find_iter(line).next().is_some()
    }
}

/// What marks matches in a line, from the same options as the search: text
/// escaped unless `regex`, `(?i)` unless `case`, whole words for `word`.
pub fn pattern(query: &str, opts: GrepOptions) -> Result<Matcher, String> {
    let mut p = if opts.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    if !opts.case {
        p = format!("(?i){p}");
    }
    let re = regex::Regex::new(&p).map_err(|e| tr!(format!("zły regex: {e}"), format!("bad regex: {e}")))?;
    Ok(Matcher { re, word: opts.word })
}

/// The line as shown (a long one cut around its first match, with "…"),
/// every non-empty match in it as UTF-16 `[start, end)`, and the UTF-16
/// units cut off before it.
pub fn marked_line(line: &str, re: &Matcher) -> (String, Vec<[u32; 2]>, u32) {
    let line = line.trim_end_matches(['\r', '\n']);
    let (from, to) = if line.encode_utf16().count() <= LINE_MAX {
        (0, line.len())
    } else {
        window(line, re.find_iter(line).next().map_or(0, |m| m.start()))
    };
    let mut text = String::new();
    if from > 0 {
        text.push('…');
    }
    // UTF-16 offset of byte `at` (moving forward only) in `text`.
    let lead = text.encode_utf16().count();
    let (mut at, mut units) = (from, lead);
    let mut offset = |byte: usize| {
        units += line[at..byte].encode_utf16().count();
        at = byte;
        units as u32
    };
    // Matched on the whole line, so a cut never makes a whole-word match; a
    // match running past a cut is clipped to it.
    let marks = re
        .find_iter(line)
        .take_while(|m| m.start() < to)
        .filter(|m| !m.is_empty() && m.end() > from)
        .map(|m| [offset(m.start().max(from)), offset(m.end().min(to))])
        .collect();
    text.push_str(&line[from..to]);
    if to < line.len() {
        text.push('…');
    }
    let cut = line[..from].encode_utf16().count() as u32;
    (text, marks, cut)
}

/// Byte range of at most `LINE_MAX` UTF-16 units around byte `hit`: up to
/// `BEFORE` units ahead of it, more when the line ends sooner.
fn window(line: &str, hit: usize) -> (usize, usize) {
    let back = |end: usize, budget: usize| {
        let mut used = 0;
        let mut start = end;
        for (i, c) in line[..end].char_indices().rev() {
            used += c.len_utf16();
            if used > budget {
                break;
            }
            start = i;
        }
        (start, line[start..end].encode_utf16().count())
    };
    let (from, ahead) = back(hit, BEFORE);
    let mut used = ahead;
    let mut to = hit;
    for (i, c) in line[hit..].char_indices() {
        if used + c.len_utf16() > LINE_MAX {
            break;
        }
        used += c.len_utf16();
        to = hit + i + c.len_utf8();
    }
    if to == line.len() && used < LINE_MAX {
        // The line ends first: give the rest of the room to what comes before.
        let (from, _) = back(from, LINE_MAX - used);
        return (from, to);
    }
    (from, to)
}

/// Up to `TOTAL + 1` raw hits from `git grep` and whether its deadline cut
/// it short, or None when `root` is not in a repository (or there is no
/// git). git's output is read as it comes, and git is stopped once there
/// are enough hits or the deadline passes.
fn git_grep(root: &Path, query: &str, opts: GrepOptions) -> Result<Option<(Vec<Raw>, bool)>, String> {
    use std::io::{BufRead, Read};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    let max_count = format!("--max-count={PER_FILE}");
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args([
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        // The record format whatever the user's or the repository's config
        // (a column field; paths from the repository root). An older git
        // ignores keys it does not know.
        "-c",
        "grep.column=false",
        "-c",
        "grep.fullName=false",
        "grep",
        "-n",
        "-I",
        "--untracked",
        "--no-color",
        &max_count,
        // Paths as they are, NUL after the path and the line number: no
        // quoting of non-ASCII names and no confusion with a `:` in a name.
        "-z",
    ]);
    if !opts.case {
        cmd.arg("-i");
    }
    if opts.word {
        cmd.arg("-w");
    }
    cmd.arg(if opts.regex { "-E" } else { "-F" });
    // After -e the query is the pattern even when it starts with `-`.
    cmd.args(["-e", query]);
    let spawned = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let Ok(mut child) = spawned else {
        // No git to run: the walk.
        return Ok(None);
    };
    // stderr drained on a thread, so git never blocks on a full pipe.
    let mut stderr = child.stderr.take().expect("piped stderr");
    let err_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stderr.read_to_end(&mut b);
        b
    });
    let stdout = child.stdout.take().expect("piped stdout");
    let (tx, rx) = mpsc::channel();
    let out_t = std::thread::spawn(move || {
        // One record per `\n`: a file name containing a newline is not supported.
        let mut reader = std::io::BufReader::new(stdout);
        let mut buf = Vec::new();
        while matches!(reader.read_until(b'\n', &mut buf), Ok(n) if n > 0) {
            if let Some(raw) = parse_record(&String::from_utf8_lossy(&buf))
                && tx.send(raw).is_err()
            {
                break;
            }
            buf.clear();
        }
    });
    let deadline = std::time::Instant::now() + TIMEOUT;
    let mut hits = Vec::new();
    let mut timed_out = false;
    while hits.len() <= TOTAL {
        match rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
            Ok(raw) => hits.push(raw),
            // git closed its output: done.
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                timed_out = true;
                break;
            }
        }
    }
    let stopped = timed_out || hits.len() > TOTAL;
    if stopped {
        let _ = child.kill();
    }
    let status = child.wait();
    drop(rx);
    let _ = out_t.join();
    let err = String::from_utf8_lossy(&err_t.join().unwrap_or_default()).trim().to_string();
    if stopped {
        // Timed out before any hit: `finish` says it took too long.
        return Ok(Some((hits, timed_out)));
    }
    let code = status.ok().and_then(|s| s.code());
    match code {
        Some(0) => Ok(Some((hits, false))),
        // 1 with nothing on stderr: no match.
        Some(1) if err.is_empty() => Ok(Some((Vec::new(), false))),
        _ if !in_repo(root) => Ok(None),
        _ if !err.is_empty() => Err(err),
        Some(n) => Err(tr!(format!("git zakończył się kodem {n}"), format!("git exited with code {n}"))),
        None => Err(tr!("git został przerwany", "git was terminated").to_string()),
    }
}

fn in_repo(root: &Path) -> bool {
    let dir = root.to_string_lossy();
    let args = ["-C", &dir, "rev-parse", "--is-inside-work-tree"];
    crate::proc::run_status(Path::new("git"), &args, TIMEOUT)
        .is_ok_and(|(code, out, _)| code == 0 && out.trim() == "true")
}

fn too_long() -> String {
    tr!("szukanie trwało za długo", "search took too long").to_string()
}

/// One `path\0line\0text\n` record of `git grep -z -n` (older git:
/// `path\0line:text`).
fn parse_record(record: &str) -> Option<Raw> {
    let record = record.strip_suffix('\n').unwrap_or(record);
    let (file, rest) = record.split_once('\0')?;
    let digits = rest.find(|c: char| !c.is_ascii_digit())?;
    let line = rest[..digits].parse().ok()?;
    let text = rest[digits..].strip_prefix(['\0', ':'])?;
    Some((file.to_string(), line, text.to_string()))
}

/// The text of `rel`, a file inside `root`, for the read-only preview of a
/// hit: a regular file of at most `MAX_SIZE`, with no NUL in its first
/// `BINARY_PROBE` bytes. It grants no right to save the file.
pub fn read_project_text(root: &Path, rel: &str) -> Result<String, String> {
    let path = crate::project::inside(root, rel)?;
    let not_text = || tr!(format!("{rel} nie jest plikiem tekstowym"), format!("{rel} is not a text file"));
    let size = std::fs::metadata(&path).map_err(|e| format!("{rel}: {e}"))?.len();
    if size > MAX_SIZE {
        return Err(tr!(format!("{rel} jest za duży (ponad 1 MB)"), format!("{rel} is too big (over 1 MB)")));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{rel}: {e}"))?;
    if bytes[..bytes.len().min(BINARY_PROBE)].contains(&0) {
        return Err(not_text());
    }
    String::from_utf8(bytes).map_err(|_| not_text())
}

/// The search without git: text files of [`crate::project::files`], line by
/// line, up to `TOTAL + 1` hits (the extra one tells there are more), and
/// whether `deadline` stopped it first.
fn walk_with_deadline(root: &Path, re: &Matcher, deadline: std::time::Instant) -> (Vec<Raw>, bool) {
    let mut hits = Vec::new();
    for rel in crate::project::files(root) {
        if rel.ends_with('/') {
            continue;
        }
        if hits.len() > TOTAL {
            break;
        }
        if std::time::Instant::now() >= deadline {
            return (hits, true);
        }
        let path = root.join(&rel);
        if !std::fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() <= MAX_SIZE) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        if bytes[..bytes.len().min(BINARY_PROBE)].contains(&0) {
            continue;
        }
        let Ok(text) = String::from_utf8(bytes) else { continue };
        let found = text
            .lines()
            .enumerate()
            .filter(|(_, l)| re.is_match(l))
            .take(PER_FILE)
            .map(|(i, l)| (rel.clone(), i as u32 + 1, l.to_string()));
        hits.extend(found);
    }
    (hits, false)
}

#[cfg(test)]
mod records {
    use super::parse_record;

    #[test]
    fn reads_new_and_old_git_records() {
        let raw = |f: &str, l: u32, t: &str| Some((f.to_string(), l, t.to_string()));
        assert_eq!(parse_record("a:b.md\x0012\x00x: 1\n"), raw("a:b.md", 12, "x: 1"));
        assert_eq!(parse_record("a.md\x003:x\n"), raw("a.md", 3, "x"));
        assert_eq!(parse_record("garbage\n"), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::write(d.join("src/a.php"), "<?php\n$previous = 1;\necho 'Preview';\n").unwrap();
        std::fs::write(d.join("notes.md"), "zażółć 😀 pre\n").unwrap();
        std::fs::write(d.join("bin.dat"), [0u8, 159, 146, 150]).unwrap();
        tmp
    }

    fn git_init(d: &Path) {
        let ok = std::process::Command::new("git")
            .arg("init")
            .arg("-q")
            .arg(d)
            .status()
            .unwrap()
            .success();
        assert!(ok);
    }

    fn opts(case: bool, word: bool, regex: bool) -> GrepOptions {
        GrepOptions { case, word, regex }
    }

    /// `file:line` of every hit, sorted.
    fn places(r: &GrepResult) -> Vec<String> {
        let mut v: Vec<String> = r.hits.iter().map(|h| format!("{}:{}", h.file, h.line)).collect();
        v.sort();
        v
    }

    #[test]
    fn plain_search_finds_lines_case_insensitive() {
        let tmp = project();
        let r = grep(tmp.path(), "pre", GrepOptions::default()).unwrap();
        assert_eq!(places(&r), ["notes.md:1", "src/a.php:2", "src/a.php:3"]);
        assert_eq!(r.files, 2);
        assert!(!r.more);
        assert!(r.hits.iter().all(|h| h.file != "bin.dat"));
        let h = r.hits.iter().find(|h| h.file == "src/a.php" && h.line == 2).unwrap();
        assert_eq!(h.text, "$previous = 1;");
        assert_eq!(h.marks, [[1, 4]]);
    }

    #[test]
    fn case_word_and_regex_options() {
        let tmp = project();
        let d = tmp.path();
        let r = grep(d, "Pre", opts(true, false, false)).unwrap();
        assert_eq!(places(&r), ["src/a.php:3"]);
        let r = grep(d, "pre", opts(false, true, false)).unwrap();
        assert_eq!(places(&r), ["notes.md:1"]);
        let r = grep(d, "\\$pre\\w+", opts(false, false, true)).unwrap();
        assert_eq!(places(&r), ["src/a.php:2"]);
        // The same in a repository (git grep's -F, -w, -E, -i).
        git_init(d);
        let r = grep(d, "Pre", opts(true, false, false)).unwrap();
        assert_eq!(places(&r), ["src/a.php:3"]);
        let r = grep(d, "pre", opts(false, true, false)).unwrap();
        assert_eq!(places(&r), ["notes.md:1"]);
        let r = grep(d, "\\$pre\\w+", opts(false, false, true)).unwrap();
        assert_eq!(places(&r), ["src/a.php:2"]);
        // Text, not a pattern, without the regex option.
        assert!(grep(d, "pre.", opts(false, false, false)).unwrap().hits.is_empty());
    }

    #[test]
    fn whole_word_works_like_git_for_non_word_edges() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        std::fs::write(d.join("a.php"), "$pre = 1;\n$previous = 2;\nx$pre;\nfn foo();\nfoo(1);\n").unwrap();
        for repo in [false, true] {
            if repo {
                git_init(d);
            }
            let r = grep(d, "$pre", opts(false, true, false)).unwrap();
            assert_eq!(places(&r), ["a.php:1"], "repo: {repo}");
            assert_eq!(r.hits[0].marks, [[0, 4]], "repo: {repo}");
            // `foo(` then a word character (`foo(1)`) is not a whole word.
            let r = grep(d, "foo(", opts(false, true, false)).unwrap();
            assert_eq!(places(&r), ["a.php:4"], "repo: {repo}");
            assert_eq!(r.hits[0].marks, [[3, 7]], "repo: {repo}");
        }
    }

    #[test]
    fn marks_are_utf16() {
        let tmp = project();
        let r = grep(tmp.path(), "pre", GrepOptions::default()).unwrap();
        let h = r.hits.iter().find(|h| h.file == "notes.md").unwrap();
        assert_eq!(h.text, "zażółć 😀 pre");
        assert_eq!(h.marks, [[10, 13]]);
        // Every match in the line is marked.
        let re = pattern("ab", GrepOptions::default()).unwrap();
        assert_eq!(marked_line("ab ąb AB", &re), ("ab ąb AB".to_string(), vec![[0, 2], [6, 8]], 0));
    }

    #[test]
    fn long_line_is_trimmed_around_the_match() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        let mut line = "x".repeat(50_000);
        line.replace_range(30_000..30_006, "needle");
        std::fs::write(d.join("min.js"), format!("{line}\n")).unwrap();
        for repo in [false, true] {
            if repo {
                git_init(d);
            }
            let r = grep(d, "needle", GrepOptions::default()).unwrap();
            assert_eq!(r.hits.len(), 1);
            let h = &r.hits[0];
            let units: Vec<u16> = h.text.encode_utf16().collect();
            assert!(units.len() <= 210, "{}", units.len());
            assert!(h.text.starts_with('…'));
            assert!(h.text.contains("needle"));
            assert_eq!(h.marks.len(), 1);
            let [s, e] = h.marks[0];
            assert_eq!(String::from_utf16(&units[s as usize..e as usize]).unwrap(), "needle");
            // The window starts 60 units before the match at 30 000.
            assert_eq!(h.cut, 29_940);
        }
        let r = grep(d, "needle", GrepOptions::default()).unwrap();
        assert_eq!(r.hits[0].cut, 29_940);
        std::fs::write(d.join("short.txt"), "a needle\n").unwrap();
        let r = grep(d, "needle", GrepOptions::default()).unwrap();
        assert_eq!(r.hits.iter().find(|h| h.file == "short.txt").unwrap().cut, 0);
    }

    #[test]
    fn bad_regex_is_an_error() {
        let tmp = project();
        assert!(grep(tmp.path(), "(", opts(false, false, true)).is_err());
        assert!(pattern("(", opts(false, false, true)).is_err());
        // Without the regex option it is plain text.
        assert!(pattern("(", GrepOptions::default()).is_ok());
        // Fine for Rust, not for git's ERE: git's message.
        git_init(tmp.path());
        let e = grep(tmp.path(), "(?:pre)", opts(false, false, true)).unwrap_err();
        assert!(!e.is_empty());
    }

    #[test]
    fn dash_query_is_text_in_git() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        git_init(d);
        std::fs::write(d.join("README"), "run app --version\n").unwrap();
        let r = grep(d, "--version", GrepOptions::default()).unwrap();
        assert_eq!(places(&r), ["README:1"]);
        assert_eq!(r.hits[0].marks, [[8, 17]]);
    }

    #[test]
    fn git_config_does_not_change_the_records() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        git_init(d);
        let config = |k: &str| {
            let ok = std::process::Command::new("git")
                .arg("-C")
                .arg(d)
                .args(["config", k, "true"])
                .status()
                .unwrap()
                .success();
            assert!(ok);
        };
        config("grep.column");
        config("grep.fullName");
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::write(d.join("sub/a.txt"), "abc pre x\n").unwrap();
        // The project is a folder of the repository: paths stay relative to it.
        let r = grep(&d.join("sub"), "pre", GrepOptions::default()).unwrap();
        assert_eq!(places(&r), ["a.txt:1"]);
        assert_eq!(r.hits[0].text, "abc pre x");
        assert_eq!(r.hits[0].marks, [[4, 7]]);
    }

    #[test]
    fn git_skips_ignored_and_finds_untracked() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        git_init(d);
        std::fs::write(d.join(".gitignore"), "vendor/\n").unwrap();
        std::fs::create_dir_all(d.join("vendor")).unwrap();
        std::fs::write(d.join("vendor/x.php"), "pre\n").unwrap();
        std::fs::write(d.join("new.php"), "pre\n").unwrap();
        let r = grep(d, "pre", GrepOptions::default()).unwrap();
        let files: Vec<&str> = r.hits.iter().map(|h| h.file.as_str()).collect();
        assert!(files.contains(&"new.php"), "{files:?}");
        assert!(!files.contains(&"vendor/x.php"), "{files:?}");
    }

    #[test]
    fn git_keeps_file_names_as_they_are() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        git_init(d);
        std::fs::write(d.join("zażółć.md"), "pre\n").unwrap();
        let r = grep(d, "pre", GrepOptions::default()).unwrap();
        assert_eq!(places(&r), ["zażółć.md:1"]);
        #[cfg(unix)]
        {
            std::fs::write(d.join("a:2:b.md"), "x\npre: 1\n").unwrap();
            let r = grep(d, "pre", GrepOptions::default()).unwrap();
            assert_eq!(places(&r), ["a:2:b.md:2", "zażółć.md:1"]);
            assert_eq!(r.hits[0].text, "pre: 1");
        }
    }

    #[test]
    fn nothing_found_is_empty_not_an_error() {
        let tmp = project();
        let d = tmp.path();
        assert!(grep(d, "nowhere", GrepOptions::default()).unwrap().hits.is_empty());
        assert!(grep(d, "", GrepOptions::default()).unwrap().hits.is_empty());
        git_init(d);
        let r = grep(d, "nowhere", GrepOptions::default()).unwrap();
        assert!(r.hits.is_empty());
        assert_eq!(r.files, 0);
    }

    #[test]
    fn git_stops_reading_after_the_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        git_init(d);
        for i in 0..600 {
            std::fs::write(d.join(format!("f{i:03}.txt")), "pre\n").unwrap();
        }
        let t = std::time::Instant::now();
        let r = grep(d, "pre", GrepOptions::default()).unwrap();
        assert!(t.elapsed() < std::time::Duration::from_secs(2), "{:?}", t.elapsed());
        assert_eq!(r.hits.len(), 500);
        assert!(r.more);
    }

    #[test]
    fn walk_past_its_deadline_says_there_is_more() {
        let tmp = project();
        let re = pattern("pre", GrepOptions::default()).unwrap();
        let (hits, cut) = walk_with_deadline(tmp.path(), &re, std::time::Instant::now());
        assert!(cut);
        assert!(hits.is_empty());
        // Cut after some hits: there may be more.
        let some = vec![("notes.md".to_string(), 1, "pre".to_string())];
        assert!(finish(some, true, &re).unwrap().more);
        let later = std::time::Instant::now() + std::time::Duration::from_secs(60);
        let (hits, cut) = walk_with_deadline(tmp.path(), &re, later);
        assert!(!cut);
        assert!(!finish(hits, cut, &re).unwrap().more);
    }

    #[test]
    fn walk_past_its_deadline_with_nothing_found_took_too_long() {
        let tmp = project();
        let re = pattern("pre", GrepOptions::default()).unwrap();
        let (hits, cut) = walk_with_deadline(tmp.path(), &re, std::time::Instant::now());
        assert_eq!(finish(hits, cut, &re).unwrap_err(), too_long());
        // Not cut, nothing found: no matches, not an error.
        assert!(finish(Vec::new(), false, &re).unwrap().hits.is_empty());
    }

    #[test]
    fn a_match_longer_than_the_window_is_clipped() {
        let line = format!("{}foo{}bar{}", "x".repeat(1000), "y".repeat(500), "z".repeat(1000));
        let re = pattern("foo.*bar", opts(false, false, true)).unwrap();
        let (text, marks, cut) = marked_line(&line, &re);
        assert_eq!(text.encode_utf16().count(), 202);
        // "…" plus 60 units before the match, then up to the cut.
        assert_eq!(marks, [[61, 201]]);
        assert_eq!(cut, 940);
    }

    #[test]
    fn a_nul_in_the_query_finds_nothing() {
        let tmp = project();
        let r = grep(tmp.path(), "pre\0", GrepOptions::default()).unwrap();
        assert!(r.hits.is_empty());
        assert!(!r.more);
    }

    #[test]
    fn project_text_reads_any_text_file_inside() {
        let tmp = project();
        let d = tmp.path();
        assert_eq!(read_project_text(d, "src/a.php").unwrap(), "<?php\n$previous = 1;\necho 'Preview';\n");
        assert!(read_project_text(d, "../x").is_err());
        assert!(read_project_text(d, "src").is_err());
        assert!(read_project_text(d, "bin.dat").is_err());
        std::fs::write(d.join("big.txt"), "x".repeat(MAX_SIZE as usize + 1)).unwrap();
        assert!(read_project_text(d, "big.txt").is_err());
    }

    #[test]
    fn limits_per_file_and_total() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        std::fs::write(d.join("one.txt"), "pre\n".repeat(60)).unwrap();
        for repo in [false, true] {
            if repo {
                git_init(d);
            }
            let r = grep(d, "pre", GrepOptions::default()).unwrap();
            assert_eq!(r.hits.len(), 50);
            assert_eq!(r.files, 1);
            assert!(!r.more);
        }
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        for i in 0..11 {
            std::fs::write(d.join(format!("f{i:02}.txt")), "pre\n".repeat(50)).unwrap();
        }
        for repo in [false, true] {
            if repo {
                git_init(d);
            }
            let r = grep(d, "pre", GrepOptions::default()).unwrap();
            assert_eq!(r.hits.len(), 500);
            assert_eq!(r.files, 10);
            assert!(r.more);
        }
    }
}
