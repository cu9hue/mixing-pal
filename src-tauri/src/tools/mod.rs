pub mod arrangement;
pub mod clip_notes;
pub mod clips;
pub mod device_chains;
pub mod device_params;
pub mod fence;
pub mod mixer;
pub mod path;
pub mod rack_contents;
pub mod sample;
pub mod track_detail;

use crate::deltas::Coalescer;
use crate::osc::query::{LiveQuery, QueryError};
use crate::tools::path::DevicePath;
use serde::Serialize;
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// What every tool result carries, so the model can tell "Live said zero"
/// from "Live said nothing" from "too large to send" -- and, for a mirror
/// read, how old the value is. Told the age rather than left to imply live
/// truth.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolResult {
    /// `null` when the call produced nothing at all.
    ///
    /// A value AND a `missing_reason` together is a real state, not a
    /// contradiction: a paged clip read that answered some windows and not
    /// others returns the notes it got with `missing_reason: "too_large"`.
    /// `fresh` is false in that case, and the model is expected to say the
    /// read was partial rather than present it as the whole clip.
    pub value: serde_json::Value,
    /// Epoch milliseconds at which this call ran.
    pub queried_at: u64,
    /// Epoch milliseconds at which the underlying value was last observed.
    /// Equal to `queried_at` for a live query; older for a mirror read.
    pub fresh_as_of: Option<u64>,
    pub fresh: bool,
    pub missing_reason: Option<String>,
}

/// Epoch millis. `pub(crate)` so `trace.rs` (via `lib.rs`) uses this exact
/// derivation for a step's `at` field instead of a second implementation.
pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl ToolResult {
    fn live(value: serde_json::Value, missing_reason: Option<String>) -> Self {
        let at = now_millis();
        Self {
            fresh: missing_reason.is_none(),
            value,
            queried_at: at,
            fresh_as_of: Some(at),
            missing_reason,
        }
    }

    fn missing(reason: &str) -> Self {
        Self {
            value: serde_json::Value::Null,
            queried_at: now_millis(),
            fresh_as_of: None,
            fresh: false,
            missing_reason: Some(reason.to_string()),
        }
    }
}

/// What `execute` needs to reach the two data sources.
#[derive(Clone)]
pub struct ToolContext {
    pub coalescer: Arc<Mutex<Coalescer>>,
    /// `None` until the OSC socket binds. Managed before the bind attempt so
    /// the command is always answerable: a tool that needs a live query then
    /// reports `not_connected` instead of the window failing with "state not
    /// managed".
    pub query: Arc<Mutex<Option<Arc<LiveQuery>>>>,
}

/// The complete set of tools the model may call.
///
/// Backend-owned. The webview passes a tool NAME and arguments, never a
/// definition, so it cannot widen this list -- see the spec's "Where the
/// split actually falls". The descriptions are part of the contract: they
/// are what tells the model that `get_track_detail` is a cached read and
/// `get_clip_notes` goes to Live.
pub fn tool_schema() -> serde_json::Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "get_track_detail",
                "description": "Mixer state for one track: name, fader position, fader in dB, pan, mute, solo. Read from a local mirror that is refreshed about every 2 seconds, so the result carries the age of the data. Does not include devices. For sends, routing, groups, return tracks, the master, and whether the fader or pan is automated, use get_mixer.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "track": { "type": "integer", "description": "Zero-based track index." }
                    },
                    "required": ["track"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_clip_notes",
                "description": "MIDI notes in the source note_range of one session-view clip. start is absolute source beat time as shown in Live's clip editor; duration is in quarter-note beats. source_start_beats is the playback start marker, not necessarily zero. note_range covers the markers and enabled loop and can include inactive source notes; only notes inside loop_region repeat. When the song's current signature is known, use each note's clip_position in producer-facing instructions: one-based bar.beat.sixteenth as Live displays it, the beat digit counting the signature's denominator unit, computed from the song signature (bar_positions_assume_current_signature). A +/- beats remainder is how far the note sits off the sixteenth grid: microtiming, a triplet, or swing, not a rounding error. duration_notation names a duration that is a plain note value. The result also gives source_length_beats and loop_region, with readable start_position/end_position when possible. A note with mute true does not sound and must be excluded from rhythm or harmony claims. A note with probability below 1 plays on only that share of passes. source_length_beats is Live's clip length, which is the loop length when looping is true. It is not a finite playback span: a looping clip's source notes repeat while the clip is launched. note is Ableton Live's displayed pitch label and is authoritative: octave labels vary between applications, so do not derive a different octave from pitch. Queried from Live at call time. A dense clip is fetched in pieces; if a piece cannot be read the result says so. Clip slot indices come from get_clips, which also says whether the track is MIDI; an audio clip has no notes to read. Source notes and loop state are checked before and after the read; clip_changed means discard and retry after the clip is stable. Output is paged at 1024 source notes. If next_note_offset is present, call again with that note_offset. Keep the clip unchanged between calls; source read errors remain separate from output paging. pre_midi_effects lists the top-level MIDI effects that are on, such as Scale, Chord or Arpeggiator, ahead of the track's instrument: they change the notes before they sound, so these are the notes the clip sends, not what plays. MIDI effects inside a Rack are not checked; open the Rack with get_rack_contents. pre_midi_effects_unread means the chain could not be read to check.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "note_offset": {"type":"integer","minimum":0,"description":"Start at this offset in the ordered source notes; use next_note_offset to continue a capped output."},
                        "track": { "type": "integer", "description": "Zero-based track index." },
                        "clip": { "type": "integer", "description": "Zero-based clip slot index within that track." }
                    },
                    "required": ["track", "clip"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_clips",
                "description": "Session-view clip overview: by default, reads the first 16 slots of each track and returns filled slots with their index and name, plus whether the track is MIDI. Supply track to read up to 1024 slots of that track, beginning at start_slot (default 0). Queried from Live at call time; slot names are read in bounded pages per track. Call this first to find out which clips exist and what their slot indices are, then use get_clip_notes to read one. Slot indices are the real ones and have gaps, because a producer's session grid does. An empty list means no filled slots in the returned scope; check missing and next_slot before claiming the whole track is empty. Arrangement-view clips are not covered. A track whose midi field is absent had its clips read but its kind unknown. Tracks that did not answer are listed separately under missing. The combined map also has an output byte budget. A next_slot means more slots remain: call again with that track and start_slot set to next_slot. Group tracks have no direct clips.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "track": {"type":"integer","minimum":0,"description":"Optional zero-based track index."},
                        "start_slot": {"type":"integer","minimum":0,"description":"Continue a selected track from next_slot. Requires track."}
                    },
                    "required": []
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_arrangement",
                "description": "Every track's arrangement placements: for each clip, its index, start_beats, length_beats, muted state, MIDI type, and its name when it has one. These are beats, never bar counts. A placement is audible only when muted is false; is_midi false means it is audio and has no MIDI notes. Each track carries its name when known. When the current time signature is known, each clip also has start_position, one-based bar.beat.sixteenth as Live shows it, and length_bars, and each track has first_unmuted_start, the start_position of its earliest unmuted placement in the returned scope. Use these when speaking about bars, never start_beats (in 4/4, start_beats 32 is 9.1.1). A loop_region is present when the clip loops, audio or MIDI: a MIDI clip's source notes repeat in that region through the clip's length_beats, so an absent note after one loop is not silence. A clip with no name field is unnamed, which is normal on the timeline - Live shows a derived label there and most producers never name an arrangement clip, so position is usually what identifies a clip rather than its name. Queried from Live at call time; placements are read in bounded pages per track. The context block's SECTIONS line names the producer's locators and their positions, but says nothing about what plays in them - this is how to find out. An empty list means no placements in the returned scope; check missing, changed, truncated and next_clip_index before claiming the whole timeline is empty. Session-view clips are not covered; use get_clips for those, and their slot indices are different numbers from these. Use the index reported here with get_arrangement_notes to read a MIDI clip's notes. Tracks that did not answer are listed separately under missing, and a track whose timeline was too long to read in full is marked truncated. For a section question, supply start_beats and end_beats to filter overlapping placements before the 512-placement output cap. To recover a truncated track, request its track index with next_clip_index as clip_offset; retain the same range. Group tracks have no direct placements; their child tracks carry them.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "track": {"type":"integer","minimum":0,"description":"Optional zero-based track index; omit to read all tracks."},
                        "start_beats": {"type":"number","minimum":0,"description":"Optional inclusive range start in beats; without end_beats the range runs to the end of the timeline. In 4/4 bars 17–32 are [64,128)."},
                        "end_beats": {"type":"number","exclusiveMinimum":0,"description":"Optional exclusive range end in beats; without start_beats the range starts at beat 0. Keeps placements that overlap the range, including clips starting before it."},
                        "clip_offset": {"type":"integer","minimum":0,"description":"Continue a selected track from next_clip_index. Requires track. Keep the same beat range when continuing."}
                    },
                    "required": []
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_arrangement_notes",
                "description": "The MIDI notes of one arrangement-view clip. view says which list notes is. With view played, notes lists what sounds, in song order: a source note appears once per loop pass, with timeline_position where it sounds in the song, clip_position where it lives in the clip, and pass, the loop pass it belongs to. When the clip loops, loop says so in words, such as \"a 1-bar loop of 4 notes played 2 times, bars 2-3\": say that when you describe the part. count is how many notes sound; source_notes is how many the clip holds, the number the producer sees in the clip editor. Describe the part by what plays: a 1-bar loop of four notes stretched over two bars is eight notes, four in each bar. Edits happen in the clip: deleting or moving a source note changes every pass. Give edit instructions by clip_position, and use timeline_position to say where a note sounds. To change one pass only, the producer must first consolidate or split the clip; say so. Muted source notes do not sound and must be excluded from rhythm or harmony claims; they are listed once under muted_notes. Supply start_beats and end_beats, song beats as in get_arrangement, to list only the notes that start sounding inside that range; a note held into the range from before it is not listed. When more than 256 notes would be listed, the clip is muted, or its notes cannot be placed, view is source and view_reason says why; a partial read or a note_offset above 0 also returns the source view, and a partial read leaves out source_notes. notes then lists each source note once: start is absolute source beat time as shown in Live's clip editor, and timeline_position is where the note first sounds in the song. Playback starts at the start marker and wraps from the loop end to the loop start, so a note before the marker can first sound on the second pass; a note with no timeline_position never sounds in this placement. A note with mute true does not sound. A looping clip repeats every repeats_every_beats (repeats_every_bars) until length_beats ends: loop_passes counts the passes through the loop in this placement, and loop_pass_starts gives where each pass begins in the song. Never call the portion after one loop silent. duration is in quarter-note beats. source_start_beats is the playback start marker. note_range covers the markers and enabled loop and can include inactive source notes; only notes inside loop_region repeat. When the current signature is known, use clip_position (source) or timeline_position (song) in producer-facing instructions: one-based bar.beat.sixteenth as Live displays it, the beat digit counting the signature's denominator unit. A +/- beats remainder is how far the note sits off the sixteenth grid: microtiming, a triplet, or swing, not a rounding error. duration_notation names a duration that is a plain note value. note is Ableton Live's displayed pitch label and is authoritative: octave labels vary between applications, so do not derive a different octave from pitch. A note with probability below 1 plays on only that share of passes; one at 0 never plays and is not listed as sounding. Queried from Live at call time and fetched in pages. The result includes start_beats and length_beats, which are beats, never bar counts; when the current signature is known it also includes start_position, one-based bar.beat.sixteenth, and length_bars. loop_region and note_range are in the clip's own source time, like clip_position, not song time. The index comes from get_arrangement and is that clip's position on the track's timeline - it is NOT a session slot index, and get_clip_notes will not accept it. The read is bracketed by an identity check: if the clip at that index changed while it was being read, which happens when a clip is added earlier in the timeline, the notes are refused rather than returned under the wrong clip's name. If its notes change during the read, the result is missing with clip_changed: read again once the clip is stable. An audio clip returns missing_reason not_midi_clip. In the source view, output is paged at 1024 source notes. If next_note_offset is present, call again with that note_offset. Keep the clip unchanged between calls; source read errors remain separate from output paging. pre_midi_effects lists the top-level MIDI effects that are on, such as Scale, Chord or Arpeggiator, ahead of the track's instrument: they change the notes before they sound, so these are the notes the clip sends, before those effects. MIDI effects inside a Rack are not checked; open the Rack with get_rack_contents. pre_midi_effects_unread means the chain could not be read to check.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "note_offset": {"type":"integer","minimum":0,"description":"Start at this offset in the ordered source notes; use next_note_offset to continue a capped output. Above 0 it returns the source view."},
                        "track": { "type": "integer", "description": "Zero-based track index." },
                        "index": { "type": "integer", "description": "The clip's position in that track's arrangement, as reported by get_arrangement." },
                        "start_beats": {"type":"number","minimum":0,"description":"Optional inclusive range start in song beats; without end_beats the range runs to the end of the clip. In 4/4 bars 2–3 are [4,12)."},
                        "end_beats": {"type":"number","exclusiveMinimum":0,"description":"Optional exclusive range end in song beats; without start_beats the range starts at beat 0."}
                    },
                    "required": ["track", "index"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_device_chains",
                "description": "The device chain on every regular track, in order, named as the producer named them. Return and master chains come from get_mixer. A Rack is listed as one device, marked [rack]; call get_rack_contents on it to see what is inside. When the producer renamed a device, Live's own name for it follows in parentheses: «Dorian #4» (Scale) is a Scale device. [instrument] and [midi effect] mark what a device is; an unmarked device is an audio effect, or one Live does not classify. [off] marks a device switched off right now, which may be automation at the playhead. Queried from Live at call time in bounded pages. Call this first to find out which devices exist and what their indices are, then use get_device_params to read one. An empty list means no devices in the returned scope; check missing and next_device_offset before claiming the whole track is empty. Tracks that did not answer are listed separately under missing. The combined map also has an output byte budget. Device indices equal device_offset plus the position in the returned list. If next_device_offset is present, request that track with device_offset set to it. An empty page describes only the returned scope.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "track": {"type":"integer","minimum":0,"description":"Optional zero-based track index."},
                        "device_offset": {"type":"integer","minimum":0,"description":"Continue a selected track from next_device_offset. Requires track."}
                    },
                    "required": []
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_mixer",
                "description": "The mixer, queried from Live at call time. For each track: volume and pan as Live shows them, its sends named by the return track each one feeds, its output routing, and group_track, the index of the Group it sits in. For each return track and the master: level, pan, and device chain, labelled as get_device_chains labels devices. A volume_automation, pan_automation, or send automation field means that control is automated: the value shown is only its value at the playhead, never the setting; \"overridden\" means the producer moved it off its automation. Routing and levels are settings, not sound: a send level says nothing about how loud the reverb is. Tracks, returns, or the master that did not answer are named in missing_reason. Supply track to read one track; returns and the master are always read.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "track": {"type":"integer","minimum":0,"description":"Optional zero-based track index; omit to read every track."}
                    },
                    "required": []
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_device_params",
                "description": "Every parameter of one device, as a name and a formatted value such as \"80.0 Hz\" or \"-12.0 dB\". Queried from Live at call time and fetched in pages. Device indices come from get_device_chains. The device's on/off switch is itself a parameter, conventionally the first one and named Device On, so a device listed in the chain may be switched off and this is how to find out. On a Rack this returns the Rack's own macros; for the devices inside it use get_rack_contents and then pass a longer path here. A device with more than 256 parameters is truncated and the result says so. Each call returns up to 256 parameters starting at offset (default 0). When next_offset is present, call again with that offset; parameter indices stay absolute. A parameter with automation \"automated\" is automated: its value is only the value at the playhead, never the setting; \"overridden\" means the producer moved it off its automation.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "offset": {"type":"integer","minimum":0,"description":"Parameter index to start at; use next_offset to continue a partial read."},
                        "track": { "type": "integer", "description": "Zero-based track index." },
                        "path": {
                            "type": "array",
                            "items": { "type": "integer" },
                            "description": "Zero-based indices from the track to the device, alternating device and chain: [2] is top-level device 2; [2, 0, 1] is device 1 in chain 0 of the rack at device 2. Always an odd number of entries, at most 9. Device indices come from get_device_chains, chain indices from get_rack_contents."
                        }
                    },
                    "required": ["track", "path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_rack_contents",
                "description": "What is inside one Rack: each chain in order, the devices on it, and for a Drum Rack the MIDI note of its pad with note_name as Live labels it (36 is C1), plus sample_name when Live exposes a sample file. Devices in a chain carry the same labels as in get_device_chains: [rack], [instrument], [midi effect], [off], and Live's own name when renamed. Keep descending those marked devices before claiming which pads a nested kit contains. A generic device name such as Simpler does not identify the sound; use sample_name or the producer's pad name, and do not claim a hat or kick when neither identifies it. Chains that are muted or soloed are marked; nothing is said about the others. Queried from Live at call time and fetched in pages. Use this when get_device_chains marks a device [rack]. An empty page describes only the requested scope; use is_rack and total_chains to distinguish a device that is not a Rack from an empty Rack. A rack with more than 128 chains is truncated and the result says so; a chain lists up to 32 devices beginning at device_offset. When next_device_offset is present, repeat with offset set to that chain index and device_offset set to next_device_offset. The device path index is device_offset plus the position in the returned device list. Chain indices from here go into the path of get_device_params to read a device inside the rack, or back into get_rack_contents for a rack nested inside a chain. Each call returns up to 128 chains starting at offset (default 0). When next_offset is present, call again with that offset; chain indices stay absolute.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "device_offset": {"type":"integer","minimum":0,"description":"Device index within each chain to start listing at. To continue one chain, set offset to its chain index and device_offset to its next_device_offset."},
                        "offset": {"type":"integer","minimum":0,"description":"Chain index to start at; use next_offset to continue a partial read."},
                        "track": { "type": "integer", "description": "Zero-based track index." },
                        "path": {
                            "type": "array",
                            "items": { "type": "integer" },
                            "description": "Zero-based indices from the track to the device, alternating device and chain: [2] is top-level device 2; [2, 0, 1] is device 1 in chain 0 of the rack at device 2. Always an odd number of entries, at most 9. Device indices come from get_device_chains, chain indices from get_rack_contents."
                        }
                    },
                    "required": ["track", "path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_sample",
                "description": "The sample behind one audio clip or one Simpler, read from Live at call time: the file name only (never its folder), the file's length and sample rate, warp (false or the mode, such as Complex), gain, transpose and detune, and region: the part of the file that plays, as seconds of the file, with plays saying it in words. For an arrangement clip, plays includes the bars and, when it loops, how many times, such as \"a 1-bar loop played 4 times\"; an unwarped loop is counted at the current tempo. A session clip says what it plays when launched. A Simpler gives its mode (Classic, One-Shot, Slice): in Classic and One-Shot the pitch follows the MIDI note and C3 plays the sample at its original pitch plus Transpose and Detune; in Slice, slices is the count and each note plays one slice. Pass exactly one of slot (a session clip, from get_clips), index (an arrangement clip, from get_arrangement) or path (a Simpler, as in get_device_params; a Drum Rack pad's Simpler is [rack, chain, device] from get_rack_contents). This describes the file and Live's settings, not what the mix sounds like: devices, the fader and the rest of the set are not in it. missing_reason not_audio_clip is a MIDI clip; empty_slot, no_such_target, not_a_simpler, no_sample (an empty Simpler), multisample_not_readable, sampler_not_readable and path_too_long say why nothing was read; region_unavailable keeps the settings without a region.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "track": { "type": "integer", "description": "Zero-based track index." },
                        "slot": { "type": "integer", "minimum": 0, "description": "A session clip slot, as reported by get_clips." },
                        "index": { "type": "integer", "minimum": 0, "description": "An arrangement clip's position on the track's timeline, as reported by get_arrangement." },
                        "path": {
                            "type": "array",
                            "items": { "type": "integer" },
                            "description": "Zero-based indices from the track to a Simpler, alternating device and chain, as in get_device_params. Always an odd number of entries, at most 9."
                        }
                    },
                    "required": ["track"]
                }
            }
        }
    ])
}

