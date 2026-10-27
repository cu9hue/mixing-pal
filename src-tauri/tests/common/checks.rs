//! Wording checks that read `shared/known-words.json`.

use super::{Span, form_end, is_word, prose_spans};

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

/// One defect per studio word the prose uses that Live does not show and the
/// answer did not list for her to tap. Same reading of the prose as
/// `tappable`: whole words, any `form_end` form, never inside code or a «name».
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
