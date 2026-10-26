//! Path fallback keeps an unsaved set's thread when Live mints a new id.
//! Retention removes old transcripts while preserving set notes, goals, and outcomes.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const THREADS_DIR: &str = "threads";
const INDEX_FILE: &str = "index.json";
/// How long a thread outlives its last open.
pub const RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// One question and what came back for it; the same shape as the
/// frontend's `Exchange` in `src/ui/thread.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Exchange {
    pub question: String,
    pub answer: Option<String>,
    pub error: Option<String>,
    #[serde(default, rename = "turnId", skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<Feedback>,
    #[serde(default, rename = "move", skip_serializing_if = "Option::is_none")]
    pub move_label: Option<String>,
    #[serde(default, rename = "tracksRead", skip_serializing_if = "Option::is_none")]
    pub tracks_read: Option<Vec<String>>,
    #[serde(default, rename = "accountId", skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// The terms she can tap in the answer; threads from before them have none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terms: Option<Vec<Term>>,
}

/// One term an answer explains on a tap; the same shape as the frontend's
/// `Term` in `src/notes/terms.ts`. Rust stores it and never reads it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Term {
    pub term: String,
    pub meaning: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Feedback {
    pub outcome: String,
    pub heard: String,
    pub shared: bool,
}

/// One outcome bullet of a set's note; the same shape as the frontend's
/// `Bullet` in `src/notes/note.ts`. Rust stores it and never reads it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bullet {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub at: u64,
    pub hers: bool,
}

