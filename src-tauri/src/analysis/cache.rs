//! One analysis per file state and region, shared by every caller that asks
//! for it while it runs, at most two running at once, off the async runtime.

use super::decode::{file_state, AnalysisError};
use super::{analyse, Stats};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Instant, SystemTime};
use tokio::sync::{OnceCell, Semaphore};

pub const CAPACITY: usize = 256;
pub const CONCURRENT: usize = 2;

pub type Run = fn(&Path, &[(u64, u64)], Option<&[(u64, u64)]>, Instant) -> Result<Stats, AnalysisError>;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Job {
    pub path: PathBuf,
    pub regions: Vec<(u64, u64)>,
    pub segments: Option<Vec<(u64, u64)>>,
}

/// The job plus the file's size and modification time: an edited file is a
/// new key, and its old entry ages out.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Key {
    job: Job,
    size: u64,
    modified: SystemTime,
}

type Cell = Arc<OnceCell<Arc<Stats>>>;

pub struct Analyses {
    permits: Semaphore,
    cells: Mutex<(HashMap<Key, Cell>, VecDeque<Key>)>,
    capacity: usize,
}

pub static ANALYSES: LazyLock<Analyses> = LazyLock::new(|| Analyses::new(CONCURRENT, CAPACITY));

impl Analyses {
    pub fn new(concurrent: usize, capacity: usize) -> Self {
        Analyses { permits: Semaphore::new(concurrent), cells: Mutex::new((HashMap::new(), VecDeque::new())), capacity }
    }

    pub async fn get(&self, job: Job, deadline: Instant) -> Result<Arc<Stats>, AnalysisError> {
        self.get_with(job, deadline, analyse).await
    }