/// Reads a required integer argument. Absent or wrongly typed is reported,
/// never defaulted: answering about track 0 when the model asked about a
/// track it could not name is worse than answering nothing.
///
/// Accepts an f64 too, as long as it's integral: real providers commonly
/// emit floats for integer-typed fields (e.g. `{"track": 1.0}`). A
/// genuinely fractional value (`1.5`) is still refused, not truncated --
/// truncating would answer about a track the model never actually named.
fn int_arg(args: &serde_json::Value, name: &str) -> Option<i64> {
    let value = args.get(name)?;
    if let Some(i) = value.as_i64() {
        return Some(i);
    }
    let f = value.as_f64()?;
    (f.is_finite() && f.fract() == 0.0).then_some(f as i64)
}

/// The `(track, path)` pair both path-addressed tools take.
///
/// A refusal here never reaches the wire, which is the point: an even-length
/// or negative path would resolve inside Live's callback to a device nobody
/// asked about, and a negative index would resolve there rather than fail,
/// because Python slices from the end.
fn track_and_path(args: &serde_json::Value) -> Option<(i64, DevicePath)> {
    let track = int_arg(args, "track").filter(|t| (0..=i64::from(i32::MAX)).contains(t))?;
    Some((track, DevicePath::parse(args.get("path"))?))
}

/// get_sample's track and its one target. More than one target, or none, is
/// refused rather than guessed.
fn sample_target(args: &serde_json::Value) -> Option<(i64, sample::SampleTarget)> {
    let track = int_arg(args, "track").filter(|t| (0..=i64::from(i32::MAX)).contains(t))?;
    let given = ["slot", "index", "path"].iter().filter(|k| args.get(**k).is_some()).count();
    if given != 1 {
        return None;
    }
    let index = |name| int_arg(args, name).filter(|i| (0..=i64::from(i32::MAX)).contains(i)).map(|i| i as i32);
    let target = if args.get("slot").is_some() {
        sample::SampleTarget::Slot(index("slot")?)
    } else if args.get("index").is_some() {
        sample::SampleTarget::Index(index("index")?)
    } else {
        sample::SampleTarget::Device(DevicePath::parse(args.get("path"))?)
    };
    Some((track, target))
}

/// One track's mirrored name, used as its identity across a paged query.
///
/// Live resolves `song.tracks[i]` when it HANDLES a message, not when the
/// client sent it -- so a paged note fetch that straddles a track delete or
/// reorder reads a DIFFERENT clip for its later windows and merges the notes
/// into one answer. Sampling the name at both ends catches that. See the
/// spec's "A generation counter" section for why this beats a counter here:
/// a reorder leaves the track count untouched.
fn track_identity(coalescer: &Mutex<Coalescer>, track: i64) -> Option<serde_json::Value> {
    let c = coalescer.lock().ok()?;
    c.lookup("/live/track/get/name", &[json!(track)])?
        .args
        .get(1)
        .cloned()
}

/// The mirrored track count. `num_tracks` is `KeyArity::None`, so the mirror
/// holds it with no key args and the count is `args[0]`. Shared by
/// `get_device_chains`, which reads it once to size the whole-set fetch and
/// again afterward to detect a topology change.
fn track_count(coalescer: &Mutex<Coalescer>) -> Option<i64> {
    let c = coalescer.lock().ok()?;
    c.lookup("/live/song/get/num_tracks", &[])?
        .args
        .first()?
        .as_i64()
}

/// The currently mirrored global meter, when it can safely turn beat offsets
/// into the one-based bar labels producers use in conversation. A set can
/// change meter over time; the payload names this as the current signature,
/// so raw `*_beats` remain authoritative in that unusual case.
fn time_signature(coalescer: &Mutex<Coalescer>) -> Option<(i64, i64)> {
    let c = coalescer.lock().ok()?;
    let numerator = c
        .lookup("/live/song/get/signature_numerator", &[])?
        .args
        .first()?
        .as_i64()?;
    let denominator = c
        .lookup("/live/song/get/signature_denominator", &[])?
        .args
        .first()?
        .as_i64()?;
    (numerator > 0 && denominator > 0).then_some((numerator, denominator))
}

/// The grid Live's position display counts on. The beat digit counts the
/// signature's denominator unit, not quarter notes: 6/8 runs 1.1.1 to
/// 1.6.2, not 1.1.1 to 1.3.4. Positions here count the same way, so a
/// number the model repeats is one she can find on Live's ruler. Raw
/// `_beats` values stay quarter notes throughout, as Live's API has them.
struct Grid {
    /// Sixteenths in one denominator unit: 4 in x/4, 2 in x/8, 8 in x/2.
    sixteenths_per_beat: i64,
    sixteenths_per_bar: i64,
}

fn grid(signature: (i64, i64)) -> Option<Grid> {
    let (numerator, denominator) = signature;
    if numerator <= 0 || denominator <= 0 || 16 % denominator != 0 {
        return None;
    }
    let sixteenths_per_beat = 16 / denominator;
    Some(Grid { sixteenths_per_beat, sixteenths_per_bar: numerator * sixteenths_per_beat })
}

/// Quarter-note beats in one bar, for lengths expressed in bars.
fn beats_per_bar(signature: (i64, i64)) -> Option<f64> {
    let (numerator, denominator) = signature;
    let beats = numerator as f64 * 4.0 / denominator as f64;
    (beats.is_finite() && beats > 0.0).then_some(beats)
}

/// Snaps a quarter-note beat offset to the nearest sixteenth and keeps the
/// signed distance to it. Every bar number and position below starts here,
/// so a note 0.02 beats before a bar line is bar 9 minus 0.02 in every
/// field of a payload, never bar 8 in one and bar 9 in another.
fn nearest_sixteenth(beat: f64) -> Option<(i64, f64)> {
    if !beat.is_finite() || beat < 0.0 {
        return None;
    }
    let sixteenths = (beat * 4.0).round() as i64;
    Some((sixteenths, beat - sixteenths as f64 / 4.0))
}

/// Formats a beat offset as the bar.beat.sixteenth position producers see in
/// Live. The raw beat value stays in the payload; a remainder is the note's
/// distance off the sixteenth grid, shown rather than rounded away.
fn musical_position(beat: f64, grid: &Grid) -> Option<String> {
    let (sixteenths, remainder) = nearest_sixteenth(beat)?;
    let bar = sixteenths.div_euclid(grid.sixteenths_per_bar) + 1;
    let in_bar = sixteenths.rem_euclid(grid.sixteenths_per_bar);
    let position = format!(
        "{}.{}.{}",
        bar,
        in_bar / grid.sixteenths_per_beat + 1,
        in_bar % grid.sixteenths_per_beat + 1
    );
    if remainder.abs() <= 0.0001 {
        return Some(position);
    }
    let sign = if remainder.is_sign_negative() { "-" } else { "+" };
    let amount = format!("{:.6}", remainder.abs())
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_owned();
    Some(format!("{position} {sign} {amount} beats"))
}

/// The note value a duration is, when it is one. Anything else keeps only
/// its raw beats: "2/1 note" is not a name a producer uses for a two-bar
/// pad, and "3/4 note" reads as a time signature. Independent of the
/// signature, so it is present whether or not positions are.
fn duration_notation(duration: f64) -> Option<String> {
    if !duration.is_finite() || duration <= 0.0 {
        return None;
    }
    let sixteenths = (duration * 4.0).round() as i64;
    if (duration - sixteenths as f64 / 4.0).abs() > 0.0001 {
        return None;
    }
    let name = match sixteenths {
        1 => "1/16 note",
        2 => "1/8 note",
        3 => "dotted 1/8 note",
        4 => "1/4 note",
        6 => "dotted 1/4 note",
        8 => "1/2 note",
        12 => "dotted 1/2 note",
        16 => "whole note",
        _ => return None,
    };
    Some(name.to_owned())
}

/// Bounds model output because positions roughly double each note's later round-trip cost.
/// Keeps earliest notes and reports omissions, matching `get_arrangement`.
const MAX_NOTES_FOR_MODEL: usize = 1024;

fn trim_notes_for_model(notes: &mut Vec<clip_notes::Note>) -> Option<String> {
    let omitted = notes.len().saturating_sub(MAX_NOTES_FOR_MODEL);
    if omitted == 0 {
        return None;
    }
    notes.truncate(MAX_NOTES_FOR_MODEL);
    Some(format!(
        "model_output_limited_to_{MAX_NOTES_FOR_MODEL}_notes: omitted {omitted} later notes"
    ))
}

fn joined_reason(first: Option<String>, second: Option<String>) -> Option<String> {
    match (first, second) {
        (Some(a), Some(b)) => Some(format!("{a}; {b}")),
        (a, b) => a.or(b),
    }
}

fn notes_payload(
    notes: &[clip_notes::Note],
    signature: Option<(i64, i64)>,
    timeline_start: Option<f64>,
) -> serde_json::Value {
    let mut payload = serde_json::to_value(notes).unwrap_or(serde_json::Value::Null);
    let grid = signature.and_then(grid);
    let Some(items) = payload.as_array_mut() else {
        return payload;
    };
    for (item, note) in items.iter_mut().zip(notes) {
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        if let Some(notation) = duration_notation(note.duration) {
            object.insert("duration_notation".into(), json!(notation));
        }
        let Some(grid) = grid.as_ref() else {
            continue;
        };
        if let Some(position) = musical_position(note.start, grid) {
            object.insert("clip_position".into(), json!(position));
        }
        if let Some(position) =
            timeline_start.and_then(|start| musical_position(start + note.start, grid))
        {
            object.insert("timeline_position".into(), json!(position));
        }
    }
    payload
}

/// Where a source note first sounds in the song, or `None` when it never does
/// inside this placement. Playback starts at the start marker; a looping clip
/// wraps from its loop end back to its loop start, so a note before the marker
/// can first sound on the second pass.
fn first_sounding(
    note: f64,
    start: f64,
    length: f64,
    marker: f64,
    region: Option<&clip_notes::LoopRegion>,
) -> Option<f64> {
    let first_pass_end = region.map_or(f64::INFINITY, |r| r.end_beats);
    let offset = if note >= marker && note < first_pass_end {
        note - marker
    } else {
        let r = region?;
        if note < r.start_beats || note >= r.end_beats || marker >= r.end_beats {
            return None;
        }
        (r.end_beats - marker) + (note - r.start_beats)
    };
    (offset < length).then_some(start + offset)
}

/// The optional `start_beats`/`end_beats` song range; a missing bound is the
/// open end of the timeline. `Err` for a bound that is not a usable number.
fn beat_range(args: &serde_json::Value) -> Result<Option<(f64, f64)>, ()> {
    let bound = |name: &str, open: f64| args.get(name).map_or(Some(open), |v| v.as_f64().filter(|b| b.is_finite()));
    match (args.get("start_beats"), args.get("end_beats")) {
        (None, None) => Ok(None),
        _ => match (bound("start_beats", 0.0), bound("end_beats", f64::INFINITY)) {
            (Some(start), Some(end)) if start >= 0.0 && end > start => Ok(Some((start, end))),
            _ => Err(()),
        },
    }
}

/// Pass starts listed for the model; `loop_passes` still counts them all.
const MAX_LISTED_PASSES: usize = 32;

/// How many of `from`, `from + period`, ... fall before `end`.
fn repeats_before(from: f64, period: f64, end: f64) -> usize {
    if from >= end || period <= 0.0 {
        return usize::from(from < end);
    }
    // Shaved so a pass that would start exactly at `end` is not counted.
    ((end - from) / period - 1e-9).ceil() as usize
}

/// The first wrap from the loop end back to the loop start, in song beats,
/// or `None` when the marker sits past the loop and nothing wraps.
fn first_wrap(start: f64, marker: f64, region: &clip_notes::LoopRegion) -> Option<f64> {
    (marker < region.end_beats).then_some(start + (region.end_beats - marker))
}

fn loop_pass_count(start: f64, length: f64, marker: f64, region: &clip_notes::LoopRegion) -> usize {
    let period = region.end_beats - region.start_beats;
    1 + first_wrap(start, marker, region).map_or(0, |wrap| repeats_before(wrap, period, start + length))
}

/// Where each pass through the loop begins in the song, at most
/// `MAX_LISTED_PASSES` of them: the placement start, then every wrap.
fn loop_pass_starts(start: f64, length: f64, marker: f64, region: &clip_notes::LoopRegion) -> Vec<f64> {
    let period = region.end_beats - region.start_beats;
    let count = loop_pass_count(start, length, marker, region).min(MAX_LISTED_PASSES);
    let wrap = first_wrap(start, marker, region).unwrap_or(start);
    std::iter::once(start).chain((0..).map(|k| wrap + k as f64 * period)).take(count).collect()
}

/// Every song beat a source note sounds at inside this placement, in order:
/// its first sounding, then once per wrap for a note inside the loop.
fn sounding_times(
    note: f64,
    start: f64,
    length: f64,
    marker: f64,
    region: Option<&clip_notes::LoopRegion>,
) -> impl Iterator<Item = f64> {
    let period = region
        .filter(|r| note >= r.start_beats && note < r.end_beats)
        .map(|r| r.end_beats - r.start_beats)
        .filter(|p| *p > 0.0);
    let end = start + length;
    first_sounding(note, start, length, marker, region).into_iter().flat_map(move |first| {
        let repeats = period.map_or(1, |p| repeats_before(first, p, end));
        (0..repeats).map(move |k| first + k as f64 * period.unwrap_or(0.0))
    })
}

/// The one-based loop pass a song beat falls in: the first runs from the
/// placement start to the first wrap, each later one a full loop.
fn pass_of(beat: f64, start: f64, marker: f64, region: Option<&clip_notes::LoopRegion>) -> usize {
    let Some((region, wrap)) = region.and_then(|r| Some((r, first_wrap(start, marker, r)?))) else {
        return 1;
    };
    let period = region.end_beats - region.start_beats;
    if beat < wrap || period <= 0.0 {
        return 1;
    }
    2 + ((beat - wrap) / period + 1e-9).floor() as usize
}

/// Played notes listed for the model; past it the clip is shown once.
const MAX_UNROLLED_NOTES: usize = 256;

/// Why a read falls back to listing each source note once.
enum SourceView {
    TooMany,
    Unplaceable,
    Muted,
    /// A note_offset page or a partial read: the source notes as asked.
    Paged,
}

/// A note that can sound: unmuted, and with a chance to play above zero.
fn can_sound(note: &clip_notes::Note) -> bool {
    !note.mute && note.probability > 0.0
}

/// The unmuted notes as they sound in the song, in order, each once per loop
/// pass: the list a producer hears. A clip listed once reads as one pass.
fn played_notes(
    notes: &clip_notes::ClipNotes,
    signature: Option<(i64, i64)>,
    start: f64,
    length: f64,
    range: Option<(f64, f64)>,
) -> Result<Vec<serde_json::Value>, SourceView> {
    let (Some(marker), Some(grid)) = (notes.source_start_beats, signature.and_then(grid)) else {
        return Err(SourceView::Unplaceable);
    };
    let region = notes.loop_region.as_ref();
    let mut played: Vec<(f64, &clip_notes::Note)> = notes
        .notes
        .iter()
        .filter(|n| can_sound(n))
        .flat_map(|n| sounding_times(n.start, start, length, marker, region).map(move |t| (t, n)))
        .filter(|(t, _)| range.is_none_or(|(from, to)| *t >= from && *t < to))
        .take(MAX_UNROLLED_NOTES + 1)
        .collect();
    if played.len() > MAX_UNROLLED_NOTES {
        return Err(SourceView::TooMany);
    }
    played.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.pitch.cmp(&b.1.pitch)));
    Ok(played
        .into_iter()
        .map(|(beat, note)| {
            let mut item = notes_payload(std::slice::from_ref(note), signature, None)[0].take();
            let object = item.as_object_mut().unwrap();
            object.remove("start");
            object.remove("mute");
            if let Some(position) = musical_position(beat, &grid) {
                object.insert("timeline_position".into(), json!(position));
            }
            object.insert("pass".into(), json!(pass_of(beat, start, marker, region)));
            item
        })
        .collect())
}

/// A placement's loop passes in words, shared by MIDI notes and samples:
/// the loop's size ("1-bar"), how often it plays ("2 times"), the bars it
/// spans, and "; the last pass is cut short" when a pass is partial.
struct PassWords {
    size: String,
    times: String,
    span: String,
    partial: String,
}

/// "bar 2" or "bars 2-3": one-based, the last the bar the placement ends inside.
fn bar_span(start: f64, length: f64, beats_per_bar: f64) -> String {
    let first = (start / beats_per_bar).floor() as i64 + 1;
    let last = ((start + length) / beats_per_bar - 1e-9).ceil() as i64;
    if last <= first { format!("bar {first}") } else { format!("bars {first}-{last}") }
}

fn pass_words(
    signature: (i64, i64),
    start: f64,
    length: f64,
    marker: f64,
    passes: usize,
    region: &clip_notes::LoopRegion,
) -> Option<PassWords> {
    let beats_per_bar = beats_per_bar(signature)?;
    let period = region.end_beats - region.start_beats;
    let bars = period / beats_per_bar;
    let size = if (bars - bars.round()).abs() < 1e-9 { format!("{}-bar", bars.round()) } else { format!("{period}-beat") };
    let times = if passes == 1 { "once".to_owned() } else { format!("{passes} times") };
    // A pass that does not hold the whole loop does not play all of it.
    let mut partial = Vec::new();
    if marker > region.start_beats + 1e-9 && marker < region.end_beats {
        partial.push("the first pass starts mid-loop");
    }
    let last_pass_end = first_wrap(start, marker, region).map(|wrap| wrap + (passes - 1) as f64 * period);
    if last_pass_end.is_some_and(|end| start + length < end - 1e-9) {
        partial.push("the last pass is cut short");
    }
    let partial = if partial.is_empty() { String::new() } else { format!("; {}", partial.join(" and ")) };
    Some(PassWords { size, times, span: bar_span(start, length, beats_per_bar), partial })
}

