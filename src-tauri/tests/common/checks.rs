//! Wording checks that read `shared/known-words.json`.

use super::{Span, ToolCallRecord, form_end, is_word, prose_spans};

#[derive(serde::Deserialize)]
pub struct KnownWords {
    pub known: Vec<String>,
    pub studio: Vec<StudioWord>,
}

#[derive(serde::Deserialize)]
pub struct StudioWord {
    pub word: String,
    pub live: String,
}

pub fn known_words() -> KnownWords {
    serde_json::from_str(include_str!("../../../shared/known-words.json"))
        .expect("shared/known-words.json must be valid JSON")
}

/// One defect per studio word the prose uses that Live does not show and the answer did not
/// list. Reads the prose as `tappable` does: whole words, never inside code or a «name».
pub fn studio_word_defects(prose: &str, listed_terms: &[String]) -> Vec<String> {
    let mut studio: Vec<(StudioWord, Vec<Vec<char>>)> = known_words()
        .studio
        .into_iter()
        .filter(|s| !listed_terms.iter().any(|t| t.trim().to_lowercase() == s.word.to_lowercase()))
        .map(|s| {
            let words = s.word.split(|c: char| c.is_whitespace() || c == '-').filter(|w| !w.is_empty()).map(|w| w.chars().collect()).collect();
            (s, words)
        })
        .collect();
    // "master bus" must win over "bus" at the same start.
    studio.sort_by_key(|(s, _)| std::cmp::Reverse(s.word.chars().count()));
    let mut defects: Vec<String> = Vec::new();
    for span in prose_spans(prose) {
        let Span::Text(chars, _) = span else { continue };
        let mut start = 0;
        while start < chars.len() {
            if is_word(start.checked_sub(1).map(|i| chars[i])) {
                start += 1;
                continue;
            }
            let fits = |end: usize| end == chars.len() || !is_word(Some(chars[end]));
            let hit = studio.iter().find_map(|(s, words)| form_end(&chars, start, words, fits).map(|end| (s, end)));
            let Some((s, end)) = hit else {
                start += 1;
                continue;
            };
            let defect = format!("{:?} is a studio word Live does not show; Live's word is {:?}", s.word, s.live);
            if !defects.contains(&defect) {
                defects.push(defect);
            }
            start = end;
        }
    }
    defects
}

/// A number with its unit, as written. `hundredths` keeps the sign and the
/// two decimals the comparison uses.
struct Value {
    text: String,
    unit: &'static str,
    hundredths: i64,
}

const UNITS: [(&str, &str); 6] = [("db", "dB"), ("ms", "ms"), ("s", "s"), ("hz", "Hz"), ("khz", "kHz"), ("bpm", "BPM")];

/// The unit at `at` after any spaces: a symbol, a `UNITS` word, or `: 1`.
/// A bare `s` needs a space, so `808s` and `80s` are plurals, not seconds.
fn unit_at(chars: &[char], at: usize) -> Option<(&'static str, usize)> {
    let spaced = |mut i: usize| {
        while i < chars.len() && matches!(chars[i], ' ' | '\u{a0}' | '\u{202f}') {
            i += 1;
        }
        i
    };
    let i = spaced(at);
    match chars.get(i)? {
        '%' => Some(("%", i + 1)),
        ':' => {
            let one = spaced(i + 1);
            (chars.get(one) == Some(&'1') && !chars.get(one + 1).is_some_and(|c| c.is_ascii_digit())).then_some(("n:1", one + 1))
        }
        c if c.is_ascii_alphabetic() => {
            let end = i + chars[i..].iter().take_while(|c| c.is_ascii_alphabetic()).count();
            let word = chars[i..end].iter().collect::<String>().to_lowercase();
            UNITS.iter().find(|(w, _)| *w == word && (*w != "s" || i > at)).map(|(_, unit)| (*unit, end))
        }
        _ => None,
    }
}

/// Where the number that starts at `start` ends: digits, `1,200` groups, one
/// decimal point.
fn number_end(chars: &[char], start: usize) -> usize {
    let digit = |i: usize| chars.get(i).is_some_and(|c| c.is_ascii_digit());
    let mut i = start;
    while digit(i) || (chars.get(i) == Some(&',') && (1..=3).all(|k| digit(i + k)) && !digit(i + 4)) {
        i += 1;
    }
    if chars.get(i) == Some(&'.') && digit(i + 1) {
        i += 1;
        while digit(i) {
            i += 1;
        }
    }
    i
}

/// Words that put a following `set` in the imperative: "then set it to".
/// After any other word it describes the device: "a Compressor set to".
const BEFORE_AN_INSTRUCTION: [&str; 17] =
    ["and", "then", "or", "to", "just", "also", "please", "maybe", "could", "should", "can", "would", "will", "might", "must", "you", "i"];

