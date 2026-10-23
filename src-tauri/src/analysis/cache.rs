//! One analysis per file state and region, shared by every caller that asks
//! for it while it runs, at most two running at once, off the async runtime.

use super::decode::{file_state, AnalysisError};
use super::{analyse, Stats};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::{OnceCell, Semaphore};

pub const CAPACITY: usize = 256;
pub const CONCURRENT: usize = 2;
/// The most a file's size and date may take to read. A drive that does not
/// answer within it is reported, not waited on.
const FILE_WAIT: Duration = Duration::from_secs(2);
/// File reads given up on while still blocked. At this many, no more start,
/// so a drive that has gone away does not use up the blocking threads.
const MAX_STALLED: usize = 16;
/// A file dated this recently may be saved again, at the same size, within
/// its date's resolution (2 s on FAT32): its result is answered, not kept.
const SETTLE: Duration = Duration::from_secs(2);

pub type Run = fn(&Path, &[(u64, u64)], Option<&[(u64, u64)]>, Instant) -> Result<Stats, AnalysisError>;
type State = fn(&Path) -> Result<(u64, SystemTime), AnalysisError>;

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

/// A run's outcome, failures included, so every caller waiting on the run
/// gets it. A failure is dropped once answered: the next call tries again.
type Cell = Arc<OnceCell<Result<Arc<Stats>, AnalysisError>>>;

pub struct Analyses {
    permits: Semaphore,
    cells: Mutex<(HashMap<Key, Cell>, VecDeque<Key>)>,
    capacity: usize,
    /// `file_state` outside tests.
    state: State,
    stalled: Arc<AtomicUsize>,
}

pub static ANALYSES: LazyLock<Analyses> = LazyLock::new(|| Analyses::new(CONCURRENT, CAPACITY));

