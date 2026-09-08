//! Per-set threads on disk: the thread she reads in the card, saved under
//! the set's identity and restored when the set is open again.
//!
//! One JSON file per thread under `threads/` beside `settings.json`, and an
//! `index.json` that maps each thread to the set's stored id and path. The
//! index is what makes the identity rules cheap: a lookup goes by id first,
//! then by path, and a hit by path adopts the entry under the new id. That
//! covers a set she closed without saving, whose id was minted again on the
//! next open, and the promotion from path to stored id every new set goes
//! through. A thread nobody has opened for `RETENTION` is deleted.

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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Thread {
    pub exchanges: Vec<Exchange>,
    /// Seconds since the epoch, set by the caller on save. The recap line
    /// in the card is derived from it.
    pub saved_at: u64,
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

fn write_index(dir: &Path, index: &Index) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let body = serde_json::to_string_pretty(index)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(dir.join(INDEX_FILE), body)
}

/// The thread for this set, or None when there is none or its file no
/// longer reads. Marks the entry opened now, so `prune` keeps it.
pub fn load(dir: &Path, id: &str, path: Option<&str>, now: u64) -> Option<Thread> {
    let mut index = read_index(dir);
    let i = index.find(id, path)?;
    index.entries[i].last_opened = now;
    let file: PathBuf = dir.join(&index.entries[i].file);
    if let Err(e) = write_index(dir, &index) {
        eprintln!("threads: could not update the index: {e}");
    }
    std::fs::read_to_string(file)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

/// Writes the whole thread. Small files, one write; no partial appends.
pub fn save(dir: &Path, id: &str, path: Option<&str>, thread: &Thread) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let mut index = read_index(dir);
    let i = match index.find(id, path) {
        Some(i) => i,
        None => {
            index.entries.push(Entry {
                id: id.to_string(),
                path: path.filter(|p| !p.is_empty()).map(str::to_string),
                file: format!("thread-{}.json", index.next),
                last_opened: thread.saved_at,
            });
            index.next += 1;
            index.entries.len() - 1
        }
    };
    index.entries[i].last_opened = thread.saved_at;
    if let Some(p) = path.filter(|p| !p.is_empty()) {
        index.entries[i].path = Some(p.to_string());
    }
    let body = serde_json::to_string_pretty(thread)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(dir.join(&index.entries[i].file), body)?;
    write_index(dir, &index)
}

/// Deletes every thread not opened within `RETENTION` of `now`. Returns
/// how many went.
pub fn prune(dir: &Path, now: u64) -> std::io::Result<usize> {
    let mut index = read_index(dir);
    let cutoff = now.saturating_sub(RETENTION.as_secs());
    let (keep, drop): (Vec<Entry>, Vec<Entry>) =
        index.entries.drain(..).partition(|e| e.last_opened >= cutoff);
    index.entries = keep;
    for e in &drop {
        // A file already gone is the outcome wanted, not an error.
        let _ = std::fs::remove_file(dir.join(&e.file));
    }
    if !drop.is_empty() {
        write_index(dir, &index)?;
    }
    Ok(drop.len())
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
            }],
            saved_at,
        }
    }

    const ID: &str = "0123456789abcdef0123456789abcdef";
    const PATH: &str = "/x/Track.als";

    #[test]
    fn a_set_with_no_thread_loads_nothing() {
        let dir = scratch();
        assert_eq!(load(&dir, ID, Some(PATH), 100), None);
    }

    #[test]
    fn a_saved_thread_loads_by_id() {
        let dir = scratch();
        save(&dir, ID, Some(PATH), &thread("why is the pad muddy", 100)).unwrap();
        assert_eq!(load(&dir, ID, Some(PATH), 200), Some(thread("why is the pad muddy", 100)));
    }

    // The set was closed without saving, so its id was minted again on the
    // next open. The path is the same, and the thread follows it.
    #[test]
    fn a_thread_found_by_path_is_adopted_under_the_new_id() {
        let dir = scratch();
        save(&dir, "old-id", Some(PATH), &thread("first", 100)).unwrap();
        assert_eq!(load(&dir, "new-id", Some(PATH), 200), Some(thread("first", 100)));
        // Adopted: the old id no longer finds it, the new one does without a path.
        assert_eq!(load(&dir, "old-id", None, 300), None);
        assert_eq!(load(&dir, "new-id", None, 300), Some(thread("first", 100)));
    }

    // A set that has no path yet (unsaved) is keyed on its stored id alone,
    // and an empty path must never match another entry's empty path.
    #[test]
    fn an_empty_path_matches_nothing() {
        let dir = scratch();
        save(&dir, "a", Some(""), &thread("a", 100)).unwrap();
        assert_eq!(load(&dir, "b", Some(""), 200), None);
        assert_eq!(load(&dir, "b", None, 200), None);
    }

    #[test]
    fn saving_again_replaces_the_thread_in_place() {
        let dir = scratch();
        save(&dir, ID, Some(PATH), &thread("first", 100)).unwrap();
        save(&dir, ID, Some(PATH), &thread("second", 200)).unwrap();
        assert_eq!(load(&dir, ID, Some(PATH), 300), Some(thread("second", 200)));
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
        assert_eq!(load(&dir, "old", None, 31 * day), None);
        assert_eq!(load(&dir, "recent", None, 31 * day), Some(thread("recent", 20 * day)));
        assert!(!dir.join("thread-0.json").exists());
    }

    #[test]
    fn loading_keeps_a_thread_alive() {
        let dir = scratch();
        let day = 24 * 60 * 60;
        save(&dir, ID, Some(PATH), &thread("q", 0)).unwrap();
        load(&dir, ID, Some(PATH), 20 * day);
        assert_eq!(prune(&dir, 40 * day).unwrap(), 0);
    }

    #[test]
    fn a_corrupt_index_or_file_reads_as_nothing_and_saving_still_works() {
        let dir = scratch();
        std::fs::write(dir.join(INDEX_FILE), "{not json").unwrap();
        assert_eq!(load(&dir, ID, Some(PATH), 100), None);
        save(&dir, ID, Some(PATH), &thread("q", 100)).unwrap();
        std::fs::write(dir.join("thread-0.json"), "{not json").unwrap();
        assert_eq!(load(&dir, ID, Some(PATH), 200), None);
    }
}