/// The loop in words, such as "a 1-bar loop of 4 notes played 2 times, bars
/// 2-3". Models quote a ready sentence; they do not reliably add up passes.
fn loop_summary(
    notes: &clip_notes::ClipNotes,
    signature: (i64, i64),
    start: f64,
    length: f64,
    marker: f64,
    passes: usize,
    region: &clip_notes::LoopRegion,
) -> Option<String> {
    let PassWords { size, times, span, partial } = pass_words(signature, start, length, marker, passes, region)?;
    let count = notes.notes.iter().filter(|n| can_sound(n) && n.start >= region.start_beats && n.start < region.end_beats).count();
    let notes_word = if count == 1 { "note" } else { "notes" };
    Some(format!("a {size} loop of {count} {notes_word} played {times}, {span}{partial}"))
}

/// The loop's passes: how many there are and where each begins in the song.
fn add_loop_passes(
    payload: &mut serde_json::Value,
    notes: &clip_notes::ClipNotes,
    signature: Option<(i64, i64)>,
    start: f64,
    length: f64,
) {
    let (Some(marker), Some(region)) = (notes.source_start_beats, notes.loop_region.as_ref()) else {
        return;
    };
    let passes = loop_pass_count(start, length, marker, region);
    payload["loop_passes"] = json!(passes);
    if let Some(summary) = signature.and_then(|signature| loop_summary(notes, signature, start, length, marker, passes, region)) {
        payload["loop"] = json!(summary);
    }
    if let Some(grid) = signature.and_then(grid) {
        let starts: Vec<_> = loop_pass_starts(start, length, marker, region)
            .into_iter()
            .filter_map(|beat| musical_position(beat, &grid))
            .collect();
        payload["loop_pass_starts"] = json!(starts);
    }
}

fn arrangement_note_payload(
    notes: &clip_notes::ClipNotes,
    signature: Option<(i64, i64)>,
    start: f64,
    length: f64,
) -> serde_json::Value {
    let mut payload = notes_payload(&notes.notes, signature, None);
    let grid = signature.and_then(grid);
    for (item, note) in payload.as_array_mut().unwrap().iter_mut().zip(&notes.notes) {
        let first = notes
            .source_start_beats
            .and_then(|marker| first_sounding(note.start, start, length, marker, notes.loop_region.as_ref()));
        if let Some(position) = first.zip(grid.as_ref()).and_then(|(beat, grid)| musical_position(beat, grid)) {
            item["timeline_position"] = json!(position);
        }
    }
    payload
}

/// The get_arrangement_notes result: the played view when it can be listed,
/// else the source notes from `note_offset`. Also returns why output was
/// trimmed, if it was.
fn arrangement_notes_payload(
    mut result: arrangement::ArrangementClipNotes,
    signature: Option<(i64, i64)>,
    note_offset: usize,
    range: Option<(f64, f64)>,
) -> (serde_json::Value, Option<String>) {
    let source_complete = result.notes.missing_reason.is_none();
    let total_read = result.notes.notes.len();
    let played = if result.muted {
        Err(SourceView::Muted)
    } else if note_offset == 0 && source_complete {
        played_notes(&result.notes, signature, result.start, result.length, range)
    } else {
        Err(SourceView::Paged)
    };
    let mut payload = json!({
        "source_start_beats": result.notes.source_start_beats,
        "note_range": result.notes.note_range.as_ref().map(|range| loop_region_payload(range.start_beats, range.end_beats, signature)),
        "name": result.name,
        "start_beats": result.start,
        "length_beats": result.length,
        "muted": result.muted,
        "is_midi": result.is_midi,
        "loop_region": result.loop_region.map(|region| {
            loop_region_payload(region.start_beats, region.end_beats, signature)
        }),
    });
    // A partial read holds only the notes that arrived, not the clip's total.
    if source_complete {
        payload["source_notes"] = json!(total_read);
    }
    if let Some((from, to)) = range {
        payload["range"] = json!({ "start_beats": from, "end_beats": to.is_finite().then_some(to) });
    }
    // Before the source view pages the notes: the loop is all of them.
    add_loop_passes(&mut payload, &result.notes, signature, result.start, result.length);
    let trimmed = match played {
        Ok(list) => {
            payload["view"] = json!("played");
            payload["count"] = json!(list.len());
            payload["notes"] = json!(list);
            let mut muted: Vec<_> = result.notes.notes.iter().filter(|n| n.mute).cloned().collect();
            let trimmed = trim_notes_for_model(&mut muted);
            if !muted.is_empty() {
                let listed = notes_payload(&muted, signature, None);
                payload["muted_notes"] = json!(listed.as_array().unwrap().iter().map(|n| json!({
                    "note": n["note"], "pitch": n["pitch"], "clip_position": n["clip_position"],
                })).collect::<Vec<_>>());
            }
            trimmed
        }
        Err(why) => {
            result.notes.notes.drain(..note_offset.min(total_read));
            let next_note_offset = (source_complete && total_read.saturating_sub(note_offset) > MAX_NOTES_FOR_MODEL)
                .then_some(note_offset + MAX_NOTES_FOR_MODEL);
            let trimmed = trim_notes_for_model(&mut result.notes.notes);
            payload["view"] = json!("source");
            let reason = match why {
                SourceView::TooMany => Some(format!("more than {MAX_UNROLLED_NOTES} notes sound here; supply start_beats and end_beats to list a section as it plays")),
                SourceView::Muted => Some("the clip is muted, so none of its notes sound".to_owned()),
                SourceView::Unplaceable => Some("the time signature or the clip's start marker is unknown, so the notes cannot be placed in the song".to_owned()),
                SourceView::Paged => None,
            };
            if let Some(reason) = reason {
                payload["view_reason"] = json!(reason);
            }
            payload["note_offset"] = json!(note_offset);
            payload["next_note_offset"] = json!(next_note_offset);
            payload["count"] = json!(result.notes.notes.len());
            payload["notes"] = arrangement_note_payload(&result.notes, signature, result.start, result.length);
            trimmed
        }
    };
    add_bar_timing(&mut payload, result.start, result.length, signature);
    if let Some(region) = &result.notes.loop_region {
        let period = region.end_beats - region.start_beats;
        payload["repeats_every_beats"] = json!(period);
        if let Some(bars) = signature.and_then(beats_per_bar) {
            payload["repeats_every_bars"] = json!(period / bars);
        }
    }
    (payload, trimmed)
}

fn loop_region_payload(
    start_beats: f64,
    end_beats: f64,
    signature: Option<(i64, i64)>,
) -> serde_json::Value {
    let mut payload = json!({ "start_beats": start_beats, "end_beats": end_beats });
    let Some(grid) = signature.and_then(grid) else {
        return payload;
    };
    if let Some(position) = musical_position(start_beats, &grid) {
        payload["start_position"] = json!(position);
    }
    if let Some(position) = musical_position(end_beats, &grid) {
        payload["end_position"] = json!(position);
    }
    payload
}

/// Adds producer-facing bar labels without replacing the unambiguous beat
/// values the OSC protocol carries.
fn arrangement_payload(
    map: &arrangement::ArrangementMap,
    signature: Option<(i64, i64)>,
) -> serde_json::Value {
    let mut payload = json!({ "tracks": map.tracks, "missing": map.missing });
    let Some((numerator, denominator)) = signature else {
        return payload;
    };
    let (Some(beats_per_bar), Some(grid)) =
        (beats_per_bar((numerator, denominator)), grid((numerator, denominator)))
    else {
        return payload;
    };
    payload["time_signature"] = json!({ "numerator": numerator, "denominator": denominator });
    payload["bar_positions_assume_current_signature"] = json!(true);
    let Some(tracks) = payload["tracks"].as_array_mut() else {
        return payload;
    };
    for track in tracks {
        let Some(clips) = track["clips"].as_array_mut() else {
            continue;
        };
        let mut first_audible: Option<f64> = None;
        for clip in clips {
            let (Some(start), Some(length)) =
                (clip["start_beats"].as_f64(), clip["length_beats"].as_f64())
            else {
                continue;
            };
            if let Some(position) = musical_position(start, &grid) {
                clip["start_position"] = json!(position);
            }
            clip["length_bars"] = json!(length / beats_per_bar);
            if clip["muted"] == json!(false) && first_audible.is_none_or(|first| start < first) {
                first_audible = Some(start);
            }
        }
        if let Some(position) = first_audible.and_then(|start| musical_position(start, &grid)) {
            track["first_unmuted_start"] = json!(position);
        }
    }
    payload
}

/// MIDI effects ahead of the track's first instrument change the notes a clip
/// sends before they sound. `None` when the chain did not answer.
async fn midi_effects_before_instrument(query: Arc<LiveQuery>, track: i32) -> Option<Vec<String>> {
    let map = device_chains::get_device_chains_range(query, track, track + 1, 0, 256, device_chains::QUERY_TIMEOUT).await;
    let chain = map.tracks.into_iter().next()?;
    Some(effects_before_instrument(chain.devices, chain.kinds))
}

/// Top-level MIDI effects that are on, ahead of the first instrument. A
/// switched-off effect changes nothing.
fn effects_before_instrument(devices: Vec<String>, kinds: Vec<(i32, bool)>) -> Vec<String> {
    devices
        .into_iter()
        .zip(kinds)
        .take_while(|(_, (kind, _))| *kind != device_chains::INSTRUMENT)
        .filter(|(_, (kind, active))| *kind == device_chains::MIDI_EFFECT && *active)
        .map(|(label, _)| label)
        .collect()
}

fn add_pre_midi_effects(payload: &mut serde_json::Value, effects: Option<Vec<String>>) {
    match effects {
        Some(effects) if effects.is_empty() => {}
        Some(effects) => payload["pre_midi_effects"] = json!(effects),
        None => payload["pre_midi_effects_unread"] = json!(true),
    }
}

fn add_bar_timing(
    payload: &mut serde_json::Value,
    start_beats: f64,
    length_beats: f64,
    signature: Option<(i64, i64)>,
) {
    let Some((numerator, denominator)) = signature else {
        return;
    };
    let (Some(beats_per_bar), Some(grid)) =
        (beats_per_bar((numerator, denominator)), grid((numerator, denominator)))
    else {
        return;
    };
    payload["time_signature"] = json!({ "numerator": numerator, "denominator": denominator });
    payload["bar_positions_assume_current_signature"] = json!(true);
    if let Some(position) = musical_position(start_beats, &grid) {
        payload["start_position"] = json!(position);
    }
    payload["length_bars"] = json!(length_beats / beats_per_bar);
}

/// Reject an impossible track index before it becomes an OSC timeout.
///
/// The mirror is advisory: when it has not observed a count yet, a live tool
/// is still allowed to ask Live. When it *has* a non-negative count, though,
/// an index beyond it cannot become valid during this request and asking it
/// makes the model wait for the ordinary two-second no-reply timeout.
fn known_track_is_out_of_range(coalescer: &Mutex<Coalescer>, track: i64) -> bool {
    matches!(track_count(coalescer), Some(count) if count >= 0 && track >= count)
}

/// Whether the track under a paged query moved between two identity samples.
///
/// Abstains when the mirror never held the track to begin with: with nothing
/// to compare against, reporting a change would be a guess, and this is a
/// guard against inventing data rather than a licence to invent a warning.
fn topology_moved(before: &Option<serde_json::Value>, after: &Option<serde_json::Value>) -> bool {
    match (before, after) {
        (None, _) => false,
        // The track fell out of the mirror entirely: a delete that shrank
        // num_tracks past this index (see evict_tracks_at_or_beyond).
        (Some(_), None) => true,
        (Some(b), Some(a)) => b != a,
    }
}

/// Bounds the whole-set fan-out of `get_device_chains`, `get_clips`, and
/// `get_arrangement`.
///
/// The three are the only concurrency in this codebase sized by a mirrored
/// value: each spawns per-track tasks and samples one mirrored name per
/// track at each end of the fetch, all off a count the mirror handed over. A
/// corrupt or absurd count must not become that many tasks or that many
/// samples, so the count is clamped to this ONCE, on the `i64`, before the
/// fan-out, the identity brackets, or the `as i32` narrowing consume it.
/// Clamping later leaves each unclamped consumer holding the raw count, and
/// `as i32` alone WRAPS: `2^32 + 5` narrows to 5.
///
/// A real set is nowhere near this, and it is not unreachable either: only
/// Live Intro (16 tracks) and Lite (8) cap the count -- Standard and Suite
/// do not. A set past this is legal, so the result reports the truncation
/// instead of presenting the first `MAX_FANOUT_TRACKS` tracks as the set.
const MAX_FANOUT_TRACKS: i64 = 512;

/// Arrangement maps are an orientation tool, not a full-score export. A
/// model prompt with hundreds of thousands of placements is slow and causes
/// it to miss the musical evidence it did receive. Keep the earliest
/// placements and mark the result partial; callers can still drill into any
/// returned clip with `get_arrangement_notes`.
const MAX_ARRANGEMENT_CLIPS_FOR_MODEL: usize = 512;

fn offset_arg(args: &serde_json::Value, name: &str) -> Option<usize> {
    if args.get(name).is_none() {
        return Some(0);
    }
    int_arg(args, name).filter(|n| (0..=i64::from(i32::MAX)).contains(n)).map(|n| n as usize)
}

fn trim_arrangement_for_model(map: &mut arrangement::ArrangementMap) -> Option<String> {
    let mut remaining = MAX_ARRANGEMENT_CLIPS_FOR_MODEL;
    let mut omitted = 0usize;
    for track in &mut map.tracks {
        if track.clips.len() > remaining {
            omitted += track.clips.len() - remaining;
            track.next_clip_index = Some(track.clips[remaining].index as usize);
            track.clips.truncate(remaining);
            track.truncated = true;
        }
        remaining = remaining.saturating_sub(track.clips.len());
    }
    (omitted > 0).then(|| {
        format!(
            "model_output_truncated_to_first_{MAX_ARRANGEMENT_CLIPS_FOR_MODEL}_arrangement_clips: omitted {omitted} later placements; narrow start_beats/end_beats or request a track with its next_clip_index as clip_offset"
        )
    })
}

/// Whether a whole-set read's bracket -- `get_device_chains`'s, `get_clips`'s,
/// or `get_arrangement`'s -- caught a topology change.
///
/// A count comparison alone catches an add or a delete but misses a
/// same-count REORDER: the indices in the returned `TrackChain` (or
/// `TrackClips`) list would then silently name the wrong tracks' devices
/// (or clips), and the result would go back as a fresh, fully-formed answer
/// with nothing marking it wrong. So
/// this compares every sampled index's mirrored name too, via the same
/// `topology_moved` rule `get_clip_notes` and `get_device_params` use for
/// one track -- an index the mirror never held abstains rather than
/// reporting a change, exactly as `topology_moved` already does.
///
/// Sampling every index doubles the `track_identity` calls, not the OSC
/// traffic: `track_identity` and `track_count` both read the local mirror,
/// which is already kept warm by the periodic poll, so this costs nothing
/// on the wire.
///
/// NARROWED, NOT CLOSED, and bounded by mirror staleness -- do not read
/// this as a complete reorder guard. Every value it compares, names and
/// count alike, comes from the SAME mirror, which the poll refreshes about
/// every two seconds (`PollKind::TrackState`). So the guard fires only when
/// a poll lands between the two samples. A whole-set fetch finishes in
/// about one Live tick (~100 ms), so on a healthy set most calls sample
/// the same poll twice and see nothing; and a reorder in the up-to-2 s
/// window BEFORE the call is invisible to it entirely -- both samples read
/// identically stale names while the fetch reads Live's new ordering, and
/// the returned indices then pair against the stale index-to-name lines in
/// the context block.
///
/// It is kept because its coverage grows with exactly the calls that need
/// it. That COVERAGE -- not the residual -- is (fetch duration / poll
/// interval): about 5% for a ~100 ms fetch against a 2 s poll, which
/// leaves a residual of 1 - (fetch duration / poll interval), roughly
/// 95%. So the guard catches a small fraction of in-flight reorders and
/// is not a completeness guarantee. What it has going for it is that the
/// fraction rises with the calls that need it: a slow set -- timeouts,
/// retries, a fetch stretching toward the 2 s timeout -- is where a track
/// move is both most likely and most likely to be caught.
/// It costs nothing on the wire, so there is no case for dropping it.
/// Closing it properly needs a change Live tells us about, not one we
/// sample: see the spec's "A generation counter".
fn chains_moved(
    before_count: i64,
    after_count: Option<i64>,
    before: &[Option<serde_json::Value>],
    after: &[Option<serde_json::Value>],
) -> bool {
    after_count != Some(before_count) || before.iter().zip(after).any(|(b, a)| topology_moved(b, a))
}

/// Renders `get_rack_contents`'s payload.
///
/// `total_chains` and `is_rack` are omitted entirely when no window ever
/// decoded, rather than serialised as `null`: an explicit null still invites
/// the model to read something into the field, and `is_rack` is the field the
/// tool description makes load-bearing ("the result says which"). A
/// fabricated `false` there sends the model away from a Rack it should have
/// opened.
///
/// Extracted from the `execute` arm so the omission can be tested at all --
/// `RackContents` is never serialised as a struct, so its `skip_serializing_if`
/// attributes are belt-and-braces and this `if let` is the mechanism that
/// actually runs. Same reason `chain_map_reasons` below was extracted.
fn rack_payload(r: &rack_contents::RackContents) -> serde_json::Value {
    let mut payload = json!({ "chains": r.chains, "truncated": r.truncated, "next_offset": r.next_offset });
    if let Some(total) = r.total_chains {
        payload["total_chains"] = json!(total);
    }
    if let Some(is_rack) = r.is_rack {
        payload["is_rack"] = json!(is_rack);
    }
    payload
}

const MAX_MAP_BYTES: usize = 128 * 1024;
// Leave room for continuation fields and the ToolResult envelope/reasons.
const MAP_METADATA_RESERVE: usize = 24 * 1024;

fn fitting_prefix<T: serde::Serialize>(items: &[T], budget: &mut usize) -> usize {
    items.iter().take_while(|item| {
        let bytes = serde_json::to_vec(item).unwrap().len() + 1;
        if bytes > *budget { return false; }
        *budget -= bytes;
        true
    }).count()
}

/// Keeps the returns, the master, and as many tracks as fit the budget.
/// Returns the first track left out, which the model then reads alone.
fn trim_mixer_for_model(map: &mut mixer::MixerMap) -> Option<i32> {
    let mut tracks = std::mem::take(&mut map.tracks);
    let mut budget = MAX_MAP_BYTES.saturating_sub(MAP_METADATA_RESERVE + serde_json::to_vec(map).unwrap().len());
    let keep = fitting_prefix(&tracks, &mut budget);
    let first_left_out = tracks.get(keep).map(|t| t.track);
    tracks.truncate(keep);
    map.tracks = tracks;
    first_left_out
}