impl Analyses {
    pub fn new(concurrent: usize, capacity: usize) -> Self {
        Analyses {
            permits: Semaphore::new(concurrent),
            cells: Mutex::new((HashMap::new(), VecDeque::new())),
            capacity,
            state: file_state,
            stalled: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub async fn get(&self, job: Job, wait_until: Instant, budget: Duration) -> Result<Arc<Stats>, AnalysisError> {
        self.get_with(job, wait_until, budget, analyse).await
    }

    /// `run` is `analyse` outside tests. A caller that finds the same key
    /// running waits for that run instead of starting another.
    ///
    /// `wait_until` bounds the wait for a slot; `budget` starts once the
    /// slot is free, so calls queued behind others still get their full
    /// analysis time.
    pub async fn get_with(&self, job: Job, wait_until: Instant, budget: Duration, run: Run) -> Result<Arc<Stats>, AnalysisError> {
        if Instant::now() >= wait_until {
            return Err(AnalysisError::AnalysisBusy);
        }
        let (size, modified) = self.file_state(&job.path).await?;
        let key = Key { job: job.clone(), size, modified };
        let cell = self.cell(&key);
        let outcome = match cell
            .get_or_try_init(|| async move {
                // Giving up on the slot is this caller's, not the run's: it is
                // not shared, and a waiter with longer to wait runs instead.
                let _permit = tokio::time::timeout_at(tokio::time::Instant::from_std(wait_until), self.permits.acquire())
                    .await
                    .map_err(|_| AnalysisError::AnalysisBusy)?
                    .map_err(|_| AnalysisError::AnalysisFailed)?;
                let deadline = Instant::now() + budget;
                Ok(self.blocking(deadline, move || run(&job.path, &job.regions, job.segments.as_deref(), deadline)).await.map(Arc::new))
            })
            .await
        {
            Ok(stored) => stored.clone(),
            Err(e) => Err(e),
        };
        // A file that changed while it was read, or was written moments
        // ago, is answered, not kept.
        let settled = SystemTime::now().duration_since(modified).is_ok_and(|age| age >= SETTLE);
        let unchanged = outcome.is_ok() && settled && self.file_state(&key.job.path).await.ok() == Some((size, modified));
        match (&outcome, unchanged) {
            (Ok(_), true) => self.keep(&key, &cell),
            (Ok(_), false) => self.forget(&key, &cell),
            // A stored failure is answered once: the next call tries again.
            (Err(_), _) if cell.get().is_some_and(Result::is_err) => self.forget(&key, &cell),
            // This caller gave up on the slot. The cell is left to the waiter
            // now running it, or that waiter's run has already filled it.
            (Err(_), _) => {}
        }
        outcome
    }

    async fn file_state(&self, path: &Path) -> Result<(u64, SystemTime), AnalysisError> {
        let (state, path) = (self.state, path.to_path_buf());
        self.blocking(Instant::now() + FILE_WAIT, move || state(&path)).await.map_err(|e| match e {
            AnalysisError::AnalysisTimeout => AnalysisError::FileUnreachable,
            e => e,
        })
    }

    /// The key's cell, now the most recently used.
    fn cell(&self, key: &Key) -> Cell {
        let mut guard = self.cells.lock().unwrap_or_else(|e| e.into_inner());
        let (map, order) = &mut *guard;
        if let Some(c) = map.get(key) {
            let c = c.clone();
            order.retain(|k| k != key);
            order.push_back(key.clone());
            return c;
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

    /// A caller who gave up may clean up after a waiter has started again
    /// on the same cell; the waiter's result is put back.
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

    /// Runs file work off the async threads and stops waiting for it at
    /// `until`: a stalled disk costs the caller a timeout, not a hang. The
    /// abandoned thread finishes, or stalls, on its own, and is counted
    /// until it does.
    async fn blocking<T: Send + 'static>(&self, until: Instant, work: impl FnOnce() -> Result<T, AnalysisError> + Send + 'static) -> Result<T, AnalysisError> {
        if self.stalled.load(Ordering::SeqCst) >= MAX_STALLED {
            return Err(AnalysisError::FileUnreachable);
        }
        let status = Arc::new(AtomicU8::new(RUNNING));
        let done = Finished(status.clone(), self.stalled.clone());
        let task = tokio::task::spawn_blocking(move || {
            let _done = done;
            work()
        });
        match tokio::time::timeout_at(tokio::time::Instant::from_std(until), task).await {
            Err(_) => {
                self.stalled.fetch_add(1, Ordering::SeqCst);
                if status.compare_exchange(RUNNING, ABANDONED, Ordering::SeqCst, Ordering::SeqCst).is_err() {
                    // It finished just now, so it is not stuck.
                    self.stalled.fetch_sub(1, Ordering::SeqCst);
                }
                Err(AnalysisError::AnalysisTimeout)
            }
            Ok(Err(e)) => {
                // A panic: a bug here, not a bad file. Its message has no path.
                eprintln!("sample analysis panicked: {e}");
                Err(AnalysisError::AnalysisFailed)
            }
            Ok(Ok(r)) => r,
        }
    }
}

const RUNNING: u8 = 0;
const FINISHED: u8 = 1;
const ABANDONED: u8 = 2;

/// Marks file work finished when it returns or panics, and uncounts it from
/// the stalled if its caller had given up on it.
struct Finished(Arc<AtomicU8>, Arc<AtomicUsize>);

impl Drop for Finished {
    fn drop(&mut self) {
        if self.0.swap(FINISHED, Ordering::SeqCst) == ABANDONED {
            self.1.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::signals::{sine, wav};

    fn job(path: PathBuf) -> Job {
        Job { path, regions: vec![(0, 4_410)], segments: None }
    }

    const BUDGET: Duration = Duration::from_secs(20);

    fn later() -> Instant {
        Instant::now() + Duration::from_secs(20)
    }

    /// A test file dated a minute back, as a sample on disk is: one written
    /// moments ago is not kept.
    fn aged(path: PathBuf) -> PathBuf {
        let file = std::fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(60)).unwrap();
        path
    }

    fn hung(_: &Path) -> Result<(u64, SystemTime), AnalysisError> {
        std::thread::sleep(Duration::from_secs(4));
        Err(AnalysisError::FileMissing)
    }

    #[tokio::test]
    async fn a_repeat_call_is_answered_from_the_cache() {
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        fn counted(p: &Path, r: &[(u64, u64)], s: Option<&[(u64, u64)]>, d: Instant) -> Result<Stats, AnalysisError> {
            RUNS.fetch_add(1, Ordering::SeqCst);
            analyse(p, r, s, d)
        }
        let a = Analyses::new(2, 256);
        let path = aged(wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5)));
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
            let path = aged(wav(44_100, 1, &sine(44_100, 440.0, 0.1, 0.5)));
            a.get(job(path), later(), BUDGET).await.unwrap();
        }
        assert_eq!(a.cached(), 2);
    }

    #[tokio::test]
    async fn an_entry_in_use_outlasts_one_that_is_not() {
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        fn counted(p: &Path, r: &[(u64, u64)], s: Option<&[(u64, u64)]>, d: Instant) -> Result<Stats, AnalysisError> {
            RUNS.fetch_add(1, Ordering::SeqCst);
            analyse(p, r, s, d)
        }
        let a = Analyses::new(2, 2);
        let files: Vec<_> = (0..3).map(|_| aged(wav(44_100, 1, &sine(44_100, 440.0, 0.1, 0.5)))).collect();
        for i in [0, 1, 0, 2, 0] {
            a.get_with(job(files[i].clone()), later(), BUDGET, counted).await.unwrap();
        }
        assert_eq!(RUNS.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_file_written_moments_ago_is_answered_but_not_kept() {
        // On FAT32 a second same-size save can keep the date to the second.
        let a = Analyses::new(2, 256);
        let path = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        assert!(a.get(job(path), later(), BUDGET).await.is_ok());
        assert_eq!(a.cached(), 0);
    }

    #[tokio::test]
    async fn a_missing_file_fails_before_any_slot_is_taken() {
        let a = Analyses::new(2, 256);
        let r = a.get(job(PathBuf::from("/Users/someone/gone.wav")), later(), BUDGET).await;
        assert_eq!(r.err(), Some(AnalysisError::FileMissing));
        assert_eq!(a.cached(), 0);
    }

    #[tokio::test]
    async fn a_passed_wait_is_busy() {
        let a = Analyses::new(2, 256);
        let path = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        assert_eq!(a.get(job(path), Instant::now(), BUDGET).await.err(), Some(AnalysisError::AnalysisBusy));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_call_that_waits_too_long_for_a_slot_is_told_busy() {
        fn slow(p: &Path, r: &[(u64, u64)], s: Option<&[(u64, u64)]>, d: Instant) -> Result<Stats, AnalysisError> {
            std::thread::sleep(Duration::from_millis(400));
            analyse(p, r, s, d)
        }
        let a = Analyses::new(1, 256);
        let first = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        let second = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        let (x, y) = tokio::join!(a.get_with(job(first), later(), BUDGET, slow), async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            a.get_with(job(second), Instant::now() + Duration::from_millis(100), BUDGET, analyse).await
        });
        assert!(x.is_ok());
        assert_eq!(y.err(), Some(AnalysisError::AnalysisBusy));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_drive_that_does_not_answer_is_unreachable_within_seconds() {
        let a = Analyses { state: hung, ..Analyses::new(2, 256) };
        let start = Instant::now();
        let r = a.get(job(PathBuf::from("/Volumes/nas/kick.wav")), later(), BUDGET).await;
        assert_eq!(r.err(), Some(AnalysisError::FileUnreachable));
        assert!(start.elapsed() < Duration::from_secs(3), "{:?}", start.elapsed());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn stuck_reads_stop_new_ones_from_starting() {
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        fn counted_hang(p: &Path) -> Result<(u64, SystemTime), AnalysisError> {
            CALLS.fetch_add(1, Ordering::SeqCst);
            hung(p)
        }
        let a = Arc::new(Analyses { state: counted_hang, ..Analyses::new(2, 256) });
        let mut calls = tokio::task::JoinSet::new();
        for i in 0..MAX_STALLED {
            let a = a.clone();
            calls.spawn(async move { a.get(job(PathBuf::from(format!("/Volumes/nas/{i}.wav"))), later(), BUDGET).await });
        }
        while calls.join_next().await.is_some() {}
        let r = a.get(job(PathBuf::from("/Volumes/nas/one-more.wav")), later(), BUDGET).await;
        assert_eq!(r.err(), Some(AnalysisError::FileUnreachable));
        assert_eq!(CALLS.load(Ordering::SeqCst), MAX_STALLED);
    }

    #[tokio::test]
    async fn a_run_that_panics_is_an_analysis_failure_not_a_bad_file() {
        fn panics(_: &Path, _: &[(u64, u64)], _: Option<&[(u64, u64)]>, _: Instant) -> Result<Stats, AnalysisError> {
            panic!("a bug in the analysis")
        }
        let a = Analyses::new(2, 256);
        let path = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        assert_eq!(a.get_with(job(path), later(), BUDGET, panics).await.err(), Some(AnalysisError::AnalysisFailed));
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
    async fn a_failed_run_answers_every_call_waiting_on_it() {
        // Copies of one clip along the arrangement: one run, one answer.
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        fn fails(_: &Path, _: &[(u64, u64)], _: Option<&[(u64, u64)]>, _: Instant) -> Result<Stats, AnalysisError> {
            RUNS.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(200));
            Err(AnalysisError::UnsupportedFormat)
        }
        let a = Analyses::new(2, 256);
        let path = aged(wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5)));
        let (x, y) = tokio::join!(a.get_with(job(path.clone()), later(), BUDGET, fails), a.get_with(job(path.clone()), later(), BUDGET, fails));
        assert_eq!((x.err(), y.err()), (Some(AnalysisError::UnsupportedFormat), Some(AnalysisError::UnsupportedFormat)));
        assert_eq!(RUNS.load(Ordering::SeqCst), 1);
        // Not kept: the next call tries again.
        assert_eq!(a.cached(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_call_told_busy_does_not_drop_a_waiters_result() {
        // One slot, held by another file. Two calls on one key: the first
        // gives up waiting, the second waits and runs.
        fn slow(p: &Path, r: &[(u64, u64)], s: Option<&[(u64, u64)]>, d: Instant) -> Result<Stats, AnalysisError> {
            std::thread::sleep(Duration::from_millis(300));
            analyse(p, r, s, d)
        }
        let a = Analyses::new(1, 256);
        let other = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        let path = aged(wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5)));
        let (_, x, y) = tokio::join!(
            a.get_with(job(other), later(), BUDGET, slow),
            async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                a.get_with(job(path.clone()), Instant::now() + Duration::from_millis(100), BUDGET, analyse).await
            },
            async {
                tokio::time::sleep(Duration::from_millis(80)).await;
                a.get_with(job(path.clone()), later(), BUDGET, analyse).await
            },
        );
        assert_eq!(x.err(), Some(AnalysisError::AnalysisBusy));
        assert!(y.is_ok(), "{y:?}");
        assert_eq!(a.cached(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_call_told_busy_leaves_the_run_to_its_waiters() {
        // One slot, held by another file. The first call on the key gives up,
        // the second runs it, and a third arrives during that run.
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        fn slow(p: &Path, r: &[(u64, u64)], s: Option<&[(u64, u64)]>, d: Instant) -> Result<Stats, AnalysisError> {
            std::thread::sleep(Duration::from_millis(400));
            analyse(p, r, s, d)
        }
        fn counted(p: &Path, r: &[(u64, u64)], s: Option<&[(u64, u64)]>, d: Instant) -> Result<Stats, AnalysisError> {
            RUNS.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(300));
            analyse(p, r, s, d)
        }
        let a = Analyses::new(1, 256);
        let other = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        let path = aged(wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5)));
        let (_, x, y, z) = tokio::join!(
            a.get_with(job(other), later(), BUDGET, slow),
            async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                a.get_with(job(path.clone()), Instant::now() + Duration::from_millis(100), BUDGET, counted).await
            },
            async {
                tokio::time::sleep(Duration::from_millis(80)).await;
                a.get_with(job(path.clone()), later(), BUDGET, counted).await
            },
            async {
                tokio::time::sleep(Duration::from_millis(550)).await;
                a.get_with(job(path.clone()), later(), BUDGET, counted).await
            },
        );
        assert_eq!(x.err(), Some(AnalysisError::AnalysisBusy));
        assert!(y.is_ok() && z.is_ok(), "{y:?} {z:?}");
        assert_eq!(RUNS.load(Ordering::SeqCst), 1);
    }
}
