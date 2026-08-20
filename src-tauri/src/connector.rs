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

        // The inner package name is hardcoded in install.rs's
        // connector_status(), which decides "installed" from
        // <folder>/mixingpal/version.py. Renaming the inner directory
        // without that string would make installed report false forever
        // while the installer keeps reporting success -- a failure nobody
        // sees until they run the real thing against real Live.
        let version = src.join("mixingpal").join("version.py");
        assert!(
            version.is_file(),
            "connector_status() reads <folder>/mixingpal/version.py, but {} is not there -- \
             rename the inner package and that path together",
            version.display()
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

    /// The bundle must carry the connector, to the exact directory
    /// `connector_source` looks in.
    ///
    /// `connector_source` joins `folder()` onto `resource_dir()`, which is
    /// `Contents/Resources` inside a macOS `.app`. If `bundle.resources` is
    /// missing, or maps to a different destination, the built app has no
    /// connector and falls through to the `CARGO_MANIFEST_DIR` branch -- a
    /// path baked in at compile time, pointing at the build machine. That
    /// branch succeeds on the build machine and nowhere else, so this
    /// failure is invisible in exactly the place it gets introduced.
    #[test]
    fn the_bundle_ships_the_connector_where_connector_source_looks_for_it() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json must be valid JSON");

        let resources = conf
            .get("bundle")
            .and_then(|bundle| bundle.get("resources"))
            .and_then(|resources| resources.as_object())
            .expect(
                "tauri.conf.json needs a bundle.resources map -- without it the connector \
                 is not in the .app at all, and first run fails on every machine but the \
                 one that built it",
            );

        let from = format!("../remote-script/{}/", folder());
        let to = format!("{}/", folder());

        assert_eq!(
            resources.get(&from).and_then(|dest| dest.as_str()),
            Some(to.as_str()),
            "bundle.resources must map {:?} to {:?}, because connector_source() joins \
             connector::folder() onto resource_dir(). Renaming the connector without \
             updating this map ships an app that cannot find its own connector.",
            from,
            to
        );
    }
}