/// One rating of an answer's move; the same shape as the frontend's
/// `Outcome` in `src/notes/outcomes.ts`. Rust stores it; the prune only checks whether any exist.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Outcome {
    #[serde(rename = "turnId")]
    pub turn_id: String,
    #[serde(rename = "move")]
    pub move_label: String,
    pub outcome: String,
    pub heard: String,
    pub tracks: Vec<String>,
    pub answer: String,
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Thread {
    pub exchanges: Vec<Exchange>,
    /// None awaits the goal prompt; an empty string records starting without a goal.
    #[serde(default)]
    pub goal: Option<String>,
    /// Seconds since the epoch, set by the caller on save. The recap line
    /// in the card is derived from it.
    pub saved_at: u64,
    /// The set's note. Files from before notes existed have neither field
    /// and read as an empty note.
    #[serde(default)]
    pub note: Vec<Bullet>,
    #[serde(default)]
    pub next_bullet: u64,
    /// Files from before outcomes existed read as an empty log.
    #[serde(default)]
    pub outcomes: Vec<Outcome>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
struct Index {
    next: u64,
    entries: Vec<Entry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Entry {
    /// The set's identity: its stored id, or its path while it has none.
    id: String,
    path: Option<String>,
    file: String,
    /// Seconds since the epoch.
    last_opened: u64,
}

impl Index {
    /// By id first, then by path. A hit by path is adopted under `id`, so
    /// a thread follows a set whose id was minted again.
    fn find(&mut self, id: &str, path: Option<&str>) -> Option<usize> {
        if let Some(i) = self.entries.iter().position(|e| e.id == id) {
            return Some(i);
        }
        let path = path.filter(|p| !p.is_empty())?;
        let i = self.entries.iter().position(|e| e.path.as_deref() == Some(path))?;
        self.entries[i].id = id.to_string();
        Some(i)
    }
}

/// A corrupt or missing index reads as empty. Files it used to point at
/// stay on disk unreferenced; losing the map is better than refusing to
/// save anything ever again.
fn read_index(dir: &Path) -> Index {
    std::fs::read_to_string(dir.join(INDEX_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Writes through a temporary file and a rename, so a quit or a power cut
/// mid-write leaves the old file whole rather than a torn one.
pub(crate) fn write_atomically(path: &Path, body: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)
}

fn write_index(dir: &Path, index: &Index) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let body = serde_json::to_string_pretty(index)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    write_atomically(&dir.join(INDEX_FILE), &body)
}

/// A file name no thread on disk already uses. The index's counter is the
/// first guess; a counter reset by a corrupt index must not hand out a
/// name that still holds someone's transcript.
fn fresh_file(dir: &Path, index: &mut Index) -> String {
    loop {
        let name = format!("thread-{}.json", index.next);
        index.next += 1;
        if !dir.join(&name).exists() {
            return name;
        }
    }
}

/// The thread for this set. `Ok(None)` when there is none: no entry, or
/// an entry whose file is gone. A file that exists but does not parse is
/// moved aside as `<file>.corrupt` and reads as none, so the transcript is
/// kept for a person and the set starts fresh. Any other read failure is
/// an error, so the caller keeps what it shows rather than start over on
/// top of a thread it could not read. Marks the entry opened now, so
/// `prune` keeps it.
pub fn load(dir: &Path, id: &str, path: Option<&str>, now: u64) -> std::io::Result<Option<Thread>> {
    let mut index = read_index(dir);
    let Some(i) = index.find(id, path) else {
        return Ok(None);
    };
    index.entries[i].last_opened = now;
    let file: PathBuf = dir.join(&index.entries[i].file);
    write_index(dir, &index)?;
    let raw = match std::fs::read_to_string(&file) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    match serde_json::from_str(&raw) {
        Ok(thread) => Ok(Some(thread)),
        Err(e) => {
            eprintln!("threads: {} does not parse ({e}); moving it aside", file.display());
            std::fs::rename(&file, file.with_extension("json.corrupt"))?;
            Ok(None)
        }
    }
}

/// Writes the whole thread. Small files, one write; no partial appends.
pub fn save(dir: &Path, id: &str, path: Option<&str>, thread: &Thread) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let mut index = read_index(dir);
    let i = match index.find(id, path) {
        Some(i) => i,
        None => {
            let file = fresh_file(dir, &mut index);
            index.entries.push(Entry {
                id: id.to_string(),
                path: path.filter(|p| !p.is_empty()).map(str::to_string),
                file,
                last_opened: thread.saved_at,
            });
            index.entries.len() - 1
        }
    };
    index.entries[i].last_opened = thread.saved_at;
    if let Some(p) = path.filter(|p| !p.is_empty()) {
        index.entries[i].path = Some(p.to_string());
    }
    write_thread(&dir.join(&index.entries[i].file), thread)?;
    write_index(dir, &index)
}

fn write_thread(file: &Path, thread: &Thread) -> std::io::Result<()> {
    let body = serde_json::to_string_pretty(thread)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    write_atomically(file, &body)
}

/// A thread file that is missing or does not parse reads as nothing here;
/// `load` is where a corrupt file is moved aside and reported.
fn read_thread(file: &Path) -> Option<Thread> {
    let raw = std::fs::read_to_string(file).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Drops aged transcripts while retaining each set's note, goal, and outcomes.
/// Failed rewrites keep their index entry so the next startup can retry.
pub fn prune(dir: &Path, now: u64) -> std::io::Result<usize> {
    let mut index = read_index(dir);
    let mut kept = Vec::new();
    let mut dropped = 0usize;
    for e in index.entries.drain(..) {
        // Age, not a cutoff: a cutoff computed from `now` saturates at zero
        // when the clock is young and would drop everything opened at the
        // epoch, which is what a test clock looks like.
        if now.saturating_sub(e.last_opened) < RETENTION.as_secs() {
            kept.push(e);
            continue;
        }
        let file = dir.join(&e.file);
        if let Some(thread) = read_thread(&file).filter(|t| !t.note.is_empty() || t.goal.is_some() || !t.outcomes.is_empty()) {
            if thread.exchanges.is_empty() {
                // Already pruned to its note on an earlier startup.
                kept.push(e);
                continue;
            }
            let note_only = Thread { exchanges: vec![], ..thread };
            match write_thread(&file, &note_only) {
                Ok(()) => dropped += 1,
                Err(err) => eprintln!("threads: could not prune {} to its note ({err})", e.file),
            }
            kept.push(e);
            continue;
        }
        match std::fs::remove_file(&file) {
            // A file already gone is the outcome wanted.
            Ok(()) => dropped += 1,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => dropped += 1,
            Err(err) => {
                eprintln!("threads: could not delete {} ({err}); keeping its entry", e.file);
                kept.push(e);
            }
        }
    }
    let changed = dropped > 0;
    index.entries = kept;
    if changed {
        write_index(dir, &index)?;
    }
    Ok(dropped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn scratch() -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mixing-pal-threads-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn thread(question: &str, saved_at: u64) -> Thread {
        Thread {
            exchanges: vec![Exchange {
                question: question.into(),
                answer: Some("an answer".into()),
                error: None,
                turn_id: None,
                feedback: None,
                move_label: None,
                tracks_read: None,
                account_id: None,
                terms: None,
            }],
            saved_at,
            goal: None,
            note: vec![],
            next_bullet: 0,
            outcomes: vec![],
        }
    }

    const ID: &str = "0123456789abcdef0123456789abcdef";
    const PATH: &str = "/x/Track.als";

    #[test]
    fn a_set_with_no_thread_loads_nothing() {
        let dir = scratch();
        assert_eq!(load(&dir, ID, Some(PATH), 100).unwrap(), None);
    }

    #[test]
    fn a_saved_thread_loads_by_id() {
        let dir = scratch();
        save(&dir, ID, Some(PATH), &thread("why is the pad muddy", 100)).unwrap();
        assert_eq!(
            load(&dir, ID, Some(PATH), 200).unwrap(),
            Some(thread("why is the pad muddy", 100))
        );
    }

    #[test]
    fn a_goal_round_trips_with_its_set_thread() {
        let dir = scratch();
        let mut t = thread("why is the pad muddy", 100);
        let mut saved = serde_json::to_value(&t).unwrap();
        saved["goal"] = serde_json::json!("dark garage, 2am");
        t = serde_json::from_value(saved).unwrap();
        save(&dir, ID, Some(PATH), &t).unwrap();
        let restored = load(&dir, ID, Some(PATH), 200).unwrap().unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap()["goal"], "dark garage, 2am");
    }

    #[test]
    fn a_skipped_goal_survives_transcript_retention() {
        let dir = scratch();
        let mut saved = serde_json::to_value(thread("question", 0)).unwrap();
        saved["goal"] = serde_json::json!("");
        let t: Thread = serde_json::from_value(saved).unwrap();
        save(&dir, ID, Some(PATH), &t).unwrap();
        assert_eq!(prune(&dir, RETENTION.as_secs()).unwrap(), 1);
        let restored = load(&dir, ID, Some(PATH), RETENTION.as_secs()).unwrap().unwrap();
        assert_eq!(restored.exchanges, vec![]);
        assert_eq!(serde_json::to_value(restored).unwrap()["goal"], "");
    }

    // The set was closed without saving, so its id was minted again on the
    // next open. The path is the same, and the thread follows it.
    #[test]
    fn a_thread_found_by_path_is_adopted_under_the_new_id() {
        let dir = scratch();
        save(&dir, "old-id", Some(PATH), &thread("first", 100)).unwrap();
        assert_eq!(load(&dir, "new-id", Some(PATH), 200).unwrap(), Some(thread("first", 100)));
        // Adopted: the old id no longer finds it, the new one does without a path.
        assert_eq!(load(&dir, "old-id", None, 300).unwrap(), None);
        assert_eq!(load(&dir, "new-id", None, 300).unwrap(), Some(thread("first", 100)));
    }

    // A set that has no path yet (unsaved) is keyed on its stored id alone,
    // and an empty path must never match another entry's empty path.
    #[test]
    fn an_empty_path_matches_nothing() {
        let dir = scratch();
        save(&dir, "a", Some(""), &thread("a", 100)).unwrap();
        assert_eq!(load(&dir, "b", Some(""), 200).unwrap(), None);
        assert_eq!(load(&dir, "b", None, 200).unwrap(), None);
    }

    #[test]
    fn saving_again_replaces_the_thread_in_place() {
        let dir = scratch();
        save(&dir, ID, Some(PATH), &thread("first", 100)).unwrap();
        save(&dir, ID, Some(PATH), &thread("second", 200)).unwrap();
        assert_eq!(load(&dir, ID, Some(PATH), 300).unwrap(), Some(thread("second", 200)));
        let files: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.starts_with("thread-"))
            .collect();
        assert_eq!(files.len(), 1, "one set, one file: {files:?}");
    }

    #[test]
    fn prune_drops_only_what_has_not_been_opened_in_thirty_days() {
        let dir = scratch();
        let day = 24 * 60 * 60;
        save(&dir, "old", Some("/old.als"), &thread("old", 0)).unwrap();
        save(&dir, "recent", Some("/recent.als"), &thread("recent", 20 * day)).unwrap();
        assert_eq!(prune(&dir, 31 * day).unwrap(), 1);
        assert_eq!(load(&dir, "old", None, 31 * day).unwrap(), None);
        assert_eq!(
            load(&dir, "recent", None, 31 * day).unwrap(),
            Some(thread("recent", 20 * day))
        );
        assert!(!dir.join("thread-0.json").exists());
    }

    // "Dropped thirty days after its last open": kept one second short of
    // thirty days, gone at thirty.
    // The transcript goes on the prune's schedule; the note does not. The
    // second prune finds nothing left to drop and rewrites nothing.
    #[test]
    fn prune_keeps_a_note_and_drops_its_transcript() {
        let dir = scratch();
        let day = 24 * 60 * 60;
        let noted = Thread {
            note: vec![Bullet {
                id: "b0".into(),
                kind: "decided".into(),
                text: "leave the sub".into(),
                at: 0,
                hers: true,
            }],
            next_bullet: 1,
            ..thread("q", 0)
        };
        save(&dir, ID, Some(PATH), &noted).unwrap();
        assert_eq!(prune(&dir, 31 * day).unwrap(), 1);
        let after = load(&dir, ID, Some(PATH), 31 * day).unwrap().unwrap();
        assert_eq!(after.exchanges, vec![]);
        assert_eq!(after.note, noted.note);
        assert_eq!(after.next_bullet, 1);
        assert_eq!(prune(&dir, 62 * day).unwrap(), 0);
        assert!(load(&dir, ID, Some(PATH), 62 * day).unwrap().is_some());
    }

    #[test]
    fn prune_drops_a_thread_at_exactly_thirty_days() {
        let dir = scratch();
        let day = 24 * 60 * 60;
        save(&dir, ID, Some(PATH), &thread("q", 0)).unwrap();
        assert_eq!(prune(&dir, 30 * day - 1).unwrap(), 0);
        assert_eq!(prune(&dir, 30 * day).unwrap(), 1);
    }

    // A corrupt index resets the counter; the next save must not reuse a
    // file name that still holds a transcript.
    #[test]
    fn a_reset_counter_never_overwrites_a_thread_on_disk() {
        let dir = scratch();
        save(&dir, "a", Some("/a.als"), &thread("a", 100)).unwrap();
        std::fs::write(dir.join(INDEX_FILE), "{not json").unwrap();
        save(&dir, "b", Some("/b.als"), &thread("b", 200)).unwrap();
        let a: Thread =
            serde_json::from_str(&std::fs::read_to_string(dir.join("thread-0.json")).unwrap()).unwrap();
        assert_eq!(a, thread("a", 100));
        assert_eq!(load(&dir, "b", None, 300).unwrap(), Some(thread("b", 200)));
    }

    #[test]
    fn loading_keeps_a_thread_alive() {
        let dir = scratch();
        let day = 24 * 60 * 60;
        save(&dir, ID, Some(PATH), &thread("q", 0)).unwrap();
        load(&dir, ID, Some(PATH), 20 * day).unwrap();
        assert_eq!(prune(&dir, 40 * day).unwrap(), 0);
    }

    #[test]
    fn a_corrupt_index_or_file_reads_as_nothing_and_saving_still_works() {
        let dir = scratch();
        std::fs::write(dir.join(INDEX_FILE), "{not json").unwrap();
        assert_eq!(load(&dir, ID, Some(PATH), 100).unwrap(), None);
        save(&dir, ID, Some(PATH), &thread("q", 100)).unwrap();
        std::fs::write(dir.join("thread-0.json"), "{not json").unwrap();
        // The transcript is moved aside for a person, not thrown away.
        assert_eq!(load(&dir, ID, Some(PATH), 200).unwrap(), None);
        assert!(dir.join("thread-0.json.corrupt").exists());
        assert!(!dir.join("thread-0.json").exists());
    }

    #[test]
    fn a_missing_file_behind_an_entry_reads_as_nothing() {
        let dir = scratch();
        save(&dir, ID, Some(PATH), &thread("q", 100)).unwrap();
        std::fs::remove_file(dir.join("thread-0.json")).unwrap();
        assert_eq!(load(&dir, ID, Some(PATH), 200).unwrap(), None);
    }

    // Threads written before notes existed have no note field.
    #[test]
    fn a_thread_saved_without_a_note_reads_with_an_empty_one() {
        let dir = scratch();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(INDEX_FILE),
            r#"{"next":1,"entries":[{"id":"id","path":"/x.als","file":"thread-0.json","last_opened":5}]}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("thread-0.json"),
            r#"{"exchanges":[{"question":"q","answer":"a","error":null}],"saved_at":5}"#,
        )
        .unwrap();
        let t = load(&dir, "id", None, 10).unwrap().unwrap();
        assert_eq!(t.goal, None);
        assert_eq!(t.note, vec![]);
        assert_eq!(t.next_bullet, 0);
        assert_eq!(t.outcomes, vec![]);
        assert_eq!(t.exchanges[0].move_label, None);
        assert_eq!(t.exchanges[0].terms, None);
    }

    fn outcome(turn: &str) -> Outcome {
        Outcome {
            turn_id: turn.into(),
            move_label: "«Pad», mud: cut 300 Hz".into(),
            outcome: "undone".into(),
            heard: "thin".into(),
            tracks: vec!["Pad".into()],
            answer: "Cut 2 dB at 300 Hz.".into(),
            at: 5,
        }
    }

    // Outcomes are the set's memory of what she kept and undid; the
    // transcript goes on the prune's schedule, they do not.
    #[test]
    fn prune_keeps_outcomes_without_a_note_or_goal() {
        let dir = scratch();
        let day = 24 * 60 * 60;
        let rated = Thread { outcomes: vec![outcome("t1")], ..thread("q", 0) };
        save(&dir, ID, Some(PATH), &rated).unwrap();
        assert_eq!(prune(&dir, 31 * day).unwrap(), 1);
        let after = load(&dir, ID, Some(PATH), 31 * day).unwrap().unwrap();
        assert_eq!(after.exchanges, vec![]);
        assert_eq!(after.outcomes, rated.outcomes);
    }

    #[test]
    fn outcomes_and_exchange_labels_round_trip_under_their_wire_names() {
        let dir = scratch();
        let mut t = thread("q", 0);
        t.exchanges[0].move_label = Some("«Pad», mud: cut".into());
        t.exchanges[0].tracks_read = Some(vec!["Pad".into()]);
        t.outcomes = vec![outcome("t1")];
        save(&dir, ID, Some(PATH), &t).unwrap();
        let raw = std::fs::read_to_string(dir.join(&read_index(&dir).entries[0].file)).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(json["exchanges"][0]["move"], "«Pad», mud: cut");
        assert_eq!(json["exchanges"][0]["tracksRead"][0], "Pad");
        assert_eq!(json["outcomes"][0]["turnId"], "t1");
        assert_eq!(json["outcomes"][0]["move"], "«Pad», mud: cut 300 Hz");
        assert_eq!(load(&dir, ID, Some(PATH), 0).unwrap().unwrap(), t);
    }

    #[test]
    fn an_exchanges_terms_round_trip_in_the_frontends_shape() {
        let dir = scratch();
        let mut t = thread("q", 0);
        t.exchanges[0].terms = Some(vec![Term {
            term: "Gain reduction".into(),
            meaning: "How far the Compressor turns the signal down.".into(),
        }]);
        save(&dir, ID, Some(PATH), &t).unwrap();
        let raw = std::fs::read_to_string(dir.join(&read_index(&dir).entries[0].file)).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(json["exchanges"][0]["terms"][0]["term"], "Gain reduction");
        assert_eq!(json["exchanges"][0]["terms"][0]["meaning"], "How far the Compressor turns the signal down.");
        assert_eq!(load(&dir, ID, Some(PATH), 0).unwrap().unwrap(), t);
        // An exchange without terms writes no field, as before.
        let plain = thread("q", 0);
        save(&dir, ID, Some(PATH), &plain).unwrap();
        let raw = std::fs::read_to_string(dir.join(&read_index(&dir).entries[0].file)).unwrap();
        assert!(!raw.contains("terms"));
    }

    #[test]
    fn a_note_round_trips_with_its_counter() {
        let dir = scratch();
        let mut t = thread("q", 100);
        t.note = vec![Bullet {
            id: "b0".into(),
            kind: "heard".into(),
            text: "the sub still masks the kick".into(),
            at: 90,
            hers: true,
        }];
        t.next_bullet = 1;
        save(&dir, ID, Some(PATH), &t).unwrap();
        assert_eq!(load(&dir, ID, Some(PATH), 200).unwrap(), Some(t));
    }
}