/// Whether `by`, `to`, `try` or an imperative `set` sits within three words
/// before `at`, in the same sentence: a change, not a claim.
fn follows_a_change_word(chars: &[char], at: usize) -> bool {
    let before: String = chars[..at].iter().collect();
    let tokens: Vec<&str> = before.split_whitespace().rev().take(4).collect();
    let word = |i: usize| tokens[i].trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
    let instruction = |i: usize| match tokens.get(i + 1) {
        None => true,
        Some(t) => t.ends_with(['.', '!', '?', ';', ',', ':']) || BEFORE_AN_INSTRUCTION.contains(&word(i + 1).as_str()),
    };
    for i in 0..tokens.len().min(3) {
        if tokens[i].ends_with(['.', '!', '?', ';']) {
            return false;
        }
        match word(i).as_str() {
            "by" | "try" => return true,
            "set" if instruction(i) => return true,
            "to" if tokens.get(i + 1).is_none() || word(i + 1) != "set" || instruction(i + 1) => return true,
            _ => {}
        }
    }
    false
}

/// Every value in `chars`, left to right. A `-`, `−` or `+` touching the
/// number is its sign unless a letter or digit precedes it, as in `10-20 ms`.
fn values_in(chars: &[char], claims_only: bool) -> Vec<Value> {
    let mut found = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() || (i > 0 && chars[i - 1].is_alphanumeric()) {
            i += 1;
            continue;
        }
        let digits_end = number_end(chars, i);
        let Some((unit, end)) = unit_at(chars, digits_end) else {
            i = digits_end;
            continue;
        };
        let sign = i.checked_sub(1).map(|j| chars[j]).filter(|c| matches!(c, '-' | '\u{2212}' | '+'));
        let signed = sign.is_some() && !(i >= 2 && chars[i - 2].is_alphanumeric());
        let start = if signed { i - 1 } else { i };
        let number: f64 = chars[i..digits_end].iter().filter(|c| **c != ',').collect::<String>().parse().unwrap_or(0.0);
        let magnitude = (number * 100.0).round() as i64;
        if !claims_only || !follows_a_change_word(chars, start) {
            found.push(Value {
                text: chars[start..end].iter().collect(),
                unit,
                hundredths: if signed && sign != Some('+') { -magnitude } else { magnitude },
            });
        }
        i = end;
    }
    found
}

fn collect_strings(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(s) => out.push(s.clone()),
        serde_json::Value::Array(items) => items.iter().for_each(|v| collect_strings(v, out)),
        serde_json::Value::Object(map) => map.values().for_each(|v| collect_strings(v, out)),
        _ => {}
    }
}

/// One defect per stated value (dB, ms, s, Hz, kHz, %, BPM, n:1) that no tool result or
/// context value shows, sign kept. Changes, code and «names» are skipped.
pub fn value_defects(prose: &str, calls: &[ToolCallRecord], context: &str) -> Vec<String> {
    let mut strings = vec![context.to_string()];
    for call in calls.iter().filter(|c| c.missing_reason.is_none()) {
        collect_strings(&call.result, &mut strings);
    }
    let evidence: Vec<Value> = strings
        .iter()
        .flat_map(|s| values_in(&s.chars().filter(|c| !matches!(c, '«' | '»')).collect::<Vec<_>>(), false))
        .collect();
    let mut defects: Vec<String> = Vec::new();
    for span in prose_spans(prose) {
        let Span::Text(chars, _) = span else { continue };
        for stated in values_in(&chars, true) {
            if evidence.iter().any(|e| e.unit == stated.unit && e.hundredths == stated.hundredths) {
                continue;
            }
            let defect = match evidence.iter().find(|e| e.unit == stated.unit && e.hundredths == -stated.hundredths) {
                Some(e) => format!("{:?} is stated, but the tools show {:?}: only the sign differs", stated.text, e.text),
                None => format!("{:?} is stated, but no tool result shows it", stated.text),
            };
            if !defects.contains(&defect) {
                defects.push(defect);
            }
        }
    }
    defects
}