fn trim_clip_map_for_model(map: &mut clips::ClipMap) -> bool {
    let pages: Vec<_> = map.tracks.iter_mut().map(|track| std::mem::take(&mut track.clips)).collect();
    let mut budget = MAX_MAP_BYTES.saturating_sub(MAP_METADATA_RESERVE + serde_json::to_vec(map).unwrap().len());
    let mut trimmed = false;
    for (track, mut page) in map.tracks.iter_mut().zip(pages) {
        let keep = fitting_prefix(&page, &mut budget);
        if keep < page.len() {
            track.next_slot = Some(page[keep].slot);
            page.truncate(keep);
            trimmed = true;
        }
        track.clips = page;
    }
    trimmed
}

fn trim_chain_map_for_model(map: &mut device_chains::ChainMap) -> bool {
    let pages: Vec<_> = map.tracks.iter_mut().map(|track| std::mem::take(&mut track.devices)).collect();
    let mut budget = MAX_MAP_BYTES.saturating_sub(MAP_METADATA_RESERVE + serde_json::to_vec(map).unwrap().len());
    let mut trimmed = false;
    for (track, mut page) in map.tracks.iter_mut().zip(pages) {
        let keep = fitting_prefix(&page, &mut budget);
        if keep < page.len() {
            track.next_device_offset = Some(track.device_offset + keep);
            track.truncated = true;
            page.truncate(keep);
            trimmed = true;
        }
        track.devices = page;
    }
    trimmed
}

/// Assembles `get_device_chains`'s `missing_reason` from the three things
/// that can go partly wrong: a set larger than the fan-out cap, tracks that
/// did not answer at all, and tracks whose device names arrived without
/// their rack marks.
///
/// All three can hold at once, so they are joined rather than one
/// overwriting another. Extracted from the `execute` arm so it can be tested
/// without a connected fake -- inline, the rack-mark case had no test at all.
fn chain_map_reasons(
    num_tracks: i64,
    read_tracks: i64,
    missing: &[i32],
    flags_missing: &[i32],
) -> Option<String> {
    // The truncated tail is named as a count, not pushed into `missing` as
    // thousands of indices: `missing` means "asked, no usable answer", and
    // these were never asked.
    let mut reasons: Vec<String> = Vec::new();
    if num_tracks > read_tracks {
        reasons.push(format!(
            "truncated_to_first_{read_tracks}_tracks: the set has {num_tracks}"
        ));
    }
    if !missing.is_empty() {
        let names: Vec<String> = missing.iter().map(|t| t.to_string()).collect();
        reasons.push(format!("no_reply_for_tracks: {}", names.join(", ")));
    }
    if !flags_missing.is_empty() {
        let names: Vec<String> = flags_missing.iter().map(|t| t.to_string()).collect();
        reasons.push(format!(
            "rack_marks_unavailable_for_tracks: {} (their devices are listed, but which are Racks is unknown)",
            names.join(", ")
        ));
    }
    (!reasons.is_empty()).then(|| reasons.join("; "))
}

/// Assembles `get_clips`'s `missing_reason` from the three things that can go
/// partly wrong: a set larger than the fan-out cap, tracks that did not answer
/// at all, and tracks whose clips arrived without their MIDI flag.
///
/// All three can hold at once, so they are joined rather than one overwriting
/// another. Extracted from the `execute` arm for the same reason
/// `chain_map_reasons` was: inline, the flag case would have no test.
fn clip_map_reasons(
    num_tracks: i64,
    read_tracks: i64,
    missing: &[i32],
    midi_missing: &[i32],
) -> Option<String> {
    let mut reasons: Vec<String> = Vec::new();
    if num_tracks > read_tracks {
        reasons.push(format!(
            "truncated_to_first_{read_tracks}_tracks: the set has {num_tracks}"
        ));
    }
    if !missing.is_empty() {
        let names: Vec<String> = missing.iter().map(|t| t.to_string()).collect();
        reasons.push(format!("no_reply_for_tracks: {}", names.join(", ")));
    }
    if !midi_missing.is_empty() {
        let names: Vec<String> = midi_missing.iter().map(|t| t.to_string()).collect();
        reasons.push(format!(
            "midi_flag_unavailable_for_tracks: {} (their clips are listed, but whether the track is MIDI is unknown)",
            names.join(", ")
        ));
    }
    (!reasons.is_empty()).then(|| reasons.join("; "))
}

/// Assembles `get_arrangement`'s `missing_reason` from the four things that
/// can go partly wrong: a set larger than the fan-out cap, tracks that did not
/// answer, tracks whose timeline was longer than the paging budget, and tracks
/// whose timeline moved between two pages of the same read.
///
/// All four can hold at once, so they are joined rather than one overwriting
/// another. Extracted from the `execute` arm for the same reason
/// `chain_map_reasons` and `clip_map_reasons` were: inline, the truncation
/// case would have no test.
fn arrangement_reasons(
    num_tracks: i64,
    read_tracks: i64,
    missing: &[i32],
    truncated: &[i32],
    changed: &[i32],
) -> Option<String> {
    let mut reasons: Vec<String> = Vec::new();
    if num_tracks > read_tracks {
        reasons.push(format!(
            "truncated_to_first_{read_tracks}_tracks: the set has {num_tracks}"
        ));
    }
    if !missing.is_empty() {
        let names: Vec<String> = missing.iter().map(|t| t.to_string()).collect();
        reasons.push(format!("no_reply_for_tracks: {}", names.join(", ")));
    }
    if !truncated.is_empty() {
        let names: Vec<String> = truncated.iter().map(|t| t.to_string()).collect();
        reasons.push(format!(
            "timeline_truncated_for_tracks: {} (the clips listed are real, but the timeline continues past them)",
            names.join(", ")
        ));
    }
    // Deliberately not folded into `missing`. "The timeline moved under the
    // read" and "the track never answered" are different things to tell a
    // model: the first hands it real clips it should not fully trust, the
    // second hands it nothing at all.
    if !changed.is_empty() {
        let names: Vec<String> = changed.iter().map(|t| t.to_string()).collect();
        reasons.push(format!(
            "timeline_changed_during_read_for_tracks: {} (the clips listed may pair a name with another clip's position)",
            names.join(", ")
        ));
    }
    (!reasons.is_empty()).then(|| reasons.join("; "))
}

