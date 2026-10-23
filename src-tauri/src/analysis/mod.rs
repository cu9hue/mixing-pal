//! What a sample's played region contains: level, spectrum, stereo, pitch and
//! transients, measured from the file in the app. Nothing here describes the
//! mix: the region is read before clip gain, warping, devices and the fader.

pub mod decode;
pub mod levels;
pub mod spectrum;
pub mod stereo;
#[cfg(test)]
pub(crate) mod signals;

/// A measured value, or why there is none. Never 0 in place of a reason.
pub type Stat = Result<f64, &'static str>;

pub(crate) fn amp_db(x: f64) -> Stat {
    if x > 0.0 { Ok(20.0 * x.log10()) } else { Err("silent") }
}

pub(crate) fn power_db(x: f64) -> Stat {
    if x > 0.0 { Ok(10.0 * x.log10()) } else { Err("silent") }
}

/// Which profile segment a stream position falls in. Positions only grow, so
/// the cursor only moves forward.
pub(crate) struct Segments {
    ranges: Vec<(u64, u64)>,
    cursor: usize,
}

impl Segments {
    pub fn new(ranges: Vec<(u64, u64)>) -> Self {
        Segments { ranges, cursor: 0 }
    }

    pub fn at(&mut self, position: u64) -> Option<usize> {
        while self.cursor < self.ranges.len() && self.ranges[self.cursor].1 <= position {
            self.cursor += 1;
        }
        (self.cursor < self.ranges.len() && self.ranges[self.cursor].0 <= position).then_some(self.cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_position_finds_its_segment_and_gaps_find_none() {
        let mut s = Segments::new(vec![(0, 10), (20, 30)]);
        assert_eq!((s.at(0), s.at(9), s.at(10), s.at(20), s.at(29), s.at(30)), (Some(0), Some(0), None, Some(1), Some(1), None));
    }

    #[test]
    fn silence_has_no_decibels() {
        assert_eq!(amp_db(0.0), Err("silent"));
        assert!((amp_db(0.5).unwrap() + 6.0206).abs() < 1e-3);
        assert!((power_db(0.01).unwrap() + 20.0).abs() < 1e-9);
    }
}
