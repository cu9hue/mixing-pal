mod deltas;
mod osc;

use deltas::Coalescer;
use osc::socket::OscSocket;
use osc::subs::SINGLETON_SUBSCRIPTIONS;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let coalescer = Arc::new(Mutex::new(Coalescer::new()));

            // The socket is shared via Arc from the start: Task 12 adds a
            // second task that sends on it, and `send`/`send_to` are safe
            // from multiple Arc holders. Only the receive loop below may ever
            // call `recv()` — see the soundness note on `OscSocket::recv`.
            let recv_coalescer = coalescer.clone();
            tauri::async_runtime::spawn(async move {
                let socket = match OscSocket::bind().await {
                    Ok(s) => Arc::new(s),
                    Err(e) => {
                        eprintln!("failed to bind OSC socket: {e}");
                        return;
                    }
                };
                for addr in SINGLETON_SUBSCRIPTIONS {
                    let _ = socket.send(addr, vec![]).await;
                }
                // Sole reader: this loop is the only caller of `recv()` on
                // this socket for the lifetime of the app. Do not add a
                // second `recv()` caller — see `OscSocket::recv`'s doc
                // comment for why that hangs indefinitely.
                loop {
                    match socket.recv().await {
                        Ok(msg) => {
                            if let Ok(mut c) = recv_coalescer.lock() {
                                c.observe(&msg);
                            }
                        }
                        Err(e) => eprintln!("osc recv error: {e}"),
                    }
                }
            });

            // Emit loop: one batch every 250 ms.
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_millis(250));
                loop {
                    ticker.tick().await;
                    let batch = match coalescer.lock() {
                        Ok(mut c) => c.drain(),
                        Err(_) => continue,
                    };
                    if !batch.is_empty() {
                        let _ = handle.emit("live://deltas", batch);
                    }
                }
            });

            let window = app.get_webview_window("main").unwrap();
            window.set_always_on_top(true)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