pub async fn execute(ctx: &ToolContext, name: &str, args: &serde_json::Value) -> ToolResult {
    match name {
        "get_track_detail" => {
            let Some(track) =
                int_arg(args, "track").filter(|t| (0..=i64::from(u32::MAX)).contains(t))
            else {
                return ToolResult::missing("bad_arguments");
            };
            // Short guard, no await inside: the mirror read is synchronous.
            let found = match ctx.coalescer.lock() {
                Ok(c) => track_detail::get_track_detail(&c, track as u32, Instant::now()),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some((detail, age)) = found else {
                return ToolResult::missing("not_in_mirror");
            };
            let at = now_millis();
            ToolResult {
                value: serde_json::to_value(&detail).unwrap_or(serde_json::Value::Null),
                queried_at: at,
                fresh_as_of: Some(at.saturating_sub(age.as_millis() as u64)),
                fresh: track_detail::is_fresh(age),
                missing_reason: None,
            }
        }
        "get_clip_notes" => {
            let Some(note_offset) = offset_arg(args, "note_offset") else { return ToolResult::missing("bad_arguments"); };
            let (Some(track), Some(clip)) = (
                int_arg(args, "track").filter(|t| (0..=i64::from(i32::MAX)).contains(t)),
                int_arg(args, "clip").filter(|c| (0..=i64::from(i32::MAX)).contains(c)),
            ) else {
                return ToolResult::missing("bad_arguments");
            };
            if known_track_is_out_of_range(&ctx.coalescer, track) {
                return ToolResult::missing("track_out_of_range");
            }
            // Clone the Arc out and DROP the guard before awaiting -- a
            // std::sync::Mutex guard is !Send and holding one across an
            // .await would not compile, which is exactly why this codebase
            // uses one.
            let query = match ctx.query.lock() {
                Ok(q) => q.clone(),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some(query) = query else {
                return ToolResult::missing("not_connected");
            };

            // Bracket the fetch with an identity sample. A paged read can
            // span several seconds, and merging two clips' notes into one
            // answer is the failure this catches.
            let before = track_identity(&ctx.coalescer, track);
            // The chain read sits inside the bracket too, or a moved track
            // would put its neighbour's MIDI effects under these notes.
            let (outcome, pre_effects) = tokio::join!(
                clip_notes::get_clip_notes(
                    query.clone(),
                    track as i32,
                    clip as i32,
                    clip_notes::QUERY_TIMEOUT,
                ),
                midi_effects_before_instrument(query, track as i32),
            );
            if topology_moved(&before, &track_identity(&ctx.coalescer, track)) {
                return ToolResult::missing("topology_changed");
            }

            match outcome {
                Ok(mut notes) => {
                    if matches!(notes.missing_reason.as_deref(), Some("not_midi_clip" | "empty_slot" | "clip_changed")) {
                        return ToolResult::missing(notes.missing_reason.as_deref().unwrap());
                    }
                    let signature = time_signature(&ctx.coalescer);
                    let source_complete = notes.missing_reason.is_none();
                    if note_offset > 0 && !source_complete {
                        return ToolResult::missing(&format!("cannot_continue_partial_note_read: {}", notes.missing_reason.as_deref().unwrap()));
                    }
                    let total_read = notes.notes.len();
                    notes.notes.drain(..note_offset.min(total_read));
                    let next_note_offset = (source_complete && total_read.saturating_sub(note_offset) > MAX_NOTES_FOR_MODEL)
                        .then_some(note_offset + MAX_NOTES_FOR_MODEL);
                    let trimmed = trim_notes_for_model(&mut notes.notes);
                    let mut payload = json!({
                        "note_offset": note_offset,
                        "next_note_offset": next_note_offset,
                        "notes": notes_payload(&notes.notes, signature, None),
                        "count": notes.notes.len(),
                        "source_length_beats": notes.length_beats,
                        "source_start_beats": notes.source_start_beats,
                        "note_range": notes.note_range.as_ref().map(|range| loop_region_payload(range.start_beats, range.end_beats, signature)),
                        "looping": notes.loop_state_known.then_some(notes.loop_region.is_some()),
                        "loop_region": notes.loop_region.map(|region| {
                            loop_region_payload(region.start_beats, region.end_beats, signature)
                        }),
                        "loop_state_known": notes.loop_state_known,
                    });
                    if let Some((numerator, denominator)) = signature {
                        payload["time_signature"] =
                            json!({ "numerator": numerator, "denominator": denominator });
                        payload["bar_positions_assume_current_signature"] = json!(true);
                    }
                    add_pre_midi_effects(&mut payload, pre_effects);
                    ToolResult::live(payload, joined_reason(notes.missing_reason, trimmed))
                }
                Err(QueryError::NoReply) => ToolResult::missing("no_reply"),
                Err(QueryError::Busy) => ToolResult::missing("busy"),
                Err(QueryError::Transport(e)) => {
                    ToolResult::missing(&format!("transport_error: {e}"))
                }
            }
        }
        "get_clips" => {
            let track = match args.get("track") {
                None => None,
                Some(_) => match int_arg(args, "track").filter(|t| (0..i64::from(i32::MAX)).contains(t)) {
                    Some(t) => Some(t),
                    None => return ToolResult::missing("bad_arguments"),
                },
            };
            let Some(start_slot) = offset_arg(args, "start_slot") else { return ToolResult::missing("bad_arguments"); };
            if args.get("start_slot").is_some() && track.is_none() { return ToolResult::missing("bad_arguments"); }
            // Without a count there is nothing to iterate. Querying 0..0
            // would return an empty map, which reads as "the set has no
            // clips" -- an invented answer, not a missing one.
            let Some(num_tracks) = track_count(&ctx.coalescer).filter(|n| *n >= 0) else {
                return ToolResult::missing("not_in_mirror");
            };
            let read_tracks = num_tracks.min(MAX_FANOUT_TRACKS);
            if track.is_some_and(|t| t >= num_tracks) { return ToolResult::missing("track_out_of_range"); }
            let selected = track.map_or(0..read_tracks, |t| t..t + 1);
            let query = match ctx.query.lock() {
                Ok(q) => q.clone(),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some(query) = query else {
                return ToolResult::missing("not_connected");
            };

            // Same bracket as the chain map, and `chains_moved` is reused
            // rather than copied: the hazard is identical -- a same-count
            // reorder would leave these track indices naming another
            // track's clips, and the answer would go back looking whole.
            let before: Vec<Option<serde_json::Value>> = selected.clone()
                .map(|t| track_identity(&ctx.coalescer, t))
                .collect();

            let max_pages = if track.is_some() { clips::MAX_PAGES } else { 1 };
            let mut map = clips::get_clips_range(query, selected.start as i32, (selected.end - selected.start) as i32, start_slot as i32, max_pages, clips::QUERY_TIMEOUT).await;

            let after_count = track_count(&ctx.coalescer);
            let after: Vec<Option<serde_json::Value>> = selected.clone()
                .map(|t| track_identity(&ctx.coalescer, t))
                .collect();
            if chains_moved(num_tracks, after_count, &before, &after) {
                return ToolResult::missing("topology_changed");
            }

            let output_limited = trim_clip_map_for_model(&mut map);
            let mut missing_reason = clip_map_reasons(
                if track.is_some() { 1 } else { num_tracks },
                if track.is_some() { 1 } else { read_tracks }, &map.missing, &map.midi_missing);
            if output_limited {
                missing_reason = joined_reason(missing_reason, Some("model_output_limited: continue each track using next_slot".into()));
            }
            if map.tracks.iter().any(|t| t.next_slot.is_some()) {
                missing_reason = joined_reason(missing_reason, Some("session_slots_partial: continue each track from next_slot using track and start_slot".into()));
            }
            ToolResult::live(
                json!({ "tracks": map.tracks, "missing": map.missing, "scope": {"track":track,"start_slot":start_slot} }),
                missing_reason,
            )
        }
        "get_arrangement" => {
            let track = match args.get("track") {
                None => None,
                Some(_) => match int_arg(args, "track").filter(|t| (0..i64::from(i32::MAX)).contains(t)) {
                    Some(t) => Some(t),
                    None => return ToolResult::missing("bad_arguments"),
                },
            };
            let Some(offset) = offset_arg(args, "clip_offset") else {
                return ToolResult::missing("bad_arguments");
            };
            if args.get("clip_offset").is_some() && track.is_none() {
                return ToolResult::missing("bad_arguments");
            }
            let Ok(range) = beat_range(args) else {
                return ToolResult::missing("bad_arguments");
            };
            // Without a count there is nothing to iterate. Querying 0..0
            // would return an empty map, which reads as "the set has no
            // arrangement" -- an invented answer, not a missing one.
            let Some(num_tracks) = track_count(&ctx.coalescer).filter(|n| *n >= 0) else {
                return ToolResult::missing("not_in_mirror");
            };
            let read_tracks = num_tracks.min(MAX_FANOUT_TRACKS);
            if track.is_some_and(|t| t >= num_tracks) {
                return ToolResult::missing("track_out_of_range");
            }
            let selected = track.map_or(0..read_tracks, |t| t..t + 1);
            let query = match ctx.query.lock() {
                Ok(q) => q.clone(),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some(query) = query else {
                return ToolResult::missing("not_connected");
            };

            // Same bracket as the chain map and the clip map: a same-count
            // reorder would leave these track indices naming another track's
            // timeline, and the answer would go back looking whole.
            let before: Vec<Option<serde_json::Value>> = selected.clone()
                .map(|t| track_identity(&ctx.coalescer, t))
                .collect();

            let mut map =
                arrangement::get_arrangement_range(query, selected.start as i32..selected.end as i32, offset, arrangement::QUERY_TIMEOUT)
                    .await;

            let after_count = track_count(&ctx.coalescer);
            let after: Vec<Option<serde_json::Value>> = selected
                .map(|t| track_identity(&ctx.coalescer, t))
                .collect();
            if chains_moved(num_tracks, after_count, &before, &after) {
                return ToolResult::missing("topology_changed");
            }

            let truncated: Vec<i32> = map
                .tracks
                .iter()
                .filter(|t| t.truncated)
                .map(|t| t.track)
                .collect();
            let mut reasons: Vec<String> = arrangement_reasons(
                if track.is_some() { 1 } else { num_tracks },
                if track.is_some() { 1 } else { read_tracks },
                &map.missing,
                &truncated,
                &map.changed,
            )
            .into_iter()
            .collect();
            if let Some((start, end)) = range {
                for track in &mut map.tracks {
                    track.clips.retain(|clip| clip.start < end && clip.start + clip.length > start);
                }
            }
            if let Some(reason) = trim_arrangement_for_model(&mut map) {
                reasons.push(reason);
            }
            let mut payload = arrangement_payload(&map, time_signature(&ctx.coalescer));
            if let Some(tracks) = payload["tracks"].as_array_mut() {
                for t in tracks {
                    let name = t["track"].as_i64().and_then(|i| track_identity(&ctx.coalescer, i));
                    if let Some(name) = name.as_ref().and_then(|n| n.as_str()) {
                        t["name"] = json!(fence::fence(name));
                    }
                }
            }
            payload["scope"] = json!({"track":track,"clip_offset":offset,
                "start_beats":range.map(|r| r.0),"end_beats":range.map(|r| r.1)});
            ToolResult::live(
                payload,
                (!reasons.is_empty()).then(|| reasons.join("; ")),
            )
        }
        "get_arrangement_notes" => {
            let Some(note_offset) = offset_arg(args, "note_offset") else { return ToolResult::missing("bad_arguments"); };
            let Ok(range) = beat_range(args) else { return ToolResult::missing("bad_arguments"); };
            let (Some(track), Some(index)) = (
                int_arg(args, "track").filter(|t| (0..=i64::from(i32::MAX)).contains(t)),
                int_arg(args, "index").filter(|i| (0..=i64::from(i32::MAX)).contains(i)),
            ) else {
                return ToolResult::missing("bad_arguments");
            };
            if known_track_is_out_of_range(&ctx.coalescer, track) {
                return ToolResult::missing("track_out_of_range");
            }
            let query = match ctx.query.lock() {
                Ok(q) => q.clone(),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some(query) = query else {
                return ToolResult::missing("not_connected");
            };

            // Both halves of the standard bracket, exactly as get_clip_notes
            // and get_rack_contents do it. get_arrangement_notes brackets
            // the CLIP; this one catches the TRACK moving underneath it.
            // The clip check does not subsume it: delete a track before
            // track 5 while this read is in flight, and if the clip now at
            // (5, 2) shares its (name, start, length) -- plausible on
            // duplicated parallel tracks, and more so now that unnamed clips
            // are the normal case -- the clip bracket passes and another
            // track's notes come back under this track's name.
            let before = track_identity(&ctx.coalescer, track);
            let (outcome, pre_effects) = tokio::join!(
                arrangement::get_arrangement_notes(
                    query.clone(),
                    track as i32,
                    index as i32,
                    arrangement::QUERY_TIMEOUT,
                ),
                midi_effects_before_instrument(query, track as i32),
            );
            if topology_moved(&before, &track_identity(&ctx.coalescer, track)) {
                return ToolResult::missing("topology_changed");
            }

            match outcome {
                Ok(result) => {
                    // An emptied read is not an empty clip: say what happened.
                    if result.notes.missing_reason.as_deref() == Some("clip_changed") {
                        return ToolResult::missing("clip_changed");
                    }
                    if note_offset > 0 && result.notes.missing_reason.is_some() {
                        return ToolResult::missing(&format!("cannot_continue_partial_note_read: {}", result.notes.missing_reason.as_deref().unwrap()));
                    }
                    let missing_reason = result.notes.missing_reason.clone();
                    let (mut payload, trimmed) = arrangement_notes_payload(result, time_signature(&ctx.coalescer), note_offset, range);
                    add_pre_midi_effects(&mut payload, pre_effects);
                    ToolResult::live(payload, joined_reason(missing_reason, trimmed))
                }
                Err(arrangement::ArrangementNotesError::NotMidi) => {
                    ToolResult::missing("not_midi_clip")
                }
                Err(arrangement::ArrangementNotesError::IdentityChanged) => {
                    ToolResult::missing("arrangement_clip_identity_changed")
                }
                Err(arrangement::ArrangementNotesError::Query(QueryError::NoReply)) => {
                    ToolResult::missing("no_reply")
                }
                Err(arrangement::ArrangementNotesError::Query(QueryError::Busy)) => {
                    ToolResult::missing("busy")
                }
                Err(arrangement::ArrangementNotesError::Query(QueryError::Transport(e))) => {
                    ToolResult::missing(&format!("transport_error: {e}"))
                }
            }
        }
        "get_device_chains" => {
            let track = match args.get("track") {
                None => None,
                Some(_) => match int_arg(args, "track").filter(|t| (0..i64::from(i32::MAX)).contains(t)) {
                    Some(t) => Some(t),
                    None => return ToolResult::missing("bad_arguments"),
                },
            };
            let Some(device_offset) = offset_arg(args, "device_offset") else { return ToolResult::missing("bad_arguments"); };
            if args.get("device_offset").is_some() && track.is_none() { return ToolResult::missing("bad_arguments"); }
            // Without a count there is nothing to iterate. Querying 0..0
            // would return an empty map, which reads as "the set has no
            // devices" -- an invented answer, not a missing one.
            let Some(num_tracks) = track_count(&ctx.coalescer).filter(|n| *n >= 0) else {
                return ToolResult::missing("not_in_mirror");
            };
            // Everything below is sized by `read_tracks`, never by
            // `num_tracks`: see MAX_FANOUT_TRACKS.
            let read_tracks = num_tracks.min(MAX_FANOUT_TRACKS);
            if track.is_some_and(|t| t >= num_tracks) { return ToolResult::missing("track_out_of_range"); }
            let selected = track.map_or(0..read_tracks, |t| t..t + 1);
            let query = match ctx.query.lock() {
                Ok(q) => q.clone(),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some(query) = query else {
                return ToolResult::missing("not_connected");
            };

            // Bracket the whole-set read with every track's mirrored name,
            // not just the count -- see `chains_moved` for why the count
            // alone is not enough.
            let before: Vec<Option<serde_json::Value>> = selected.clone()
                .map(|t| track_identity(&ctx.coalescer, t))
                .collect();

            let mut map = device_chains::get_device_chains_range(
                query, selected.start as i32, selected.end as i32, device_offset, 256,
                device_chains::QUERY_TIMEOUT,
            )
            .await;

            let after_count = track_count(&ctx.coalescer);
            let after: Vec<Option<serde_json::Value>> = selected.clone()
                .map(|t| track_identity(&ctx.coalescer, t))
                .collect();
            // The counts compared here are the REAL ones, clamped or not: a
            // set that grew from 600 to 700 tracks moved, and comparing two
            // clamped counts would call that stable.
            if chains_moved(num_tracks, after_count, &before, &after) {
                return ToolResult::missing("topology_changed");
            }

            let output_limited = trim_chain_map_for_model(&mut map);
            let mut missing_reason = chain_map_reasons(
                if track.is_some() { 1 } else { num_tracks },
                if track.is_some() { 1 } else { read_tracks }, &map.missing, &map.flags_missing);
            if output_limited {
                missing_reason = joined_reason(missing_reason, Some("model_output_limited: continue each track using next_device_offset".into()));
            }
            if map.tracks.iter().any(|t| t.next_device_offset.is_some()) {
                missing_reason = joined_reason(missing_reason, Some("device_list_partial: continue each track using next_device_offset".into()));
            }
            ToolResult::live(
                json!({ "tracks": map.tracks, "missing": map.missing, "scope": {"track":track,"device_offset":device_offset} }),
                missing_reason,
            )
        }
        "get_mixer" => {
            let track = match args.get("track") {
                None => None,
                Some(_) => match int_arg(args, "track").filter(|t| (0..i64::from(i32::MAX)).contains(t)) {
                    Some(t) => Some(t),
                    None => return ToolResult::missing("bad_arguments"),
                },
            };
            let Some(num_tracks) = track_count(&ctx.coalescer).filter(|n| *n >= 0) else {
                return ToolResult::missing("not_in_mirror");
            };
            let read_tracks = num_tracks.min(MAX_FANOUT_TRACKS);
            if track.is_some_and(|t| t >= num_tracks) { return ToolResult::missing("track_out_of_range"); }
            let selected = track.map_or(0..read_tracks, |t| t..t + 1);
            let query = match ctx.query.lock() {
                Ok(q) => q.clone(),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some(query) = query else {
                return ToolResult::missing("not_connected");
            };
            // The same bracket as the other whole-set reads: a reorder during
            // the fan-out would put one track's sends under another's index.
            let before: Vec<Option<serde_json::Value>> = selected.clone()
                .map(|t| track_identity(&ctx.coalescer, t))
                .collect();
            let map = mixer::get_mixer(query, selected.start as i32..selected.end as i32, mixer::QUERY_TIMEOUT).await;
            let after: Vec<Option<serde_json::Value>> = selected
                .map(|t| track_identity(&ctx.coalescer, t))
                .collect();
            if chains_moved(num_tracks, track_count(&ctx.coalescer), &before, &after) {
                return ToolResult::missing("topology_changed");
            }
            let mut map = map;
            let mut reason = mixer::reasons(
                &map,
                if track.is_some() { 1 } else { num_tracks },
                if track.is_some() { 1 } else { read_tracks },
            );
            if let Some(first) = trim_mixer_for_model(&mut map) {
                reason = joined_reason(reason, Some(format!(
                    "model_output_limited: tracks from {first} on are left out; read each with the track argument"
                )));
            }
            ToolResult::live(json!(map), reason)
        }
        "get_device_params" => {
            let Some(offset) = offset_arg(args, "offset") else { return ToolResult::missing("bad_arguments"); };
            let Some((track, path)) = track_and_path(args) else {
                return ToolResult::missing("bad_arguments");
            };
            if known_track_is_out_of_range(&ctx.coalescer, track) {
                return ToolResult::missing("track_out_of_range");
            }
            let query = match ctx.query.lock() {
                Ok(q) => q.clone(),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some(query) = query else {
                return ToolResult::missing("not_connected");
            };

            // Same bracket as get_clip_notes: a paged read can span several
            // seconds, and reading two different devices' parameters into
            // one answer is the failure this catches.
            let before = track_identity(&ctx.coalescer, track);
            let outcome = device_params::get_device_params(
                &query,
                track as i32,
                &path,
                offset,
                device_params::QUERY_TIMEOUT,
            )
            .await;
            if topology_moved(&before, &track_identity(&ctx.coalescer, track)) {
                return ToolResult::missing("topology_changed");
            }

            match outcome {
                Ok(d) => ToolResult::live(
                    json!({
                        "device": d.device,
                        "params": d.params,
                        "total": d.total,
                        "truncated": d.truncated,
                        "next_offset": d.next_offset,
                    }),
                    d.missing_reason,
                ),
                Err(QueryError::NoReply) => ToolResult::missing(
                    "no_reply: the track or the path may not exist, or Live did not answer",
                ),
                Err(QueryError::Busy) => ToolResult::missing("busy"),
                Err(QueryError::Transport(e)) => {
                    ToolResult::missing(&format!("transport_error: {e}"))
                }
            }
        }
        "get_rack_contents" => {
            let Some(device_offset) = offset_arg(args, "device_offset") else { return ToolResult::missing("bad_arguments"); };
            let Some(offset) = offset_arg(args, "offset") else { return ToolResult::missing("bad_arguments"); };
            let Some((track, path)) = track_and_path(args) else {
                return ToolResult::missing("bad_arguments");
            };
            if known_track_is_out_of_range(&ctx.coalescer, track) {
                return ToolResult::missing("track_out_of_range");
            }
            let query = match ctx.query.lock() {
                Ok(q) => q.clone(),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some(query) = query else {
                return ToolResult::missing("not_connected");
            };

            // Same bracket as get_device_params: this read pages over
            // several seconds and the producer is, by definition, working in
            // Live while asking. get_rack_contents brackets the DEVICE
            // itself; this one catches the TRACK moving underneath it.
            let before = track_identity(&ctx.coalescer, track);
            let outcome = rack_contents::get_rack_contents(
                &query,
                track as i32,
                &path,
                offset,
                device_offset,
                rack_contents::QUERY_TIMEOUT,
            )
            .await;
            if topology_moved(&before, &track_identity(&ctx.coalescer, track)) {
                return ToolResult::missing("topology_changed");
            }

            match outcome {
                Ok(r) => {
                    let payload = rack_payload(&r);
                    ToolResult::live(payload, r.missing_reason)
                }
                // Byte-identical to a lost reply, so the wording names both
                // causes rather than picking one. The model gets its indices
                // from get_device_chains and get_rack_contents, so a bad
                // path is a model error rather than a normal path.
                Err(QueryError::NoReply) => ToolResult::missing(
                    "no_reply: the track or the path may not exist, or Live did not answer",
                ),
                Err(QueryError::Busy) => ToolResult::missing("busy"),
                Err(QueryError::Transport(e)) => {
                    ToolResult::missing(&format!("transport_error: {e}"))
                }
            }
        }
        "get_sample" => {
            let Some((track, target)) = sample_target(args) else {
                return ToolResult::missing("bad_arguments");
            };
            if known_track_is_out_of_range(&ctx.coalescer, track) {
                return ToolResult::missing("track_out_of_range");
            }
            let query = match ctx.query.lock() {
                Ok(q) => q.clone(),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some(query) = query else {
                return ToolResult::missing("not_connected");
            };
            let before = track_identity(&ctx.coalescer, track);
            let outcome = sample::get_sample(&query, track as i32, &target, sample::QUERY_TIMEOUT).await;
            if topology_moved(&before, &track_identity(&ctx.coalescer, track)) {
                return ToolResult::missing("topology_changed");
            }
            match outcome {
                Ok(read) => {
                    let (payload, missing) = sample::sample_payload(&read, target.kind(), time_signature(&ctx.coalescer));
                    ToolResult::live(payload, missing.map(str::to_owned))
                }
                Err(sample::SampleError::Refused(reason)) => ToolResult::missing(reason),
                Err(sample::SampleError::Malformed) => ToolResult::missing("malformed_reply"),
                Err(sample::SampleError::Query(QueryError::NoReply)) => ToolResult::missing(
                    "no_reply: the track may not exist, the connector may need updating, or Live did not answer",
                ),
                Err(sample::SampleError::Query(QueryError::Busy)) => ToolResult::missing("busy"),
                Err(sample::SampleError::Query(QueryError::Transport(e))) => {
                    ToolResult::missing(&format!("transport_error: {e}"))
                }
            }
        }
        _ => ToolResult::missing("unknown_tool"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deltas::Delta;

    fn disconnected_ctx(c: Coalescer) -> ToolContext {
        ToolContext {
            coalescer: Arc::new(Mutex::new(c)),
            query: Arc::new(Mutex::new(None)),
        }
    }

    fn one_track_mirror() -> Coalescer {
        let mut c = Coalescer::new();
        c.observe_delta(Delta {
            addr: "/live/track/get/name".to_string(),
            args: vec![serde_json::json!(0), serde_json::json!("Bass")],
        });
        c
    }

    /// A `ToolContext` whose Live answers every device-chain query with an
    /// empty chain. Deliberately minimal -- `device_chains`'s own tests own
    /// the wire behaviour of the fan-out; this one only needs the call to
    /// reach its end so the assembled `missing_reason` can be read.
    async fn answering_ctx(c: Coalescer) -> ToolContext {
        use crate::osc::requests::RequestTable;
        use crate::osc::socket::OscSocket;

        let live = OscSocket::bind_to(0, 0).await.unwrap();
        let app = Arc::new(OscSocket::bind_to(0, live.local_port()).await.unwrap());
        let app_port = app.local_port();
        let table = Arc::new(Mutex::new(RequestTable::new()));

        let recv_socket = app.clone();
        let recv_table = table.clone();
        tokio::spawn(async move {
            loop {
                if let Ok(msg) = recv_socket.recv().await {
                    if let Ok(mut t) = recv_table.lock() {
                        t.resolve(&msg);
                    }
                }
            }
        });
        tokio::spawn(async move {
            loop {
                let Ok(req) = live.recv().await else { continue };
                let Some(&rosc::OscType::Int(track)) = req.args.first() else {
                    continue;
                };
                let reply = if req.addr == "/live/mixingpal/get/device_chain" {
                    vec![rosc::OscType::Int(track), req.args[1].clone(), rosc::OscType::Int(0)]
                } else {
                    vec![rosc::OscType::Int(track)]
                };
                let _ = live.send_to(app_port, &req.addr, reply).await;
            }
        });

        ToolContext {
            coalescer: Arc::new(Mutex::new(c)),
            query: Arc::new(Mutex::new(Some(Arc::new(LiveQuery::new(app, table))))),
        }
    }

    fn mirror_with_tracks(n: i64) -> Coalescer {
        let mut c = one_track_mirror();
        c.observe_delta(Delta {
            addr: "/live/song/get/num_tracks".to_string(),
            args: vec![serde_json::json!(n)],
        });
        c
    }

    #[test]
    fn get_device_chains_takes_no_arguments() {
        // It reads the whole set; making the model supply a track index would
        // defeat the one round trip that justifies the design.
        let schema = tool_schema();
        let tool = schema
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["function"]["name"] == "get_device_chains")
            .unwrap()
            .clone();
        assert_eq!(
            tool["function"]["parameters"]["required"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    fn description_of(name: &str) -> String {
        tool_schema()
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["function"]["name"] == name)
            .unwrap()["function"]["description"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn a_large_mixer_keeps_returns_and_master_and_names_the_first_track_left_out() {
        let send = |i: usize| mixer::Send { to: format!("«Return {i} with a long name»"), level: "-12.0 dB".into(), automation: None };
        let mut map = mixer::MixerMap {
            tracks: (0..512).map(|t| mixer::TrackMix {
                track: t, volume: "0.0 dB".into(), volume_automation: None, pan: "C".into(), pan_automation: None,
                output: "«Main»".into(), group_track: None, sends: (0..12).map(send).collect(),
            }).collect(),
            returns: vec![],
            master: None,
            missing_tracks: vec![],
            missing_returns: vec![],
        };
        let first = trim_mixer_for_model(&mut map).expect("512 tracks with 12 sends exceed the budget");
        assert_eq!(first as usize, map.tracks.len());
        assert!(serde_json::to_vec(&map).unwrap().len() <= MAX_MAP_BYTES);
        let mut small = mixer::MixerMap { tracks: map.tracks[..2].to_vec(), ..map };
        assert_eq!(trim_mixer_for_model(&mut small), None);
        assert_eq!(small.tracks.len(), 2);
    }

    // intro.als: the 808 placement starts at beat 73.5 with its start marker
    // at 3 inside a [0, 4) loop. Its D1 at source 0 first sounds after one
    // wrap, at 74.5 (19.3.3), not at the clip's start.
    #[test]
    fn a_note_before_the_start_marker_first_sounds_after_the_loop_wraps() {
        let region = clip_notes::LoopRegion { start_beats: 0.0, end_beats: 4.0 };
        let at = |note| first_sounding(note, 73.5, 14.0, 3.0, Some(&region));
        assert_eq!(at(3.25), Some(73.75));
        assert_eq!(at(0.0), Some(74.5));
        assert_eq!(at(1.5), Some(76.0));
        assert_eq!(at(5.0), None);
        // Without a loop, a note before the marker never plays here.
        assert_eq!(first_sounding(0.0, 73.5, 14.0, 3.0, None), None);
        assert_eq!(first_sounding(3.5, 73.5, 14.0, 3.0, None), Some(74.0));
        // A note past the placement's end does not sound.
        assert_eq!(first_sounding(3.5, 73.5, 0.25, 3.0, None), None);
    }

    // The same intro.als placement: five passes start at 73.5 (the partial
    // first one, from the marker), then every wrap from 74.5.
    #[test]
    fn a_looped_note_sounds_once_per_pass_it_reaches() {
        let region = clip_notes::LoopRegion { start_beats: 0.0, end_beats: 4.0 };
        assert_eq!(loop_pass_starts(73.5, 14.0, 3.0, &region), vec![73.5, 74.5, 78.5, 82.5, 86.5]);
        let times = |note| sounding_times(note, 73.5, 14.0, 3.0, Some(&region)).collect::<Vec<_>>();
        assert_eq!(times(3.25), vec![73.75, 77.75, 81.75, 85.75]);
        assert_eq!(times(0.0), vec![74.5, 78.5, 82.5, 86.5]);
        // The placement ends at 87.5, before the fourth 1.5 at 88.0.
        assert_eq!(times(1.5), vec![76.0, 80.0, 84.0]);
        assert!(times(5.0).is_empty());
        assert_eq!(sounding_times(3.5, 73.5, 14.0, 3.0, None).collect::<Vec<_>>(), vec![74.0]);
        assert_eq!(sounding_times(0.0, 73.5, 14.0, 3.0, None).count(), 0);
        // A note before the marker first sounds on pass 2.
        assert_eq!(pass_of(73.75, 73.5, 3.0, Some(&region)), 1);
        assert_eq!(pass_of(74.5, 73.5, 3.0, Some(&region)), 2);
        assert_eq!(pass_of(86.5, 73.5, 3.0, Some(&region)), 5);
    }

    fn bass_loop(length_beats: f64, muted: &[f64]) -> clip_notes::ClipNotes {
        let note = |(pitch, name, start): (i32, &str, f64)| clip_notes::Note {
            pitch, note: name.into(), start, duration: 0.5, velocity: 100.0, mute: muted.contains(&start), probability: 1.0,
        };
        let region = clip_notes::LoopRegion { start_beats: 0.0, end_beats: 4.0 };
        clip_notes::ClipNotes {
            notes: [(45, "A1", 0.0), (48, "C2", 1.0), (52, "E2", 2.0), (55, "G2", 3.0)].map(note).to_vec(),
            length_beats, source_start_beats: Some(0.0), note_range: Some(region.clone()),
            loop_region: Some(region), loop_state_known: true, missing_reason: None,
        }
    }

    // A 1-bar, four-note loop stretched over bars 2 and 3. A pilot answer
    // said the track had four notes; it plays eight.
    #[test]
    fn a_stretched_loop_lists_every_note_as_it_plays() {
        let played = played_notes(&bass_loop(4.0, &[]), Some((4, 4)), 4.0, 8.0, None).ok().unwrap();
        let listed: Vec<_> = played.iter().map(|n| (n["note"].as_str().unwrap(), n["timeline_position"].as_str().unwrap(), n["clip_position"].as_str().unwrap(), n["pass"].as_u64().unwrap())).collect();
        assert_eq!(listed, [
            ("A1", "2.1.1", "1.1.1", 1), ("C2", "2.2.1", "1.2.1", 1), ("E2", "2.3.1", "1.3.1", 1), ("G2", "2.4.1", "1.4.1", 1),
            ("A1", "3.1.1", "1.1.1", 2), ("C2", "3.2.1", "1.2.1", 2), ("E2", "3.3.1", "1.3.1", 2), ("G2", "3.4.1", "1.4.1", 2),
        ]);
        assert!(played[0].get("start").is_none() && played[0].get("mute").is_none(), "{}", played[0]);
        let mut payload = json!({});
        add_loop_passes(&mut payload, &bass_loop(4.0, &[]), Some((4, 4)), 4.0, 8.0);
        assert_eq!(payload, json!({
            "loop": "a 1-bar loop of 4 notes played 2 times, bars 2-3",
            "loop_passes": 2, "loop_pass_starts": ["2.1.1", "3.1.1"],
        }));
        let mut once = json!({});
        add_loop_passes(&mut once, &bass_loop(4.0, &[2.0]), Some((4, 4)), 4.0, 4.0);
        assert_eq!(once["loop"], json!("a 1-bar loop of 3 notes played once, bar 2"));
        let mut odd = json!({});
        add_loop_passes(&mut odd, &bass_loop(4.0, &[]), Some((7, 8)), 0.0, 7.0);
        assert_eq!(odd["loop"], json!("a 4-beat loop of 4 notes played 2 times, bars 1-2; the last pass is cut short"));
    }

    #[test]
    fn a_partial_last_pass_and_a_muted_note_do_not_sound() {
        // Seven beats: the second pass stops before its G2.
        let played = played_notes(&bass_loop(4.0, &[1.0]), Some((4, 4)), 4.0, 7.0, None).ok().unwrap();
        let at: Vec<_> = played.iter().map(|n| n["timeline_position"].as_str().unwrap()).collect();
        assert_eq!(at, ["2.1.1", "2.3.1", "2.4.1", "3.1.1", "3.3.1"]);
    }

    #[test]
    fn a_range_lists_only_the_notes_that_start_inside_it() {
        let played = played_notes(&bass_loop(4.0, &[]), Some((4, 4)), 4.0, 8.0, Some((8.0, 10.0))).ok().unwrap();
        let at: Vec<_> = played.iter().map(|n| n["timeline_position"].as_str().unwrap()).collect();
        assert_eq!(at, ["3.1.1", "3.2.1"]);
    }

    #[test]
    fn a_long_loop_falls_back_to_the_source_notes() {
        // 64 bars is exactly the cap; one more bar is past it.
        assert_eq!(played_notes(&bass_loop(4.0, &[]), Some((4, 4)), 0.0, 256.0, None).ok().unwrap().len(), MAX_UNROLLED_NOTES);
        assert!(matches!(played_notes(&bass_loop(4.0, &[]), Some((4, 4)), 0.0, 260.0, None), Err(SourceView::TooMany)));
        assert_eq!(played_notes(&bass_loop(4.0, &[]), Some((4, 4)), 0.0, 260.0, Some((4.0, 12.0))).ok().unwrap().len(), 8);
        // Without a signature there are no positions to give.
        assert!(matches!(played_notes(&bass_loop(4.0, &[]), None, 0.0, 8.0, None), Err(SourceView::Unplaceable)));
        let mut payload = json!({});
        add_loop_passes(&mut payload, &bass_loop(4.0, &[]), Some((4, 4)), 0.0, 400.0);
        assert_eq!(payload["loop_passes"], json!(100));
        assert_eq!(payload["loop"], json!("a 1-bar loop of 4 notes played 100 times, bars 1-100"));
        assert_eq!(payload["loop_pass_starts"].as_array().unwrap().len(), MAX_LISTED_PASSES);
    }

    #[test]
    fn a_note_that_can_never_play_is_not_listed_as_sounding() {
        let mut clip = bass_loop(4.0, &[]);
        clip.notes[1].probability = 0.0;
        let played = played_notes(&clip, Some((4, 4)), 4.0, 4.0, None).ok().unwrap();
        let at: Vec<_> = played.iter().map(|n| n["note"].as_str().unwrap()).collect();
        assert_eq!(at, ["A1", "E2", "G2"]);
        let mut payload = json!({});
        add_loop_passes(&mut payload, &clip, Some((4, 4)), 4.0, 4.0);
        assert_eq!(payload["loop"], json!("a 1-bar loop of 3 notes played once, bar 2"));
    }

    #[test]
    fn pass_words_describe_a_loop_without_counting_notes() {
        let region = clip_notes::LoopRegion { start_beats: 0.0, end_beats: 4.0 };
        let words = pass_words((4, 4), 152.0, 14.0, 0.0, 4, &region).unwrap();
        assert_eq!((words.size.as_str(), words.times.as_str(), words.span.as_str(), words.partial.as_str()),
            ("1-bar", "4 times", "bars 39-42", "; the last pass is cut short"));
        assert_eq!(bar_span(4.0, 4.0, 4.0), "bar 2");
    }

    // From the marker at beat 3, one beat of a four-note loop plays only G2.
    #[test]
    fn a_partial_pass_is_named_in_the_loop_summary() {
        let mut clip = bass_loop(4.0, &[]);
        clip.source_start_beats = Some(3.0);
        let played = played_notes(&clip, Some((4, 4)), 0.0, 1.0, None).ok().unwrap();
        assert_eq!(played.len(), 1);
        let mut payload = json!({});
        add_loop_passes(&mut payload, &clip, Some((4, 4)), 0.0, 1.0);
        assert_eq!(payload["loop"], json!("a 1-bar loop of 4 notes played once, bar 1; the first pass starts mid-loop"));
        let mut both = json!({});
        add_loop_passes(&mut both, &clip, Some((4, 4)), 0.0, 6.0);
        assert_eq!(both["loop"], json!("a 1-bar loop of 4 notes played 3 times, bars 1-2; the first pass starts mid-loop and the last pass is cut short"));
    }

    fn placed(clip: clip_notes::ClipNotes, muted: bool) -> arrangement::ArrangementClipNotes {
        arrangement::ArrangementClipNotes {
            name: Some("Bass".into()), start: 4.0, length: 8.0, muted, is_midi: true,
            loop_region: Some(arrangement::LoopRegion { start_beats: 0.0, end_beats: 4.0 }), notes: clip,
        }
    }

    #[test]
    fn a_muted_clip_is_read_as_source_and_says_why() {
        let (payload, _) = arrangement_notes_payload(placed(bass_loop(4.0, &[]), true), Some((4, 4)), 0, None);
        assert_eq!(payload["view"], "source");
        assert!(payload["view_reason"].as_str().unwrap().contains("muted"), "{payload}");
    }

    #[test]
    fn a_clip_that_cannot_be_placed_says_why() {
        let (payload, _) = arrangement_notes_payload(placed(bass_loop(4.0, &[]), false), None, 0, None);
        assert_eq!(payload["view"], "source");
        assert!(payload["view_reason"].as_str().unwrap().contains("time signature"), "{payload}");
    }

    #[test]
    fn a_partial_read_does_not_give_its_note_count_as_the_clip_total() {
        let mut clip = bass_loop(4.0, &[]);
        clip.missing_reason = Some("too_large".into());
        let (payload, _) = arrangement_notes_payload(placed(clip, false), Some((4, 4)), 0, None);
        assert_eq!(payload["view"], "source");
        assert!(payload.get("source_notes").is_none(), "{payload}");
        let (whole, _) = arrangement_notes_payload(placed(bass_loop(4.0, &[]), false), Some((4, 4)), 0, None);
        assert_eq!(whole["source_notes"], 4);
    }

    // The second page holds one note; the loop still holds all four.
    #[test]
    fn a_later_page_still_describes_the_whole_loop() {
        let (payload, _) = arrangement_notes_payload(placed(bass_loop(4.0, &[]), false), Some((4, 4)), 3, None);
        assert_eq!(payload["count"], 1);
        assert_eq!(payload["loop"], json!("a 1-bar loop of 4 notes played 2 times, bars 2-3"));
    }

    #[test]
    fn muted_notes_are_capped_like_any_note_list() {
        let note = |start| clip_notes::Note {
            pitch: 45, note: "A1".into(), start, duration: 0.25, velocity: 100.0, mute: true, probability: 1.0,
        };
        let mut clip = bass_loop(4.0, &[]);
        clip.notes.extend((0..MAX_NOTES_FOR_MODEL + 5).map(|i| note(i as f64 / 1024.0)));
        let (payload, trimmed) = arrangement_notes_payload(placed(clip, false), Some((4, 4)), 0, None);
        assert_eq!(payload["view"], "played");
        assert_eq!(payload["muted_notes"].as_array().unwrap().len(), MAX_NOTES_FOR_MODEL);
        assert!(trimmed.unwrap().contains("omitted 5"));
    }

    // The pilot's «Dorian #4» was a Scale device ahead of the instrument:
    // every note the clip sent was moved before it sounded.
    #[test]
    fn only_midi_effects_ahead_of_the_instrument_change_what_plays() {
        let devices = ["«Dorian #4» (Scale) [midi effect]", "«Bass» (Operator) [instrument]", "«Arp» (Arpeggiator) [midi effect]", "«EQ»"]
            .map(String::from)
            .to_vec();
        assert_eq!(
            effects_before_instrument(devices, vec![(4, true), (1, true), (4, true), (2, true)]),
            vec!["«Dorian #4» (Scale) [midi effect]"]
        );
        assert!(effects_before_instrument(vec!["«Bass»".into()], vec![(1, true)]).is_empty());
        // A Scale switched off changes nothing.
        assert!(effects_before_instrument(vec!["«Scale» [midi effect] [off]".into()], vec![(4, false)]).is_empty());
        let mut payload = json!({});
        add_pre_midi_effects(&mut payload, None);
        assert_eq!(payload["pre_midi_effects_unread"], true);
        let mut payload = json!({});
        add_pre_midi_effects(&mut payload, Some(vec![]));
        assert_eq!(payload, json!({}));
    }

    #[test]
    fn the_chain_map_points_at_the_mixer_for_returns_and_master() {
        // It iterates song.tracks. A model told it saw the whole mix will
        // report no reverb when the reverb is on a return.
        let description = description_of("get_device_chains");
        assert!(description.contains("every regular track"));
        assert!(description.contains("Return and master chains come from get_mixer"));
    }

    #[test]
    fn the_chain_map_says_what_its_labels_mean() {
        // [off] is the state at the playhead, which automation can change.
        let description = description_of("get_device_chains");
        for label in ["[off]", "[midi effect]", "[instrument]", "(Scale)", "automation at the playhead"] {
            assert!(description.contains(label), "{label}");
        }
    }

    #[test]
    fn automation_is_never_presented_as_the_setting() {
        for tool in ["get_device_params", "get_mixer"] {
            assert!(description_of(tool).contains("only the value at the playhead") || description_of(tool).contains("only its value at the playhead"), "{tool}");
        }
    }

    #[test]
    fn the_parameter_read_says_it_does_report_the_on_off_switch() {
        // The mirror image of the test above, and the reason the two are
        // separate: `Device.parameters[0]` is the device's on/off switch,
        // named `Device On`, for built-ins, plugins and Racks alike, and
        // `device_range.py` returns every parameter's name and formatted
        // value verbatim -- so this tool DOES carry bypass state. Copying
        // the chain map's sentence here told the model it knew less than it
        // did, so it discarded true evidence it was already holding.
        let description = description_of("get_device_params");
        assert!(description.contains("on/off switch"));
        assert!(description.contains("Device On"));
        assert!(
            !description.contains("bypassed is not reported"),
            "the chain map's sentence must not come back onto the parameter read"
        );
    }

    #[test]
    fn every_description_that_mentions_a_rack_now_points_at_the_way_in() {
        // The replaced version of this test asserted that both tools said
        // racks were opaque. They no longer are, and a description that
        // still said so would talk the model out of a tool it has.
        assert!(description_of("get_device_chains").contains("get_rack_contents"));
        assert!(description_of("get_device_params").contains("get_rack_contents"));
    }

    #[test]
    fn the_rack_tool_says_what_an_empty_result_means() {
        // Zero chains has two causes and only one is a model error, so the
        // description has to name both -- "this rack is empty" is a real
        // observation about a set.
        let d = description_of("get_rack_contents");
        assert!(d.contains("not a Rack"));
        assert!(d.contains("empty"));
    }

    #[test]
    fn both_path_tools_require_a_path_and_no_device_index() {
        for name in ["get_device_params", "get_rack_contents"] {
            let schema = tool_schema();
            let tool = schema
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["function"]["name"] == name)
                .unwrap()
                .clone();
            let required = tool["function"]["parameters"]["required"]
                .as_array()
                .unwrap();
            assert!(required.iter().any(|r| r == "track"), "{name}");
            assert!(required.iter().any(|r| r == "path"), "{name}");
            // Two ways to name one device is an ambiguity a model resolves
            // badly and inconsistently.
            assert!(
                tool["function"]["parameters"]["properties"]["device"].is_null(),
                "{name}"
            );
        }
    }

    #[test]
    fn the_schema_offers_all_three_device_tools() {
        let schema = tool_schema();
        let names: Vec<&str> = schema
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["function"]["name"].as_str())
            .collect();
        for expected in [
            "get_device_chains",
            "get_device_params",
            "get_rack_contents",
        ] {
            assert!(names.contains(&expected), "{expected}");
        }
    }

    #[tokio::test]
    async fn a_malformed_path_is_refused_before_it_reaches_the_wire() {
        let ctx = disconnected_ctx(one_track_mirror());
        for path in [json!([]), json!([0, 1]), json!([-1]), json!("0.1")] {
            let r = execute(
                &ctx,
                "get_rack_contents",
                &json!({ "track": 0, "path": path }),
            )
            .await;
            assert_eq!(r.missing_reason.as_deref(), Some("bad_arguments"), "{path}");
        }
    }

    #[tokio::test]
    async fn get_device_chains_without_a_track_count_says_so() {
        // Reports why it could not run instead of querying track 0..0 and
        // returning an empty map, which would read as "the set has no
        // devices".
        let ctx = disconnected_ctx(one_track_mirror());
        let r = execute(&ctx, "get_device_chains", &json!({})).await;
        assert_eq!(r.missing_reason.as_deref(), Some("not_in_mirror"));
    }

    #[tokio::test]
    async fn get_device_chains_reads_the_track_count_from_the_mirror() {
        // Pins the lookup shape: num_tracks is KeyArity::None, so the mirror
        // holds it with no key args and the count is args[0]. If this ever
        // drifts, the tool silently degrades to not_in_mirror.
        let ctx = disconnected_ctx(mirror_with_tracks(8));
        let r = execute(&ctx, "get_device_chains", &json!({})).await;
        assert_eq!(
            r.missing_reason.as_deref(),
            Some("not_connected"),
            "got past the mirror read and failed on the socket, as expected"
        );
    }

    #[tokio::test]
    async fn a_track_count_past_the_fan_out_clamp_is_reported_as_truncated() {
        // Live Standard and Suite put no ceiling on the track count, so a
        // set past the clamp is unusual but legal. Returning the first 512
        // tracks with `missing` empty and `missing_reason: null` would tell
        // the model it saw "every regular track", exactly what the tool
        // description promises -- when it saw 512 of 600.
        let ctx = answering_ctx(mirror_with_tracks(600)).await;
        let r = execute(&ctx, "get_device_chains", &json!({})).await;

        let reason = r.missing_reason.clone().unwrap_or_default();
        assert!(
            reason.starts_with("truncated_to_first_512_tracks"),
            "{reason}"
        );
        assert!(
            reason.contains("600"),
            "the real count has to be named: {reason}"
        );
        assert!(
            !r.fresh,
            "a truncated map is not a complete read of the set"
        );

        let tracks = r.value["tracks"].as_array().unwrap();
        let missing = r.value["missing"].as_array().unwrap();
        assert_eq!(
            tracks.len() + missing.len(),
            512,
            "every queried track is accounted for, and none past the clamp was queried"
        );
        assert!(tracks.iter().all(|t| t["track"].as_i64().unwrap() < 512));
    }

    #[tokio::test]
    async fn a_track_count_past_i32_does_not_wrap_into_a_small_fan_out() {
        // 2^32 + 5 narrows to 5 under `as i32`. Clamping on the i64 first is
        // what stops a corrupt mirrored count from turning a whole-set read
        // into a five-track one that reports itself complete.
        let ctx = answering_ctx(mirror_with_tracks(4_294_967_301)).await;
        let r = execute(&ctx, "get_device_chains", &json!({})).await;

        let reason = r.missing_reason.clone().unwrap_or_default();
        assert!(reason.contains("4294967301"), "{reason}");
        let tracks = r.value["tracks"].as_array().unwrap();
        let missing = r.value["missing"].as_array().unwrap();
        assert_eq!(
            tracks.len() + missing.len(),
            512,
            "the count wrapped instead of clamping"
        );
    }

    #[test]
    fn a_track_count_past_i32_still_finishes_the_identity_bracket() {
        // The clamp bounds the two identity brackets as well as the fan-out,
        // and those brackets are SYNCHRONOUS loops over `0..read_tracks`.
        // Move the clamp below them and the loops run over ~4.29e9 indices;
        // the test above would then hang instead of failing, and a hang is
        // a regression nobody reads as one.
        //
        // Asserting on it needs no bracket length exposed from production
        // code -- run the call under a deadline instead. Three details make
        // that report a failure rather than reproduce the hang:
        //   - multi_thread, so the deadline's timer runs on a worker the
        //     synchronous loop is not occupying;
        //   - `tokio::spawn`, so the loop is on a task the deadline can
        //     stop waiting on;
        //   - `shutdown_background`, because dropping a runtime waits for
        //     its tasks, and a task inside a synchronous loop never yields
        //     -- a normal drop would hang the binary after the assertion
        //     failed but before libtest printed it.
        // The clamped path finishes in ~0.02 s against a 5 s deadline.
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let finished = rt.block_on(async {
            let ctx = answering_ctx(mirror_with_tracks(4_294_967_301)).await;
            let call =
                tokio::spawn(async move { execute(&ctx, "get_device_chains", &json!({})).await });
            tokio::time::timeout(std::time::Duration::from_secs(5), call).await
        });
        rt.shutdown_background();

        let r = finished
            .expect("the identity bracket ran unclamped over the raw mirrored count")
            .unwrap();
        assert!(r.missing_reason.unwrap_or_default().contains("4294967301"));
    }

    #[tokio::test]
    async fn get_device_params_refuses_a_missing_device_index() {
        let ctx = disconnected_ctx(one_track_mirror());
        let r = execute(&ctx, "get_device_params", &json!({ "track": 0 })).await;
        assert_eq!(r.missing_reason.as_deref(), Some("bad_arguments"));
    }

    #[test]
    fn the_schema_offers_get_arrangement_with_no_arguments() {
        let tool = tool_schema()
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["function"]["name"] == "get_arrangement")
            .cloned()
            .expect("get_arrangement is in the schema");
        assert_eq!(
            tool["function"]["parameters"]["required"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn arrangement_reasons_names_every_partial_read_at_once() {
        let reason = arrangement_reasons(600, 512, &[3], &[7], &[9]).unwrap();
        assert!(reason.contains("truncated_to_first_512_tracks"));
        assert!(reason.contains("no_reply_for_tracks: 3"));
        assert!(reason.contains("timeline_truncated_for_tracks: 7"));
        assert!(reason.contains("timeline_changed_during_read_for_tracks: 9"));
    }

    #[test]
    fn arrangement_reasons_keeps_a_moved_timeline_apart_from_a_silent_track() {
        // Two different things to tell a model: one track handed over real
        // clips that may be mis-paired, the other handed over nothing.
        let reason = arrangement_reasons(4, 4, &[], &[], &[2]).unwrap();
        assert_eq!(
            reason,
            "timeline_changed_during_read_for_tracks: 2 (the clips listed may pair a name \
             with another clip's position)"
        );
        assert!(!reason.contains("no_reply_for_tracks"));
    }

    #[test]
    fn one_based_bar_positions_do_not_relabel_beats_as_bars() {
        let four_four = grid((4, 4)).unwrap();
        assert_eq!(musical_position(0.0, &four_four), Some("1.1.1".into()));
        assert_eq!(musical_position(28.0, &four_four), Some("8.1.1".into()));
        assert_eq!(musical_position(32.0, &four_four), Some("9.1.1".into()));
    }

    #[test]
    fn note_payload_uses_musical_positions_without_rounding_microtiming() {
        let notes = vec![clip_notes::Note {
            pitch: 40,
            note: "E1".into(),
            start: 2.005_472,
            duration: 0.494_528_1,
            velocity: 100.0,
            mute: false,
            probability: 1.0,
        }];
        let payload = notes_payload(&notes, Some((4, 4)), Some(28.0));
        assert_eq!(payload[0]["start"], json!(2.005_472));
        assert_eq!(payload[0]["duration"], json!(0.494_528_1));
        assert_eq!(payload[0]["clip_position"], json!("1.3.1 + 0.005472 beats"));
        assert_eq!(
            payload[0]["timeline_position"],
            json!("8.3.1 + 0.005472 beats")
        );
        assert!(payload[0].get("duration_notation").is_none());
    }

    // Live's ruler counts the denominator unit as the beat. The fourth
    // eighth of a 6/8 bar is 1.4.1 on that ruler, not 1.2.3.
    #[test]
    fn positions_count_the_denominator_unit_as_the_beat() {
        let six_eight = grid((6, 8)).unwrap();
        assert_eq!(musical_position(1.5, &six_eight), Some("1.4.1".into()));
        assert_eq!(musical_position(3.0, &six_eight), Some("2.1.1".into()));
        assert_eq!(musical_position(0.25, &six_eight), Some("1.1.2".into()));
        let two_two = grid((2, 2)).unwrap();
        assert_eq!(musical_position(2.0, &two_two), Some("1.2.1".into()));
        assert!(grid((4, 3)).is_none());
    }

    #[test]
    fn duration_notation_names_only_plain_note_values() {
        assert_eq!(duration_notation(4.0), Some("whole note".into()));
        assert_eq!(duration_notation(3.0), Some("dotted 1/2 note".into()));
        assert_eq!(duration_notation(0.75), Some("dotted 1/8 note".into()));
        assert_eq!(duration_notation(8.0), None);
        assert_eq!(duration_notation(1.25), None);
        assert_eq!(duration_notation(0.4945), None);
    }

    #[test]
    fn duration_notation_does_not_wait_for_a_signature() {
        let notes = vec![clip_notes::Note {
            pitch: 40,
            note: "E1".into(),
            start: 0.0,
            duration: 1.0,
            velocity: 100.0,
            mute: false,
            probability: 1.0,
        }];
        let payload = notes_payload(&notes, None, None);
        assert_eq!(payload[0]["duration_notation"], json!("1/4 note"));
        assert!(payload[0].get("clip_position").is_none());
    }

    #[test]
    fn notes_beyond_the_model_cap_are_dropped_with_a_count() {
        let mut notes: Vec<clip_notes::Note> = (0..MAX_NOTES_FOR_MODEL + 3)
            .map(|i| clip_notes::Note {
                pitch: 40,
                note: "E1".into(),
                start: i as f64,
                duration: 0.25,
                velocity: 100.0,
                mute: false,
                probability: 1.0,
            })
            .collect();
        let reason = trim_notes_for_model(&mut notes).unwrap();
        assert_eq!(notes.len(), MAX_NOTES_FOR_MODEL);
        assert!(reason.contains("omitted 3 later notes"), "{reason}");
        let mut few = notes[..2].to_vec();
        assert!(trim_notes_for_model(&mut few).is_none());
    }

    #[test]
    fn note_and_loop_payloads_use_one_based_sixteenths_on_grid() {
        let notes = vec![clip_notes::Note {
            pitch: 40,
            note: "E1".into(),
            start: 0.25,
            duration: 0.5,
            velocity: 100.0,
            mute: false,
            probability: 1.0,
        }];
        let payload = notes_payload(&notes, Some((4, 4)), Some(32.0));
        assert_eq!(payload[0]["clip_position"], json!("1.1.2"));
        assert_eq!(payload[0]["timeline_position"], json!("9.1.2"));
        assert_eq!(payload[0]["duration_notation"], json!("1/8 note"));
        let loop_region = loop_region_payload(0.0, 4.0, Some((4, 4)));
        assert_eq!(loop_region["start_position"], json!("1.1.1"));
        assert_eq!(loop_region["end_position"], json!("2.1.1"));
    }

    #[test]
    fn note_tool_descriptions_require_readable_positions_for_editing() {
        for name in ["get_clip_notes", "get_arrangement_notes"] {
            let description = description_of(name);
            assert!(description.contains("duration_notation"), "{name}");
            assert!(description.contains("microtiming"), "{name}");
            assert!(description.contains("denominator unit"), "{name}");
        }
        assert!(description_of("get_arrangement_notes").contains("where the note first sounds in the song"));
        assert!(description_of("get_clip_notes").contains("clip_position"));
        assert!(description_of("get_arrangement_notes").contains("timeline_position"));
        assert!(description_of("get_arrangement").contains("first_unmuted_start"));
        assert!(description_of("get_arrangement").contains("start_position"));
    }

    #[test]
    fn arrangement_payload_gives_positions_live_shows_and_each_track_its_first_unmuted_start() {
        // "When does the hat come in" must be a lookup, not a scan of hundreds
        // of placements, and a bar number alone drops the beat: 9.2.1 is not 9.1.1.
        let clip = |index, start, muted| arrangement::ArrangementClip {
            index,
            name: None,
            start,
            length: 4.0,
            muted,
            is_midi: true,
            loop_region: None,
        };
        let map = arrangement::ArrangementMap {
            tracks: vec![
                arrangement::TrackArrangement {
                    track: 0,
                    clips: vec![clip(0, 0.0, true), clip(1, 33.0, false), clip(2, 40.0, false)],
                    truncated: false,
                    next_clip_index: None,
                    changed: false,
                },
                arrangement::TrackArrangement {
                    track: 1,
                    clips: vec![clip(0, 8.0, true)],
                    truncated: false,
                    next_clip_index: None,
                    changed: false,
                },
            ],
            missing: vec![],
            changed: vec![],
        };
        let payload = arrangement_payload(&map, Some((4, 4)));
        assert_eq!(
            payload["time_signature"],
            json!({ "numerator": 4, "denominator": 4 })
        );
        let track = &payload["tracks"][0];
        assert_eq!(track["clips"][0]["start_position"], json!("1.1.1"));
        assert_eq!(track["clips"][1]["start_position"], json!("9.2.1"));
        assert_eq!(track["clips"][1]["length_bars"], json!(1.0));
        assert!(track["clips"][1].get("bar_start").is_none());
        assert_eq!(track["first_unmuted_start"], json!("9.2.1"));
        assert!(payload["tracks"][1].get("first_unmuted_start").is_none());
    }

    #[test]
    fn arrangement_notes_timing_gives_the_position_live_shows() {
        let mut payload = json!({});
        add_bar_timing(&mut payload, 33.0, 8.0, Some((4, 4)));
        assert_eq!(payload["start_position"], json!("9.2.1"));
        assert_eq!(payload["length_bars"], json!(2.0));
        assert!(payload.get("bar_start").is_none());
    }

    #[tokio::test]
    async fn arrangement_tracks_carry_their_names() {
        // Without a name the model joins the index against the context block's
        // TRACKS list, and a wrong join files one track's clips under another.
        let q = arrangement::tests::fake_live(arrangement::tests::FakeLive {
            timelines: vec![vec![("".into(), 0.0, 4.0)], vec![]],
            ..Default::default()
        }).await;
        let ctx = ToolContext {
            coalescer: Arc::new(Mutex::new(mirror_with_tracks(2))),
            query: Arc::new(Mutex::new(Some(q))),
        };
        let r = execute(&ctx, "get_arrangement", &json!({})).await;
        assert_eq!(r.missing_reason, None);
        assert_eq!(r.value["tracks"][0]["name"], json!("«Bass»"));
        // The mirror holds no name for track 1, so none is invented.
        assert!(r.value["tracks"][1].get("name").is_none());
    }

    #[test]
    fn arrangement_model_payload_is_bounded_and_explicitly_partial() {
        let clips = (0..(MAX_ARRANGEMENT_CLIPS_FOR_MODEL + 2))
            .map(|index| arrangement::ArrangementClip {
                index: index as i32,
                name: None,
                start: index as f64,
                length: 1.0,
                muted: false,
                is_midi: true,
                loop_region: None,
            })
            .collect();
        let mut map = arrangement::ArrangementMap {
            tracks: vec![arrangement::TrackArrangement {
                track: 0,
                clips,
                truncated: false,
                next_clip_index: None,
                changed: false,
            }],
            missing: vec![],
            changed: vec![],
        };
        let reason = trim_arrangement_for_model(&mut map).unwrap();
        assert_eq!(map.tracks[0].clips.len(), MAX_ARRANGEMENT_CLIPS_FOR_MODEL);
        assert!(map.tracks[0].truncated);
        assert!(reason.contains("omitted 2 later placements"));
    }

    #[tokio::test]
    async fn arrangement_section_filter_keeps_later_tracks_before_the_output_cap() {
        let q = arrangement::tests::fake_live(arrangement::tests::FakeLive {
            timelines: vec![
                (0..600).map(|i| (String::new(), i as f32 + 128.0, i as f32 + 129.0)).collect(),
                vec![("ends at break".into(), 32.0, 64.0),
                     ("crosses break start".into(), 60.0, 68.0),
                     ("inside break".into(), 80.0, 84.0),
                     ("starts after break".into(), 128.0, 132.0)],
            ],
            ..Default::default()
        }).await;
        let ctx = ToolContext {
            coalescer: Arc::new(Mutex::new(mirror_with_tracks(2))),
            query: Arc::new(Mutex::new(Some(q))),
        };
        let r = execute(&ctx, "get_arrangement", &json!({"start_beats":64,"end_beats":128})).await;
        assert_eq!(r.missing_reason, None);
        assert_eq!(r.value["tracks"][0]["clips"], json!([]));
        let clips = r.value["tracks"][1]["clips"].as_array().unwrap();
        assert_eq!(clips.len(), 2);
        assert_eq!(clips[0]["index"], 1);
        assert_eq!(clips[1]["index"], 2);
        assert_eq!(r.value["scope"]["start_beats"], 64.0);
    }

    #[tokio::test]
    async fn a_one_sided_range_reads_to_the_open_end() {
        // A pilot model sent start_beats alone, got a bare bad_arguments,
        // and sent it again until the turn ran out of round trips.
        let q = arrangement::tests::fake_live(arrangement::tests::FakeLive {
            timelines: vec![vec![("intro".into(), 0.0, 16.0), ("drop".into(), 64.0, 96.0), ("outro".into(), 128.0, 160.0)]],
            ..Default::default()
        }).await;
        let ctx = ToolContext {
            coalescer: Arc::new(Mutex::new(mirror_with_tracks(1))),
            query: Arc::new(Mutex::new(Some(q))),
        };
        let indices = |r: &ToolResult| r.value["tracks"][0]["clips"].as_array().unwrap()
            .iter().map(|c| c["index"].as_i64().unwrap()).collect::<Vec<_>>();
        let from = execute(&ctx, "get_arrangement", &json!({"start_beats":64})).await;
        assert_eq!(from.missing_reason, None);
        assert_eq!(indices(&from), vec![1, 2]);
        let until = execute(&ctx, "get_arrangement", &json!({"end_beats":64})).await;
        assert_eq!(until.missing_reason, None);
        assert_eq!(indices(&until), vec![0]);
    }

    #[tokio::test]
    async fn arrangement_offset_recovers_a_track_beyond_the_scan_budget() {
        let q = arrangement::tests::fake_live(arrangement::tests::FakeLive {
            timelines: vec![vec![], (0..900).map(|i| (String::new(), i as f32, i as f32 + 1.0)).collect()],
            silent: vec![0],
            ..Default::default()
        }).await;
        let ctx = ToolContext {
            coalescer: Arc::new(Mutex::new(mirror_with_tracks(2))),
            query: Arc::new(Mutex::new(Some(q))),
        };
        let r = execute(&ctx, "get_arrangement", &json!({"track":1,"clip_offset":768})).await;
        assert_eq!(r.missing_reason, None);
        assert_eq!(r.value["tracks"].as_array().unwrap().len(), 1);
        assert_eq!(r.value["tracks"][0]["track"], 1);
        let clips = r.value["tracks"][0]["clips"].as_array().unwrap();
        assert_eq!(clips.len(), 132);
        assert_eq!(clips[0]["index"], 768);
    }

    #[tokio::test]
    async fn arrangement_refuses_invalid_scope_instead_of_reading_the_whole_set() {
        let ctx = disconnected_ctx(mirror_with_tracks(2));
        for args in [json!({"start_beats":128,"end_beats":64}), json!({"start_beats":-1}), json!({"track":-1}),
                     json!({"clip_offset":1}), json!({"track":0,"clip_offset":-1})] {
            let r = execute(&ctx, "get_arrangement", &args).await;
            assert_eq!(r.missing_reason.as_deref(), Some("bad_arguments"), "{args}");
        }
    }

    #[test]
    fn a_clean_arrangement_read_has_no_reason_at_all() {
        assert_eq!(arrangement_reasons(4, 4, &[], &[], &[]), None);
    }

    #[tokio::test]
    async fn get_arrangement_without_a_track_count_says_so() {
        let ctx = disconnected_ctx(one_track_mirror());
        let r = execute(&ctx, "get_arrangement", &json!({})).await;
        assert_eq!(r.missing_reason.as_deref(), Some("not_in_mirror"));
    }

    #[tokio::test]
    async fn get_sample_needs_exactly_one_target() {
        let ctx = disconnected_ctx(one_track_mirror());
        for args in [
            json!({ "track": 0 }),
            json!({ "track": 0, "slot": 0, "index": 0 }),
            json!({ "track": 0, "index": 0, "path": [0] }),
            json!({ "track": 0, "slot": -1 }),
            json!({ "track": -1, "slot": 0 }),
            json!({ "track": 0, "path": [0, 1] }),
            json!({ "slot": 0 }),
        ] {
            let r = execute(&ctx, "get_sample", &args).await;
            assert_eq!(r.missing_reason.as_deref(), Some("bad_arguments"), "{args}");
        }
    }

    #[tokio::test]
    async fn get_sample_before_the_socket_binds_says_so() {
        let ctx = disconnected_ctx(one_track_mirror());
        let r = execute(&ctx, "get_sample", &json!({ "track": 0, "slot": 0 })).await;
        assert_eq!(r.missing_reason.as_deref(), Some("not_connected"));
    }

    #[tokio::test]
    async fn get_sample_on_a_silent_live_says_no_reply() {
        // A wire-14 connector knows no such address and answers nothing.
        let ctx = answering_ctx(one_track_mirror()).await;
        let r = execute(&ctx, "get_sample", &json!({ "track": 0, "index": 0 })).await;
        assert!(r.missing_reason.as_deref().unwrap().starts_with("no_reply"), "{:?}", r.missing_reason);
        assert_eq!(r.value, serde_json::Value::Null);
    }

    #[test]
    fn the_sample_description_says_it_is_not_the_mix() {
        let schema = tool_schema();
        let d = schema.as_array().unwrap().iter().find(|t| t["function"]["name"] == "get_sample").unwrap()["function"]["description"].as_str().unwrap().to_string();
        assert!(d.contains("not what the mix sounds like"), "{d}");
        assert!(d.contains("file name only"), "{d}");
    }

    #[tokio::test]
    async fn get_arrangement_notes_refuses_arguments_it_cannot_use() {
        // A negative index is not "the first clip". Python slices from the
        // END on one, so it would resolve inside Live to a real but
        // different clip -- the same reason get_device_params refuses a
        // negative path element before it reaches the wire.
        let ctx = disconnected_ctx(one_track_mirror());
        for args in [
            json!({}),
            json!({ "track": 0 }),
            json!({ "index": 0 }),
            json!({ "track": -1, "index": 0 }),
            json!({ "track": 0, "index": -1 }),
        ] {
            let r = execute(&ctx, "get_arrangement_notes", &args).await;
            assert_eq!(r.missing_reason.as_deref(), Some("bad_arguments"), "{args}");
            assert_eq!(r.value, serde_json::Value::Null, "{args}");
        }
    }

    #[tokio::test]
    async fn get_arrangement_notes_before_the_socket_binds_says_so() {
        let ctx = disconnected_ctx(one_track_mirror());
        let r = execute(
            &ctx,
            "get_arrangement_notes",
            &json!({ "track": 0, "index": 0 }),
        )
        .await;
        assert_eq!(r.missing_reason.as_deref(), Some("not_connected"));
    }

    #[tokio::test]
    async fn arrangement_note_output_honors_the_requested_offset() {
        let ctx = moving_clip_ctx(32.0, 32.0).await;
        let r = execute(&ctx, "get_arrangement_notes", &json!({"track":0,"index":0,"note_offset":1})).await;
        assert_eq!(r.value["notes"], json!([]));
        assert_eq!(r.value["note_offset"], 1);
        assert!(r.value["next_note_offset"].is_null());
    }

    #[tokio::test]
    async fn a_clip_that_never_identifies_itself_is_a_named_gap() {
        // `answering_ctx`'s Live echoes the track index and nothing else, so
        // the identity read decodes nothing -- byte-identical to the silence
        // an out-of-range index produces. The tool must name the gap rather
        // than return an empty note list, which would read as "this clip has
        // no notes in it".
        let ctx = answering_ctx(one_track_mirror()).await;
        let r = execute(
            &ctx,
            "get_arrangement_notes",
            &json!({ "track": 0, "index": 0 }),
        )
        .await;
        assert_eq!(r.missing_reason.as_deref(), Some("no_reply"));
        assert_eq!(r.value, serde_json::Value::Null);
    }

    /// A `ToolContext` whose Live answers `get_arrangement_notes`: the clip
    /// at (0, 0) starts at `first` on the first identity read and at
    /// `second` afterwards, and it holds one note.
    ///
    /// `arrangement.rs` owns the wire behaviour of the bracket; this fake
    /// exists so the STRING the arm maps that outcome to can be pinned.
    /// The tool description quotes `arrangement_clip_identity_changed`
    /// verbatim.
    async fn moving_clip_ctx(first: f32, second: f32) -> ToolContext {
        clip_ctx(first, second, false).await
    }

    /// `edited` makes the note snapshot differ after the first count, which
    /// is what a note moved during the read looks like.
    async fn clip_ctx(first: f32, second: f32, edited: bool) -> ToolContext {
        use crate::osc::requests::RequestTable;
        use crate::osc::socket::OscSocket;

        let live = OscSocket::bind_to(0, 0).await.unwrap();
        let app = Arc::new(OscSocket::bind_to(0, live.local_port()).await.unwrap());
        let app_port = app.local_port();
        let table = Arc::new(Mutex::new(RequestTable::new()));

        let recv_socket = app.clone();
        let recv_table = table.clone();
        tokio::spawn(async move {
            loop {
                if let Ok(msg) = recv_socket.recv().await {
                    if let Ok(mut t) = recv_table.lock() {
                        t.resolve(&msg);
                    }
                }
            }
        });

        tokio::spawn(async move {
            let mut seen_identity = 0;
            let mut seen_counts = 0;
            loop {
                let Ok(req) = live.recv().await else { continue };
                let reply = match req.addr.as_str() {
                    "/live/mixingpal/get/arrangement/identity" => {
                        seen_identity += 1;
                        let start = if seen_identity == 1 { first } else { second };
                        vec![
                            req.args[0].clone(),
                            req.args[1].clone(),
                            rosc::OscType::String("Verse".into()),
                            rosc::OscType::Float(start),
                            rosc::OscType::Float(start + 8.0),
                            rosc::OscType::Bool(false),
                            rosc::OscType::Bool(true),
                            rosc::OscType::Bool(false),
                            rosc::OscType::Float(0.0),
                            rosc::OscType::Float(0.0),
                        ]
                    }
                    "/live/arrangement_clip/get/length" => vec![
                        req.args[0].clone(),
                        req.args[1].clone(),
                        rosc::OscType::Float(8.0),
                    ],
                    "/live/arrangement_clip/get/num_notes" => vec![
                        req.args[0].clone(),
                        req.args[1].clone(),
                        rosc::OscType::Int(1),
                        rosc::OscType::String({
                            seen_counts += 1;
                            if edited && seen_counts > 1 { "b" } else { "a" }.repeat(64)
                        }),
                        rosc::OscType::Float(8.0),
                        rosc::OscType::Bool(false),
                        rosc::OscType::Float(0.0),
                        rosc::OscType::Float(0.0),
                        rosc::OscType::Float(0.0),
                        rosc::OscType::Float(8.0),
                    ],
                    "/live/arrangement_clip/get/notes_window" => vec![
                        req.args[0].clone(),
                        req.args[1].clone(),
                        req.args[2].clone(),
                        rosc::OscType::Int(60),
                        rosc::OscType::Float(0.0),
                        rosc::OscType::Float(0.5),
                        rosc::OscType::Float(100.0),
                        rosc::OscType::Bool(false),
                        rosc::OscType::Float(1.0),
                    ],
                    _ => continue,
                };
                let _ = live.send_to(app_port, &req.addr, reply).await;
            }
        });

        ToolContext {
            coalescer: Arc::new(Mutex::new(one_track_mirror())),
            query: Arc::new(Mutex::new(Some(Arc::new(LiveQuery::new(app, table))))),
        }
    }

    // An emptied read reaching the model as `notes: []` reads as an empty clip.
    #[tokio::test]
    async fn notes_edited_mid_read_are_a_missing_result_not_an_empty_clip() {
        let ctx = clip_ctx(32.0, 32.0, true).await;
        let r = execute(&ctx, "get_arrangement_notes", &json!({ "track": 0, "index": 0 })).await;
        assert_eq!(r.missing_reason.as_deref(), Some("clip_changed"));
        assert_eq!(r.value, serde_json::Value::Null);
    }

    #[tokio::test]
    async fn a_clip_that_moved_mid_read_reports_the_literal_the_docs_quote() {
        let ctx = moving_clip_ctx(32.0, 28.0).await;
        let r = execute(
            &ctx,
            "get_arrangement_notes",
            &json!({ "track": 0, "index": 0 }),
        )
        .await;
        assert_eq!(
            r.missing_reason.as_deref(),
            Some("arrangement_clip_identity_changed")
        );
        // A named gap, not a plausible answer: returning the notes with a
        // warning beside them invites the model to use them anyway.
        assert_eq!(r.value, serde_json::Value::Null);
        assert!(!r.fresh);
    }

    #[tokio::test]
    async fn a_clip_that_stayed_put_returns_its_notes_and_its_own_timing() {
        // The success path through the arm, and the field the schema now
        // tells the model to add to each note's start.
        let ctx = moving_clip_ctx(32.0, 32.0).await;
        let r = execute(
            &ctx,
            "get_arrangement_notes",
            &json!({ "track": 0, "index": 0 }),
        )
        .await;
        assert_eq!(r.missing_reason, None);
        assert_eq!(r.value["count"], json!(1));
        assert_eq!(r.value["name"], json!("«Verse»"));
        assert_eq!(r.value["start_beats"], json!(32.0));
        assert_eq!(r.value["length_beats"], json!(8.0));
        assert_eq!(r.value["notes"][0]["start"], json!(0.0));
    }

    #[tokio::test]
    async fn get_device_params_refuses_a_negative_index() {
        // A negative path element is refused before it reaches the wire:
        // Python slices from the END on one, so it would resolve inside
        // Live to a real but different device rather than naming none.
        let ctx = disconnected_ctx(one_track_mirror());
        let result = execute(
            &ctx,
            "get_device_params",
            &json!({ "track": 0, "path": [-1] }),
        )
        .await;
        assert_eq!(result.missing_reason.as_deref(), Some("bad_arguments"));
    }

    #[test]
    fn the_schema_lists_exactly_the_tools_the_model_may_call() {
        let schema = tool_schema();
        let names: Vec<&str> = schema
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap())
            .collect();
        // The proxy's allow-list is pinned to the same file.
        let shared: serde_json::Value =
            serde_json::from_str(include_str!("../../../shared/tool-names.json")).unwrap();
        let shared: Vec<&str> = shared["tools"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
        assert_eq!(names, shared);
        // Every entry must be a well-formed OpenAI function tool, or a
        // provider rejects the whole request with a 400 that reads like a
        // model problem.
        for t in schema.as_array().unwrap() {
            assert_eq!(t["type"], "function");
            assert!(t["function"]["description"].is_string());
            assert_eq!(t["function"]["parameters"]["type"], "object");
        }
    }

    #[tokio::test]
    async fn a_mirror_read_reports_an_age_that_is_older_than_its_query_time() {
        let ctx = disconnected_ctx(one_track_mirror());
        let result = execute(&ctx, "get_track_detail", &serde_json::json!({ "track": 0 })).await;
        assert_eq!(result.missing_reason, None);
        assert!(result.fresh);
        assert_eq!(result.value["name"], "«Bass»");
        let fresh_as_of = result
            .fresh_as_of
            .expect("a mirror read must report an age");
        assert!(fresh_as_of <= result.queried_at);
    }

    #[tokio::test]
    async fn a_track_the_mirror_has_never_seen_reports_a_reason_and_no_value() {
        let ctx = disconnected_ctx(one_track_mirror());
        let result = execute(&ctx, "get_track_detail", &serde_json::json!({ "track": 9 })).await;
        assert_eq!(result.value, serde_json::Value::Null);
        assert_eq!(result.missing_reason.as_deref(), Some("not_in_mirror"));
        assert!(!result.fresh);
    }

    #[tokio::test]
    async fn a_live_query_before_the_socket_binds_says_so_rather_than_hanging() {
        let ctx = disconnected_ctx(Coalescer::new());
        let result = execute(
            &ctx,
            "get_clip_notes",
            &serde_json::json!({ "track": 0, "clip": 0 }),
        )
        .await;
        assert_eq!(result.missing_reason.as_deref(), Some("not_connected"));
    }

    #[tokio::test]
    async fn an_unknown_tool_is_reported_not_silently_empty() {
        let ctx = disconnected_ctx(Coalescer::new());
        let result = execute(&ctx, "delete_everything", &serde_json::json!({})).await;
        assert_eq!(result.missing_reason.as_deref(), Some("unknown_tool"));
        assert_eq!(result.value, serde_json::Value::Null);
    }

    #[test]
    fn int_arg_accepts_an_integral_float_but_rejects_a_fractional_one() {
        // Real providers commonly emit floats for integer fields.
        assert_eq!(
            int_arg(&serde_json::json!({ "track": 1.0 }), "track"),
            Some(1)
        );
        assert_eq!(
            int_arg(&serde_json::json!({ "track": -2.0 }), "track"),
            Some(-2)
        );
        assert_eq!(int_arg(&serde_json::json!({ "track": 1.5 }), "track"), None);
        assert_eq!(
            int_arg(&serde_json::json!({ "track": 3 }), "track"),
            Some(3)
        );
    }

    #[test]
    fn track_identity_reads_the_mirrored_name() {
        let coalescer = Mutex::new(one_track_mirror());
        assert_eq!(
            track_identity(&coalescer, 0),
            Some(serde_json::json!("Bass"))
        );
        assert_eq!(track_identity(&coalescer, 4), None);
    }

    #[test]
    fn topology_moved_reports_a_rename_a_reorder_and_a_delete() {
        let bass = Some(serde_json::json!("Bass"));
        let kick = Some(serde_json::json!("Kick"));
        // A reorder shows up here exactly as a rename does: a different name
        // now sits at the index the query was keyed on. That is the case a
        // generation counter driven by num_tracks would miss entirely.
        assert!(topology_moved(&bass, &kick));
        // The track fell out of the mirror: deleted.
        assert!(topology_moved(&bass, &None));
        assert!(!topology_moved(&bass, &bass));
    }

    #[test]
    fn topology_moved_abstains_when_the_mirror_never_held_the_track() {
        // No baseline means no comparison. Reporting a change here would
        // invent a warning, which is the same class of error as inventing a
        // value.
        assert!(!topology_moved(&None, &Some(serde_json::json!("Bass"))));
        assert!(!topology_moved(&None, &None));
    }

    #[test]
    fn track_count_reads_the_mirrored_count_with_no_key_args() {
        // num_tracks is KeyArity::None, so the mirror holds it with no key
        // args and the count is args[0]. If this ever drifts, every reader
        // of track_count silently degrades to not_in_mirror.
        let coalescer = Mutex::new(mirror_with_tracks(8));
        assert_eq!(track_count(&coalescer), Some(8));
        assert_eq!(track_count(&Mutex::new(Coalescer::new())), None);
    }

    #[test]
    fn chains_moved_catches_a_same_count_reorder_a_count_check_alone_would_miss() {
        // This is the bug the count-only guard had: an add or delete changes
        // num_tracks, but a reorder does not. Two tracks swapping places
        // leaves the count identical while every downstream index now names
        // a different track's devices.
        let bass = Some(serde_json::json!("Bass"));
        let kick = Some(serde_json::json!("Kick"));
        let before = vec![bass.clone(), kick.clone()];
        let reordered = vec![kick, bass];
        assert!(chains_moved(2, Some(2), &before, &reordered));
    }

    #[test]
    fn chains_moved_reports_an_added_or_deleted_track() {
        let bass = Some(serde_json::json!("Bass"));
        let before = vec![bass.clone()];
        assert!(chains_moved(1, Some(2), &before, &[bass.clone(), None]));
        assert!(chains_moved(1, Some(0), &before, &[]));
    }

    #[test]
    fn chains_moved_abstains_on_a_stable_set() {
        let bass = Some(serde_json::json!("Bass"));
        let kick = Some(serde_json::json!("Kick"));
        let names = vec![bass, kick];
        assert!(!chains_moved(2, Some(2), &names, &names));
    }

    #[test]
    fn rack_payload_omits_what_was_never_observed_rather_than_nulling_it() {
        // A window-0 decode failure observes NOTHING about the device's
        // structure. An explicit `"is_rack": null` still invites the model to
        // read something into the field, and the tool description tells it
        // this field distinguishes "not a Rack" from "an empty Rack" -- so the
        // key has to be absent, not present-and-empty.
        let unobserved = rack_contents::RackContents {
            next_offset: None,
            chains: vec![],
            total_chains: None,
            is_rack: None,
            truncated: false,
            missing_reason: Some("malformed_reply".to_string()),
        };
        let payload = rack_payload(&unobserved);
        assert!(
            payload.get("is_rack").is_none(),
            "is_rack must be absent, not null"
        );
        assert!(payload.get("total_chains").is_none());
        assert_eq!(payload["chains"], json!([]));
    }

    #[test]
    fn rack_payload_carries_an_empty_rack_as_a_real_observation() {
        // The mirror image, and the reason the two must stay distinguishable:
        // "this Rack has nothing loaded in it" is a real thing to know about a
        // set, and it is reported with the fields present.
        let empty_rack = rack_contents::RackContents {
            next_offset: None,
            chains: vec![],
            total_chains: Some(0),
            is_rack: Some(true),
            truncated: false,
            missing_reason: None,
        };
        let payload = rack_payload(&empty_rack);
        assert_eq!(payload["is_rack"], json!(true));
        assert_eq!(payload["total_chains"], json!(0));
    }

    #[test]
    fn chain_map_reasons_is_none_on_a_clean_read() {
        assert_eq!(chain_map_reasons(4, 4, &[], &[]), None);
    }

    #[test]
    fn chain_map_reasons_names_a_truncated_fan_out_alone() {
        let reason = chain_map_reasons(600, 512, &[], &[]).unwrap();
        assert_eq!(reason, "truncated_to_first_512_tracks: the set has 600");
    }

    #[test]
    fn chain_map_reasons_names_tracks_that_did_not_answer_at_all_alone() {
        let reason = chain_map_reasons(4, 4, &[1, 3], &[]).unwrap();
        assert_eq!(reason, "no_reply_for_tracks: 1, 3");
    }

    #[test]
    fn chain_map_reasons_names_tracks_missing_only_their_rack_marks_alone() {
        // The devices ARE listed for these tracks; only which of them are
        // Racks is unknown. A reader who took this as "these tracks failed"
        // would discard a chain map that is present and correct.
        let reason = chain_map_reasons(4, 4, &[], &[2]).unwrap();
        assert_eq!(
            reason,
            "rack_marks_unavailable_for_tracks: 2 (their devices are listed, but which are Racks is unknown)"
        );
    }

    #[test]
    fn chain_map_reasons_joins_all_three_when_all_three_hold() {
        // All three can hold at once, and none may overwrite another.
        let reason = chain_map_reasons(600, 512, &[1], &[2]).unwrap();
        assert_eq!(
            reason,
            "truncated_to_first_512_tracks: the set has 600; \
no_reply_for_tracks: 1; \
rack_marks_unavailable_for_tracks: 2 (their devices are listed, but which are Racks is unknown)"
        );
    }

    #[tokio::test]
    async fn a_missing_or_wrongly_typed_argument_is_reported_not_defaulted() {
        // Defaulting a missing track index to 0 would answer a question the
        // model did not ask, about a track it did not name.
        let ctx = disconnected_ctx(one_track_mirror());
        for args in [
            serde_json::json!({}),
            serde_json::json!({ "track": "bass" }),
        ] {
            let result = execute(&ctx, "get_track_detail", &args).await;
            assert_eq!(result.missing_reason.as_deref(), Some("bad_arguments"));
        }
    }

    #[test]
    fn the_schema_offers_get_clips_with_no_arguments() {
        // A whole-set read, like get_device_chains: an argument would invite
        // the model to guess a track index it has no reason to know.
        let tool = tool_schema()
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["function"]["name"] == "get_clips")
            .cloned()
            .expect("get_clips is in the schema");
        assert_eq!(
            tool["function"]["parameters"]["required"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn the_clip_tools_point_at_each_other() {
        // Same contract as get_device_chains <-> get_rack_contents: the
        // description is where the model learns the call order.
        assert!(description_of("get_clips").contains("get_clip_notes"));
        assert!(description_of("get_clip_notes").contains("get_clips"));
    }

    #[test]
    fn clip_map_reasons_names_every_partial_read_at_once() {
        // All three can hold together, and none may overwrite another.
        let reason = clip_map_reasons(600, 512, &[3], &[7]).unwrap();
        assert_eq!(
            reason,
            "truncated_to_first_512_tracks: the set has 600; \
no_reply_for_tracks: 3; \
midi_flag_unavailable_for_tracks: 7 (their clips are listed, but whether the track is MIDI is unknown)"
        );
    }

    #[test]
    fn a_clean_clip_read_has_no_reason_at_all() {
        assert_eq!(clip_map_reasons(4, 4, &[], &[]), None);
    }

    #[tokio::test]
    async fn get_clips_without_a_track_count_says_so() {
        // Querying 0..0 would return an empty map, which reads as "the set
        // has no clips" -- an invented answer, not a missing one.
        let ctx = disconnected_ctx(one_track_mirror());
        let r = execute(&ctx, "get_clips", &json!({})).await;
        assert_eq!(r.missing_reason.as_deref(), Some("not_in_mirror"));
    }
}
