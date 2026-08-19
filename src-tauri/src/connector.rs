use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct Manifest {
    folder: String,
}

/// The directory name the Remote Script is installed under, which is also
/// the entry Live shows in Preferences > Link, Tempo & MIDI > Control
/// Surface.
///
/// Read from shared/connector.json rather than written here so the setup
/// screens, the installer, and the repo directory cannot drift apart. The
/// distribution plan renames all three; the test below fails if it renames
/// fewer than all three.
///
/// Parsed once at first use. `include_str!` bakes the manifest into the
/// binary, so a shipped app cannot disagree with the source tree it was
/// built from -- the same reason lib.rs reads shared/wire-version.json
/// this way.
#[allow(dead_code)]
pub fn folder() -> &'static str {
    use std::sync::OnceLock;
    static FOLDER: OnceLock<String> = OnceLock::new();
    FOLDER
        .get_or_init(|| {
            let manifest: Manifest = serde_json::from_str(include_str!("../../shared/connector.json"))
                .expect("shared/connector.json must be valid JSON with a folder field");
            manifest.folder
        })
        .as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn the_manifest_names_a_folder_that_actually_exists_in_the_repo() {
        // Two-way tripwire, in the same spirit as
        // wire_version_matches_the_shared_manifest: renaming the directory
        // without the manifest, or the manifest without the directory,
        // produces a setup flow that tells the producer to select an entry
        // Live does not have. That failure is invisible until someone runs
        // the installer against real Live.
        let src = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("remote-script")
            .join(folder());
        assert!(
            src.is_dir(),
            "shared/connector.json names {:?}, but remote-script/{} does not exist -- \
             rename both together",
            folder(),
            folder()
        );
    }

    #[test]
    fn the_folder_is_a_bare_directory_name() {
        // It is joined onto a path and shown to a human. A slash would
        // silently install to the wrong place.
        assert!(!folder().contains('/'), "folder must not contain a path separator");
        assert!(!folder().contains('\\'), "folder must not contain a path separator");
        assert!(!folder().is_empty());
    }
}
