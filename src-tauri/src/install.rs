use serde::Serialize;
use std::path::{Path, PathBuf};

/// Mirrors `remote-script/<folder>/` into the installed location.
///
/// Deliberately not "delete the destination and copy": `logs/` is created
/// inside the destination by a running Live session and is not ours. An
/// earlier `rm -rf` here broke logging for a live session mid-build, which
/// is why `exclude` is a parameter and why there is a test for it.
///
/// Excluded names are neither copied from the source nor removed from the
/// destination.
pub fn sync_dir(src: &Path, dest: &Path, exclude: &[&str]) -> std::io::Result<()> {
    if !src.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("connector source not found at {}", src.display()),
        ));
    }
    std::fs::create_dir_all(dest)?;

    let excluded = |name: &std::ffi::OsStr| exclude.iter().any(|e| name == std::ffi::OsStr::new(e));

    // Remove anything in the destination the source no longer has. A
    // handler deleted upstream must not keep running inside Live.
    for entry in std::fs::read_dir(dest)? {
        let entry = entry?;
        let name = entry.file_name();
        if excluded(&name) || src.join(&name).exists() {
            continue;
        }
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }

    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if excluded(&name) {
            continue;
        }
        let to = dest.join(&name);
        if entry.file_type()?.is_dir() {
            sync_dir(&entry.path(), &to, exclude)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }

    Ok(())
}

/// Where Live puts the User Library unless the producer moved it.
///
/// Returns None rather than a path that does not exist: creating the
/// directory ourselves would install into somewhere Live never reads, and
/// the producer would be left selecting a Control Surface entry that is
/// not there. Better to say we could not find it and ask.
pub fn default_user_library() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home).join("Music").join("Ableton").join("User Library");
    path.is_dir().then_some(path)
}

#[derive(Debug, Serialize)]
pub struct ConnectorStatus {
    /// The name Live shows in its Control Surface dropdown. The frontend
    /// interpolates this into the setup instructions rather than
    /// hardcoding it, so a rename cannot make the instructions wrong.
    pub folder: String,
    pub installed: bool,
    /// None means we could not find the User Library at its default path.
    pub user_library: Option<String>,
}

#[tauri::command]
pub fn connector_status() -> ConnectorStatus {
    let folder = crate::connector::folder().to_string();
    let library = default_user_library();
    // Not `is_dir()` on the folder: sync_dir creates the destination before
    // it copies, so a permission error or an interrupted copy leaves a
    // directory that exists but has nothing useful in it. Testing for the
    // version module -- which the wire-version handshake requires -- means
    // "installed" reports on a connector that got far enough to work,
    // rather than on the presence of an empty folder.
    let installed = library
        .as_ref()
        .map(|l| {
            l.join("Remote Scripts")
                .join(&folder)
                .join("mixingpal")
                .join("version.py")
                .is_file()
        })
        .unwrap_or(false);
    ConnectorStatus {
        folder,
        installed,
        user_library: library.map(|p| p.display().to_string()),
    }
}

#[derive(Debug, Serialize)]
pub struct InstallReport {
    pub destination: String,
}

