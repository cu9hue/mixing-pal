use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PollKind {
    TrackState,
    Faders,
    Selection,
    FocusedNotes,
    Meters,
}

impl PollKind {
    pub fn all() -> Vec<PollKind> {
        vec![
            PollKind::TrackState,
            PollKind::Faders,
            PollKind::Selection,
            PollKind::FocusedNotes,
            PollKind::Meters,
        ]
    }

    /// Rates come from the spec and are not tunable at runtime.
    pub fn interval(&self) -> Duration {
        match self {
            PollKind::TrackState => Duration::from_secs(2),
            PollKind::Faders => Duration::from_secs(2),
            PollKind::Meters => Duration::from_secs(2),
            PollKind::Selection => Duration::from_secs(1),
            PollKind::FocusedNotes => Duration::from_millis(1_500),
        }
    }

    /// Stable, non-Debug ordering key so `due()`'s output order doesn't
    /// depend on derive(Debug) formatting.
    fn order(&self) -> u8 {
        match self {
            PollKind::TrackState => 0,
            PollKind::Faders => 1,
            PollKind::Selection => 2,
            PollKind::FocusedNotes => 3,
            PollKind::Meters => 4,
        }
    }
}

pub struct PollSchedule {
    last: HashMap<PollKind, Instant>,
}

impl PollSchedule {
    pub fn new(now: Instant) -> Self {
        let mut last = HashMap::new();
        for kind in PollKind::all() {
            last.insert(kind, now);
        }
        Self { last }
    }

    pub fn due(&self, now: Instant) -> Vec<PollKind> {
        let mut due: Vec<PollKind> = PollKind::all()
            .into_iter()
            .filter(|k| {
                self.last
                    .get(k)
                    .map(|t| now.duration_since(*t) >= k.interval())
                    .unwrap_or(true)
            })
            .collect();
        due.sort_by_key(|k| k.order());
        due
    }

    pub fn mark(&mut self, kind: PollKind, now: Instant) {
        self.last.insert(kind, now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn each_poll_kind_fires_at_its_own_rate() {
        let start = Instant::now();
        let mut s = PollSchedule::new(start);

        // Nothing is due immediately after marking everything fresh.
        for kind in PollKind::all() {
            s.mark(kind, start);
        }
        assert!(s.due(start).is_empty());

        // Selection is 1s, notes 1.5s, track state and meters 2s.
        let at_1s = start + Duration::from_millis(1_050);
        assert_eq!(s.due(at_1s), vec![PollKind::Selection]);

        let at_1_5s = start + Duration::from_millis(1_550);
        let due = s.due(at_1_5s);
        assert!(due.contains(&PollKind::Selection));
        assert!(due.contains(&PollKind::FocusedNotes));
        assert!(!due.contains(&PollKind::TrackState));

        let at_2s = start + Duration::from_millis(2_050);
        let due = s.due(at_2s);
        assert!(due.contains(&PollKind::TrackState));
        assert!(due.contains(&PollKind::Faders));
        assert!(due.contains(&PollKind::Meters));
    }
}