    /// `run` is `analyse` outside tests. A caller that finds the same key
    /// running waits for that run instead of starting another. A failed
    /// run leaves nothing behind, so the next caller tries again.
    pub async fn get_with(&self, job: Job, deadline: Instant, run: Run) -> Result<Arc<Stats>, AnalysisError> {
        let (size, modified) = file_state(&job.path)?;
        let key = Key { job: job.clone(), size, modified };
        let cell = self.cell(&key);
        let result = cell
            .get_or_try_init(|| async move {
                let _permit = tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), self.permits.acquire())
                    .await
                    .map_err(|_| AnalysisError::AnalysisTimeout)?
                    .map_err(|_| AnalysisError::DecodeFailed)?;
                let stats = tokio::task::spawn_blocking(move || run(&job.path, &job.regions, job.segments.as_deref(), deadline))
                    .await
                    .map_err(|_| AnalysisError::DecodeFailed)??;
                Ok(Arc::new(stats))
            })
            .await
            .map(Arc::clone);
        // A file that changed while it was read is answered, not kept.
        if result.is_err() || file_state(&key.job.path).ok() != Some((size, modified)) {
            self.forget(&key);
        }
        result
    }

    fn cell(&self, key: &Key) -> Cell {
        let mut guard = self.cells.lock().unwrap_or_else(|e| e.into_inner());
        let (map, order) = &mut *guard;
        if let Some(c) = map.get(key) {
            return c.clone();
        }
        let c = Cell::default();
        map.insert(key.clone(), c.clone());
        order.push_back(key.clone());
        while order.len() > self.capacity {
            if let Some(old) = order.pop_front() {
                map.remove(&old);
            }
        }
        c
    }

    fn forget(&self, key: &Key) {
        let mut guard = self.cells.lock().unwrap_or_else(|e| e.into_inner());
        let (map, order) = &mut *guard;
        map.remove(key);
        order.retain(|k| k != key);
    }

    #[cfg(test)]
    fn cached(&self) -> usize {
        self.cells.lock().unwrap().0.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::signals::{sine, wav};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn job(path: PathBuf) -> Job {
        Job { path, regions: vec![(0, 4_410)], segments: None }
    }

    fn later() -> Instant {
        Instant::now() + Duration::from_secs(20)
    }

    #[tokio::test]
    async fn a_repeat_call_is_answered_from_the_cache() {
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        fn counted(p: &Path, r: &[(u64, u64)], s: Option<&[(u64, u64)]>, d: Instant) -> Result<Stats, AnalysisError> {
            RUNS.fetch_add(1, Ordering::SeqCst);
            analyse(p, r, s, d)
        }
        let a = Analyses::new(2, 256);
        let path = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        let first = a.get_with(job(path.clone()), later(), counted).await.unwrap();
        let second = a.get_with(job(path), later(), counted).await.unwrap();
        assert_eq!(RUNS.load(Ordering::SeqCst), 1);
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[tokio::test]
    async fn other_segment_boundaries_are_another_analysis() {
        // A different warp map moves the beat boundaries; the stats differ.
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        fn counted(p: &Path, r: &[(u64, u64)], s: Option<&[(u64, u64)]>, d: Instant) -> Result<Stats, AnalysisError> {
            RUNS.fetch_add(1, Ordering::SeqCst);
            analyse(p, r, s, d)
        }
        let a = Analyses::new(2, 256);
        let path = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        let with = |segments| Job { segments: Some(segments), ..job(path.clone()) };
        a.get_with(with(vec![(0, 2_000), (2_000, 4_410)]), later(), counted).await.unwrap();
        a.get_with(with(vec![(0, 2_205), (2_205, 4_410)]), later(), counted).await.unwrap();
        assert_eq!(RUNS.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_callers_share_one_analysis() {
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        fn slow(p: &Path, r: &[(u64, u64)], s: Option<&[(u64, u64)]>, d: Instant) -> Result<Stats, AnalysisError> {
            RUNS.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(200));
            analyse(p, r, s, d)
        }
        let a = Analyses::new(2, 256);
        let path = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        let (x, y) = tokio::join!(a.get_with(job(path.clone()), later(), slow), a.get_with(job(path), later(), slow));
        assert!(x.is_ok() && y.is_ok());
        assert_eq!(RUNS.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn no_more_than_two_run_at_once() {
        static NOW: AtomicUsize = AtomicUsize::new(0);
        static MOST: AtomicUsize = AtomicUsize::new(0);
        fn tracked(p: &Path, r: &[(u64, u64)], s: Option<&[(u64, u64)]>, d: Instant) -> Result<Stats, AnalysisError> {
            let n = NOW.fetch_add(1, Ordering::SeqCst) + 1;
            MOST.fetch_max(n, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(150));
            NOW.fetch_sub(1, Ordering::SeqCst);
            analyse(p, r, s, d)
        }
        let a = Analyses::new(2, 256);
        let files: Vec<_> = (0..3).map(|_| wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5))).collect();
        let (x, y, z) = tokio::join!(
            a.get_with(job(files[0].clone()), later(), tracked),
            a.get_with(job(files[1].clone()), later(), tracked),
            a.get_with(job(files[2].clone()), later(), tracked),
        );
        assert!(x.is_ok() && y.is_ok() && z.is_ok());
        assert_eq!(MOST.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_file_that_changes_while_read_is_answered_but_not_kept() {
        fn grows(p: &Path, r: &[(u64, u64)], s: Option<&[(u64, u64)]>, d: Instant) -> Result<Stats, AnalysisError> {
            let stats = analyse(p, r, s, d);
            let mut f = std::fs::OpenOptions::new().append(true).open(p).unwrap();
            std::io::Write::write_all(&mut f, &[0, 0]).unwrap();
            stats
        }
        let a = Analyses::new(2, 256);
        let path = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        assert!(a.get_with(job(path), later(), grows).await.is_ok());
        assert_eq!(a.cached(), 0);
    }

    #[tokio::test]
    async fn the_oldest_entry_goes_past_capacity() {
        let a = Analyses::new(2, 2);
        for _ in 0..3 {
            let path = wav(44_100, 1, &sine(44_100, 440.0, 0.1, 0.5));
            a.get(job(path), later()).await.unwrap();
        }
        assert_eq!(a.cached(), 2);
    }

    #[tokio::test]
    async fn a_missing_file_fails_before_any_slot_is_taken() {
        let a = Analyses::new(2, 256);
        let r = a.get(job(PathBuf::from("/Users/someone/gone.wav")), later()).await;
        assert_eq!(r.err(), Some(AnalysisError::FileMissing));
        assert_eq!(a.cached(), 0);
    }

    #[tokio::test]
    async fn a_passed_deadline_is_a_timeout() {
        let a = Analyses::new(2, 256);
        let path = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        assert_eq!(a.get(job(path), Instant::now()).await.err(), Some(AnalysisError::AnalysisTimeout));
    }
}