/// Where the connector is copied from.
///
/// In a shipped app it is bundled as a Tauri resource. In development
/// that resource does not exist, so it falls back to the repo copy. The
/// distribution plan adds the bundling; this signature does not change
/// when it does -- only which branch is taken.
fn connector_source(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    let folder = crate::connector::folder();
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join(folder);
        if bundled.is_dir() {
            return bundled;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("remote-script")
        .join(folder)
}

/// Copies the connector into the User Library.
///
/// `user_library` overrides the default path, for the producer who moved
/// hers. The frontend sends null unless she typed one.
#[tauri::command]
pub fn install_connector(
    app: tauri::AppHandle,
    user_library: Option<String>,
) -> Result<InstallReport, String> {
    let library = match user_library {
        Some(raw) => {
            let path = PathBuf::from(raw.trim());
            if !path.is_dir() {
                return Err(format!("There's no folder at {}.", path.display()));
            }
            path
        }
        None => default_user_library().ok_or_else(|| {
            "Couldn't find your Ableton User Library where Live usually keeps it. \
             In Live, open Preferences → Library to see where yours is."
                .to_string()
        })?,
    };

    let dest = library.join("Remote Scripts").join(crate::connector::folder());
    sync_dir(&connector_source(&app), &dest, &["logs", "__pycache__"])
        .map_err(|e| format!("Couldn't install the connector: {e}"))?;

    Ok(InstallReport { destination: dest.display().to_string() })
}

/// Whether Ableton Live is running right now.
///
/// Used only to choose which sentence the restart step shows. It is never
/// a gate: arriving deltas are the real evidence that setup worked, and
/// this returning false must not block anyone whose Live is running under
/// a name we did not anticipate.
#[tauri::command]
pub fn live_is_running() -> bool {
    std::process::Command::new("/bin/ps")
        .args(["-Axco", "command"])
        .output()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .any(|line| line.trim() == "Live")
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// HOME is process-global, so the tests that move it must not run at
    /// the same time as each other.
    static ENV: Mutex<()> = Mutex::new(());

    /// A unique scratch directory per test, without pulling in a temp-file
    /// crate. Same pattern as settings.rs.
    fn scratch() -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mixingpal-install-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    const EXCLUDE: &[&str] = &["logs", "__pycache__"];

    #[test]
    fn a_fresh_install_copies_the_tree() {
        let root = scratch();
        let src = root.join("src");
        let dest = root.join("dest");
        write(&src.join("__init__.py"), "a");
        write(&src.join("mixingpal/version.py"), "WIRE_VERSION = 2");

        sync_dir(&src, &dest, EXCLUDE).unwrap();

        assert_eq!(std::fs::read_to_string(dest.join("__init__.py")).unwrap(), "a");
        assert_eq!(
            std::fs::read_to_string(dest.join("mixingpal/version.py")).unwrap(),
            "WIRE_VERSION = 2"
        );
    }

    #[test]
    fn reinstalling_overwrites_changed_files() {
        let root = scratch();
        let src = root.join("src");
        let dest = root.join("dest");
        write(&src.join("version.py"), "WIRE_VERSION = 3");
        write(&dest.join("version.py"), "WIRE_VERSION = 2");

        sync_dir(&src, &dest, EXCLUDE).unwrap();

        assert_eq!(std::fs::read_to_string(dest.join("version.py")).unwrap(), "WIRE_VERSION = 3");
    }

    #[test]
    fn reinstalling_removes_files_the_new_version_dropped() {
        // A handler deleted upstream must not keep running inside Live.
        let root = scratch();
        let src = root.join("src");
        let dest = root.join("dest");
        write(&src.join("keep.py"), "keep");
        write(&dest.join("keep.py"), "keep");
        write(&dest.join("gone.py"), "gone");

        sync_dir(&src, &dest, EXCLUDE).unwrap();

        assert!(dest.join("keep.py").exists());
        assert!(!dest.join("gone.py").exists(), "a dropped file must not survive a reinstall");
    }

    #[test]
    fn logs_written_by_a_running_live_session_survive_a_reinstall() {
        // The bug the bash installer already fixed once: an `rm -rf` on the
        // destination deleted logs/ on every reinstall, breaking logging for
        // a Live session that was running at the time. Do not regress this.
        let root = scratch();
        let src = root.join("src");
        let dest = root.join("dest");
        write(&src.join("__init__.py"), "a");
        write(&dest.join("logs/today.log"), "important");

        sync_dir(&src, &dest, EXCLUDE).unwrap();

        assert_eq!(
            std::fs::read_to_string(dest.join("logs/today.log")).unwrap(),
            "important",
            "logs/ is created by a running Live session and is not ours to delete"
        );
    }

    #[test]
    fn compiled_python_is_never_copied_and_never_deleted() {
        let root = scratch();
        let src = root.join("src");
        let dest = root.join("dest");
        write(&src.join("__init__.py"), "a");
        write(&src.join("__pycache__/stale.pyc"), "junk");
        write(&dest.join("__pycache__/existing.pyc"), "live's own");

        sync_dir(&src, &dest, EXCLUDE).unwrap();

        assert!(!dest.join("__pycache__/stale.pyc").exists(), "never ship a .pyc");
        assert!(dest.join("__pycache__/existing.pyc").exists(), "not ours to delete");
    }

    #[test]
    fn a_destination_whose_parents_do_not_exist_is_created() {
        let root = scratch();
        let src = root.join("src");
        let dest = root.join("a/b/c/dest");
        write(&src.join("__init__.py"), "a");

        sync_dir(&src, &dest, EXCLUDE).unwrap();

        assert!(dest.join("__init__.py").exists());
    }

    #[test]
    fn a_missing_source_is_an_error_rather_than_an_empty_install() {
        // Silently installing nothing would leave Live with a Control
        // Surface entry that loads and does nothing, which is far harder to
        // diagnose than a failed install.
        let root = scratch();
        let result = sync_dir(&root.join("nope"), &root.join("dest"), EXCLUDE);
        assert!(result.is_err());
        // Not just "it errored" -- it must not have created the destination
        // on the way out. A stray empty directory under Remote Scripts is
        // an entry Live offers in its Control Surface dropdown that loads
        // and does nothing.
        assert!(
            !root.join("dest").exists(),
            "a failed install must not leave a directory connector_status() would call installed"
        );
    }

    #[test]
    fn a_missing_user_library_is_reported_rather_than_created() {
        // The spec's own words: creating the directory ourselves would
        // install into somewhere Live never reads, and she would be left
        // selecting a Control Surface entry that is not there. The install
        // command turns this None into the pick-a-folder error.
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let home = scratch();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &home);

        let found = default_user_library();

        match previous {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }

        assert!(found.is_none(), "a User Library that is not there must not be invented");
        assert!(
            !home.join("Music").join("Ableton").join("User Library").exists(),
            "looking for the User Library must not create it"
        );
    }

    #[test]
    fn the_user_library_is_found_at_the_path_live_uses() {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let home = scratch();
        let library = home.join("Music").join("Ableton").join("User Library");
        std::fs::create_dir_all(&library).unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &home);

        let found = default_user_library();

        match previous {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }

        assert_eq!(found, Some(library));
    }
}