/// True when the successful `get_arrangement` reads together span `[from_beat, to_beat)`.
/// A missing or null bound is open on that side, as in the tool; `track` is not considered.
pub fn arrangement_covers(calls: &[ToolCallRecord], from_beat: f64, to_beat: f64) -> bool {
    let mut ranges: Vec<(f64, f64)> = calls
        .iter()
        .filter(|c| c.name == "get_arrangement" && c.missing_reason.is_none())
        .map(|c| {
            (
                c.args["start_beats"].as_f64().unwrap_or(f64::NEG_INFINITY),
                c.args["end_beats"].as_f64().unwrap_or(f64::INFINITY),
            )
        })
        .collect();
    ranges.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut reached = from_beat;
    for (start, end) in ranges {
        if start > reached {
            break;
        }
        reached = reached.max(end);
    }
    reached >= to_beat
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A successful read whose result holds `values` as strings.
    fn read(values: &[&str]) -> ToolCallRecord {
        ToolCallRecord::new("get_device_params".into(), json!({}), json!({ "missing_reason": null, "value": values }))
    }

    /// A `get_arrangement` call with `args`; `missing` makes it a failed read.
    fn arrangement(args: serde_json::Value, missing: bool) -> ToolCallRecord {
        let result = if missing { json!({ "missing_reason": "not_connected" }) } else { json!({ "missing_reason": null }) };
        ToolCallRecord::new("get_arrangement".into(), args, result)
    }

    #[test]
    fn an_unranged_read_covers_everything() {
        assert!(arrangement_covers(&[arrangement(json!({}), false)], 60.0, 68.0));
        assert!(arrangement_covers(&[arrangement(json!({ "track": 0 }), false)], 60.0, 68.0));
    }

    #[test]
    fn the_10_27_drop_reads_do_not_cover_the_boundary() {
        let calls = [
            arrangement(json!({ "start_beats": 64, "end_beats": 96 }), false),
            arrangement(json!({ "start_beats": 128, "end_beats": 160 }), false),
        ];
        assert!(!arrangement_covers(&calls, 60.0, 68.0));
    }

    #[test]
    fn two_ranges_that_meet_cover_the_boundary() {
        let calls = [
            arrangement(json!({ "start_beats": 64, "end_beats": 96 }), false),
            arrangement(json!({ "start_beats": 0, "end_beats": 64 }), false),
        ];
        assert!(arrangement_covers(&calls, 60.0, 68.0));
    }

    #[test]
    fn a_missing_bound_is_open_on_that_side() {
        assert!(arrangement_covers(&[arrangement(json!({ "end_beats": 96 }), false)], 60.0, 68.0));
        assert!(arrangement_covers(&[arrangement(json!({ "start_beats": 32 }), false)], 60.0, 68.0));
        assert!(!arrangement_covers(&[arrangement(json!({ "start_beats": 64 }), false)], 60.0, 68.0));
    }

    #[test]
    fn a_missing_read_covers_nothing() {
        assert!(!arrangement_covers(&[arrangement(json!({}), true)], 60.0, 68.0));
        assert!(!arrangement_covers(&[], 60.0, 68.0));
    }

    #[test]
    fn another_tool_covers_nothing() {
        let other = ToolCallRecord::new("get_clips".into(), json!({}), json!({ "missing_reason": null }));
        assert!(!arrangement_covers(&[other], 60.0, 68.0));
    }

    #[test]
    fn a_studio_word_in_prose_is_a_defect_unless_listed() {
        let defects = studio_word_defects("Pull the fader down.", &[]);
        assert_eq!(defects.len(), 1, "{defects:?}");
        assert!(defects[0].contains("fader") && defects[0].contains("volume"), "{defects:?}");
        assert!(studio_word_defects("Pull the fader down.", &["fader".to_string()]).is_empty());
    }

    #[test]
    fn a_studio_word_in_a_set_name_or_code_is_not_flagged() {
        assert!(studio_word_defects("Mute «Bus».", &[]).is_empty());
        assert!(studio_word_defects("Use `aux`.", &[]).is_empty());
    }

    #[test]
    fn a_two_word_studio_word_is_one_defect() {
        let defects = studio_word_defects("Route the master bus and the channel strips.", &[]);
        assert_eq!(defects.len(), 2, "{defects:?}");
        assert!(defects[0].contains("master bus") && defects[0].contains("Main"), "{defects:?}");
        assert!(defects[1].contains("channel strip") && defects[1].contains("track"), "{defects:?}");
    }

    #[test]
    fn whole_words_only() {
        assert!(studio_word_defects("busy", &[]).is_empty());
    }

    #[test]
    fn a_dropped_minus_sign_is_a_value_defect() {
        let defects = value_defects("an 18 dB threshold", &[read(&["«-18.0 dB»"])], "");
        assert_eq!(defects.len(), 1, "{defects:?}");
        assert!(defects[0].contains("18 dB") && defects[0].contains("-18.0 dB"), "{defects:?}");
    }

    #[test]
    fn unicode_minus_and_decimals_match() {
        let calls = [read(&["«-18.0 dB»", "«4.00 : 1»", "«10.0 ms»"])];
        let defects = value_defects("−18 dB, 4:1 and 10 ms", &calls, "");
        assert!(defects.is_empty(), "{defects:?}");
        assert!(value_defects("+10.00 ms", &calls, "").is_empty());
    }

    #[test]
    fn a_change_is_not_a_claim() {
        let calls = [read(&["«10.0 ms»"])];
        assert!(value_defects("lower Threshold by 3 dB", &calls, "").is_empty());
        assert!(value_defects("set it to -20 dB", &calls, "").is_empty());
        assert!(value_defects("Then you could set the ratio to 8:1.", &calls, "").is_empty());
        assert!(value_defects("try 6:1 here", &calls, "").is_empty());
        // A sentence ends the look-back.
        assert_eq!(value_defects("Set it. The attack is 2 ms.", &calls, "").len(), 1);
    }

    #[test]
    fn a_set_to_that_describes_the_device_is_a_claim() {
        let calls = [read(&["«-18.0 dB»", "«4.00 : 1»"])];
        assert_eq!(value_defects("The Vox has a Compressor set to 18 dB.", &calls, "").len(), 1);
        assert_eq!(value_defects("The ratio is set to 8:1.", &calls, "").len(), 1);
        assert_eq!(value_defects("Compressor set to 18 dB threshold", &calls, "").len(), 1);
        assert!(value_defects("set it to -20 dB", &calls, "").is_empty());
        assert!(value_defects("The ratio is set to 4:1.", &calls, "").is_empty());
    }

    #[test]
    fn the_context_block_is_evidence_too() {
        let context = "SET  132 BPM · A Minor\n 3 «Vox» -8.0 dB";
        assert!(value_defects("At 132 BPM the Vox sits at −8 dB.", &[], context).is_empty());
        assert_eq!(value_defects("At 128 BPM.", &[], context).len(), 1);
        assert_eq!(value_defects("At 132 BPM.", &[], "").len(), 1);
    }

    #[test]
    fn a_value_with_no_evidence_is_a_defect() {
        let defects = value_defects("a 2 ms attack", &[read(&["«10.0 ms»"])], "");
        assert_eq!(defects.len(), 1, "{defects:?}");
        assert!(defects[0].contains("2 ms"), "{defects:?}");
    }

    #[test]
    fn the_unit_must_match_too() {
        assert_eq!(value_defects("10 s", &[read(&["«10.0 ms»"])], "").len(), 1);
        assert_eq!(value_defects("a 3 dB boost", &[read(&["«3.0 %»"])], "").len(), 1);
        assert!(value_defects("a 3 % boost", &[read(&["«3.0 %»"])], "").is_empty());
    }

    #[test]
    fn only_successful_reads_are_evidence() {
        let failed = ToolCallRecord::new(
            "get_device_params".into(),
            json!({}),
            json!({ "missing_reason": "no_such_target", "value": ["«-18.0 dB»"] }),
        );
        assert_eq!(value_defects("-18 dB", &[failed], "").len(), 1);
    }

    #[test]
    fn things_that_are_not_values_are_not_flagged() {
        let calls = [read(&["«-18.0 dB»"])];
        let prose = "In bar 17, play 1/8 notes on the 2nd beat of «Drop 2», track 3, at 3:30. The `10 ms` stays.";
        assert!(value_defects(prose, &calls, "").is_empty(), "{:?}", value_defects(prose, &calls, ""));
        assert!(value_defects("3 songs, 5 seconds, 4:10", &calls, "").is_empty());
    }

    #[test]
    fn a_plural_or_decade_is_not_seconds() {
        let calls = [read(&["«10.0 ms»"])];
        assert!(value_defects("808s and 909s from the 80s, 1/4s too", &calls, "").is_empty());
        assert!(value_defects("an 80s-style pad", &calls, "").is_empty());
        assert_eq!(value_defects("a 5 s tail", &calls, "").len(), 1);
    }

    #[test]
    fn a_repeated_value_is_one_defect() {
        assert_eq!(value_defects("2 ms now, 2 ms later", &[read(&["«10.0 ms»"])], "").len(), 1);
    }

    /// The three compressor answers and their `get_device_params` reads, copied
    /// from the 10-27 run. Run 2 states "18 dB" where Live shows -18.0 dB.
    #[test]
    fn the_value_check_agrees_with_the_10_27_compressor_runs() {
        #[derive(serde::Deserialize)]
        struct Run {
            answer: String,
            calls: Vec<ToolCallRecord>,
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            runs: Vec<Run>,
        }
        let fixture: Fixture = serde_json::from_str(include_str!("../fixtures/values-2026-10-27.json")).unwrap();
        let defects: Vec<Vec<String>> = fixture.runs.iter().map(|r| value_defects(&r.answer, &r.calls, "")).collect();
        assert_eq!(defects.len(), 3);
        assert!(defects[0].is_empty(), "{defects:?}");
        assert!(defects[1].is_empty(), "{defects:?}");
        assert_eq!(defects[2].len(), 1, "{defects:?}");
        assert!(defects[2][0].contains("18 dB") && defects[2][0].contains("-18.0 dB"), "{defects:?}");
    }
}
