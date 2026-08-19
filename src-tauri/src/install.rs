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
#[allow(dead_code)]
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
#[allow(dead_code)]
pub fn default_user_library() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home).join("Music").join("Ableton").join("User Library");
    path.is_dir().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

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
        write(&src.join("copilot/version.py"), "WIRE_VERSION = 2");

        sync_dir(&src, &dest, EXCLUDE).unwrap();

        assert_eq!(std::fs::read_to_string(dest.join("__init__.py")).unwrap(), "a");
        assert_eq!(
            std::fs::read_to_string(dest.join("copilot/version.py")).unwrap(),
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
        // on the way out. connector_status() decides "installed" from
        // is_dir() on this exact path, so a stray empty directory left by a
        // failed install reads as a successful one.
        assert!(
            !root.join("dest").exists(),
            "a failed install must not leave a directory connector_status() would call installed"
        );
    }
}
