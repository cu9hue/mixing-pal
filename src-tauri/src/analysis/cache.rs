//! One analysis per file state and region, shared by every caller that asks
//! for it while it runs, at most two running at once, off the async runtime.

use super::decode::{file_state, AnalysisError};
use super::{analyse, Stats};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};
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

    pub async fn get(&self, job: Job, wait_until: Instant, budget: Duration) -> Result<Arc<Stats>, AnalysisError> {
        self.get_with(job, wait_until, budget, analyse).await
    }

    /// `run` is `analyse` outside tests. A caller that finds the same key
    /// running waits for that run instead of starting another. A failed
    /// run leaves nothing behind, so the next caller tries again.
    ///
    /// `wait_until` bounds the wait for a slot; `budget` starts once the
    /// slot is free, so calls queued behind others still get their full
    /// analysis time.
    pub async fn get_with(&self, job: Job, wait_until: Instant, budget: Duration, run: Run) -> Result<Arc<Stats>, AnalysisError> {
        if Instant::now() >= wait_until {
            return Err(AnalysisError::AnalysisTimeout);
        }
        let path = job.path.clone();
        let (size, modified) = blocking(wait_until, move || file_state(&path)).await?;
        let key = Key { job: job.clone(), size, modified };
        let cell = self.cell(&key);
        let result = cell
            .get_or_try_init(|| async move {
                let _permit = tokio::time::timeout_at(tokio::time::Instant::from_std(wait_until), self.permits.acquire())
                    .await
                    .map_err(|_| AnalysisError::AnalysisTimeout)?
                    .map_err(|_| AnalysisError::DecodeFailed)?;
                let deadline = Instant::now() + budget;
                let stats = blocking(deadline, move || run(&job.path, &job.regions, job.segments.as_deref(), deadline)).await?;
                Ok(Arc::new(stats))
            })
            .await
            .map(Arc::clone);
        // A file that changed while it was read is answered, not kept.
        let path = key.job.path.clone();
        let unchanged = result.is_ok() && blocking(Instant::now() + budget, move || file_state(&path)).await.ok() == Some((size, modified));
        match (&result, unchanged) {
            (Ok(_), true) => self.keep(&key, &cell),
            // A waiter's own run filled the cell after this one failed.
            (Err(_), _) if cell.get().is_some() => {}
            _ => self.forget(&key, &cell),
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

    /// A caller whose own run failed may clean up after a waiter has
    /// started again on the same cell; the waiter's result is put back.
    fn keep(&self, key: &Key, cell: &Cell) {
        let mut guard = self.cells.lock().unwrap_or_else(|e| e.into_inner());
        let (map, order) = &mut *guard;
        if !map.contains_key(key) {
            map.insert(key.clone(), cell.clone());
            order.push_back(key.clone());
            while order.len() > self.capacity {
                if let Some(old) = order.pop_front() {
                    map.remove(&old);
                }
            }
        }
    }

    /// Removes this caller's cell, not one another caller has since put
    /// under the key.
    fn forget(&self, key: &Key, cell: &Cell) {
        let mut guard = self.cells.lock().unwrap_or_else(|e| e.into_inner());
        let (map, order) = &mut *guard;
        if map.get(key).is_some_and(|c| Arc::ptr_eq(c, cell)) {
            map.remove(key);
            order.retain(|k| k != key);
        }
    }

    #[cfg(test)]
    fn cached(&self) -> usize {
        self.cells.lock().unwrap().0.len()
    }
}

/// Runs file work off the async threads and stops waiting for it at
/// `until`: a stalled disk costs the caller a timeout, not a hang. The
/// abandoned thread finishes, or stalls, on its own.
async fn blocking<T: Send + 'static>(until: Instant, work: impl FnOnce() -> Result<T, AnalysisError> + Send + 'static) -> Result<T, AnalysisError> {
    match tokio::time::timeout_at(tokio::time::Instant::from_std(until), tokio::task::spawn_blocking(work)).await {
        Err(_) => Err(AnalysisError::AnalysisTimeout),
        Ok(Err(_)) => Err(AnalysisError::DecodeFailed),
        Ok(Ok(r)) => r,
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

    const BUDGET: Duration = Duration::from_secs(20);

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
        let first = a.get_with(job(path.clone()), later(), BUDGET, counted).await.unwrap();
        let second = a.get_with(job(path), later(), BUDGET, counted).await.unwrap();
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
        a.get_with(with(vec![(0, 2_000), (2_000, 4_410)]), later(), BUDGET, counted).await.unwrap();
        a.get_with(with(vec![(0, 2_205), (2_205, 4_410)]), later(), BUDGET, counted).await.unwrap();
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
        let (x, y) = tokio::join!(a.get_with(job(path.clone()), later(), BUDGET, slow), a.get_with(job(path), later(), BUDGET, slow));
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
            a.get_with(job(files[0].clone()), later(), BUDGET, tracked),
            a.get_with(job(files[1].clone()), later(), BUDGET, tracked),
            a.get_with(job(files[2].clone()), later(), BUDGET, tracked),
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
        assert!(a.get_with(job(path), later(), BUDGET, grows).await.is_ok());
        assert_eq!(a.cached(), 0);
    }

    #[tokio::test]
    async fn the_oldest_entry_goes_past_capacity() {
        let a = Analyses::new(2, 2);
        for _ in 0..3 {
            let path = wav(44_100, 1, &sine(44_100, 440.0, 0.1, 0.5));
            a.get(job(path), later(), BUDGET).await.unwrap();
        }
        assert_eq!(a.cached(), 2);
    }

    #[tokio::test]
    async fn a_missing_file_fails_before_any_slot_is_taken() {
        let a = Analyses::new(2, 256);
        let r = a.get(job(PathBuf::from("/Users/someone/gone.wav")), later(), BUDGET).await;
        assert_eq!(r.err(), Some(AnalysisError::FileMissing));
        assert_eq!(a.cached(), 0);
    }

    #[tokio::test]
    async fn a_passed_deadline_is_a_timeout() {
        let a = Analyses::new(2, 256);
        let path = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        assert_eq!(a.get(job(path), Instant::now(), BUDGET).await.err(), Some(AnalysisError::AnalysisTimeout));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn waiting_for_a_slot_does_not_spend_the_budget() {
        fn slow(p: &Path, r: &[(u64, u64)], s: Option<&[(u64, u64)]>, d: Instant) -> Result<Stats, AnalysisError> {
            std::thread::sleep(Duration::from_millis(400));
            analyse(p, r, s, d)
        }
        let a = Analyses::new(1, 256);
        let first = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        let second = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        let (x, y) = tokio::join!(a.get_with(job(first), later(), BUDGET, slow), async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            a.get_with(job(second), later(), Duration::from_millis(300), analyse).await
        });
        assert!(x.is_ok() && y.is_ok(), "{:?}", y.err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_run_that_ignores_its_deadline_is_abandoned_at_it() {
        // A stalled disk: the read blocks and never checks the deadline.
        fn stalled(p: &Path, r: &[(u64, u64)], s: Option<&[(u64, u64)]>, d: Instant) -> Result<Stats, AnalysisError> {
            std::thread::sleep(Duration::from_secs(3));
            analyse(p, r, s, d)
        }
        let a = Analyses::new(2, 256);
        let path = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        let start = Instant::now();
        let r = a.get_with(job(path), later(), Duration::from_millis(200), stalled).await;
        assert_eq!(r.err(), Some(AnalysisError::AnalysisTimeout));
        assert!(start.elapsed() < Duration::from_secs(1), "{:?}", start.elapsed());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_failed_caller_does_not_drop_a_waiters_result() {
        // The first run fails; the waiter on the same key runs again and
        // succeeds after the failed caller has cleaned up.
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        fn flaky(p: &Path, r: &[(u64, u64)], s: Option<&[(u64, u64)]>, d: Instant) -> Result<Stats, AnalysisError> {
            if RUNS.fetch_add(1, Ordering::SeqCst) == 0 {
                std::thread::sleep(Duration::from_millis(50));
                return Err(AnalysisError::DecodeFailed);
            }
            std::thread::sleep(Duration::from_millis(200));
            analyse(p, r, s, d)
        }
        let a = Analyses::new(2, 256);
        let path = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        let (x, y) = tokio::join!(a.get_with(job(path.clone()), later(), BUDGET, flaky), a.get_with(job(path), later(), BUDGET, flaky));
        assert!(x.is_err() != y.is_err(), "{x:?} {y:?}");
        assert_eq!(a.cached(), 1);
    }
}
