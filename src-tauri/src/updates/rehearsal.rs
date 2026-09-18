use super::{
    tests::{builder, offer, signed},
    Channel, UpdateState,
};
use flate2::{write::GzEncoder, Compression};
use std::{fs, io::Cursor, path::Path};
use tauri_plugin_updater::UpdaterExt;
use wiremock::{matchers::path, Mock, MockServer, ResponseTemplate};

fn archive(version: &str) -> Vec<u8> {
    let compressed = GzEncoder::new(Vec::new(), Compression::default());
    let mut tar = tar::Builder::new(compressed);
    for (path, bytes) in [
        (
            "Fixture.app/Contents/MacOS/fixture",
            b"fixture executable".as_slice(),
        ),
        ("Fixture.app/Contents/version.txt", version.as_bytes()),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        tar.append_data(&mut header, path, Cursor::new(bytes))
            .unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap()
}

fn installed_version(bundle: &Path) -> String {
    fs::read_to_string(bundle.join("Contents/version.txt")).unwrap()
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn real_plugin_replaces_only_the_isolated_bundle_after_recheck() {
    let root = std::env::temp_dir().join(format!(
        "mixing-pal-update-rehearsal-{}",
        uuid::Uuid::new_v4()
    ));
    let bundle = root.join("Fixture.app");
    let executable = bundle.join("Contents/MacOS/fixture");
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::write(&executable, b"old executable").unwrap();
    fs::write(bundle.join("Contents/version.txt"), "A").unwrap();

    let bytes = archive("B");
    let (key, signature) = signed(&bytes);
    let app = builder(&key);
    let server = MockServer::start().await;
    let updater = app
        .updater_builder()
        .executable_path(&executable)
        .endpoints(vec![format!("{}/manifest", server.uri()).parse().unwrap()])
        .unwrap()
        .target("darwin-aarch64")
        .build()
        .unwrap();

    offer(&server, "99.0.0", "invalid signature", "/bundle").await;
    Mock::given(path("/bundle"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes.clone()))
        .mount(&server)
        .await;
    let mut state = UpdateState::new(Channel::Stable);
    state.check(&updater).await.unwrap();
    assert!(state.download().await.is_err());
    assert_eq!(installed_version(&bundle), "A");

    server.reset().await;
    offer(&server, "99.0.0", &signature, "/bundle").await;
    Mock::given(path("/bundle"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes[..5].to_vec()))
        .mount(&server)
        .await;
    state.check(&updater).await.unwrap();
    assert!(state.download().await.is_err());
    assert_eq!(installed_version(&bundle), "A");

    server.reset().await;
    offer(&server, "99.0.0", &signature, "/bundle").await;
    Mock::given(path("/bundle"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes.clone()))
        .mount(&server)
        .await;
    state.check(&updater).await.unwrap();
    state.download().await.unwrap();
    assert_eq!(installed_version(&bundle), "A");

    server.reset().await;
    Mock::given(path("/manifest"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    assert!(state.verify_offer(&updater).await.is_err());
    assert_eq!(installed_version(&bundle), "A");

    server.reset().await;
    offer(&server, "99.0.0", &signature, "/bundle").await;
    Mock::given(path("/bundle"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes))
        .mount(&server)
        .await;
    state.check(&updater).await.unwrap();
    state.download().await.unwrap();
    state.verify_offer(&updater).await.unwrap();
    assert_eq!(installed_version(&bundle), "A");
    state.install().unwrap();
    assert_eq!(installed_version(&bundle), "B");
    assert_eq!(fs::read(&executable).unwrap(), b"fixture executable");
    fs::remove_dir_all(root).unwrap();
}
