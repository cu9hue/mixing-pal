#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Area of the overlap between two rectangles, as i64 so a large monitor
/// times a large window cannot overflow.
fn overlap_area(a: Rect, b: Rect) -> i64 {
    let x = (a.x + a.width as i32).min(b.x + b.width as i32) - a.x.max(b.x);
    let y = (a.y + a.height as i32).min(b.y + b.height as i32) - a.y.max(b.y);
    if x <= 0 || y <= 0 {
        return 0;
    }
    x as i64 * y as i64
}

/// Where to actually put a window that would like to be at `desired`.
///
/// The failure this exists to prevent: the producer docks the card on an external
/// display, unplugs it, and reopens the app. The remembered position is on
/// a monitor that no longer exists, the window renders off-screen, and
/// because it is frameless there is no titlebar to drag it back with. The
/// only recovery would be deleting a settings file.
///
/// Picks the monitor holding the most of the window -- not the nearest
/// corner, which puts a window straddling the seam on the wrong screen.
pub fn clamp_to_visible(desired: Rect, monitors: &[Rect]) -> (i32, i32) {
    // An empty list means the platform did not tell us, not that there are
    // no screens. Trusting the caller beats inventing a screen.
    let Some(first) = monitors.first() else {
        return (desired.x, desired.y);
    };

    let home = monitors
        .iter()
        .max_by_key(|m| overlap_area(desired, **m))
        .copied()
        .unwrap_or(*first);

    // saturating_sub on the u32 subtraction: a window wider than its
    // monitor would otherwise wrap around to a vast positive number, and
    // the clamp below would shove it off the far edge.
    let max_x = home.x + home.width.saturating_sub(desired.width) as i32;
    let max_y = home.y + home.height.saturating_sub(desired.height) as i32;

    (
        desired.x.clamp(home.x, max_x),
        desired.y.clamp(home.y, max_y),
    )
}

use tauri::{LogicalSize, Manager, PhysicalPosition};

/// Applies a window geometry.
///
/// Every field comes from the frontend, because src/ui/windowMode.ts's
/// MODE_GEOMETRY is the one owner of what each mode looks like -- only the
/// frontend knows how tall the card's content is, and deriving
/// always-on-top and centring here as well gave one fact two owners that
/// nothing checked against each other. Rust owns only what the webview
/// cannot see: putting the window somewhere a human can actually reach it.
///
/// `center` is a one-shot, sent when the frontend enters a centred mode.
/// Centring on every call re-centred the setup window a second after the producer
/// dragged it, because the frontend re-renders on a 1s staleness tick.
#[tauri::command]
pub fn set_window_mode(
    app: tauri::AppHandle,
    width: u32,
    height: u32,
    always_on_top: bool,
    center: bool,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;

    window
        .set_size(LogicalSize::new(width as f64, height as f64))
        .map_err(|e| e.to_string())?;

    window
        .set_always_on_top(always_on_top)
        .map_err(|e| e.to_string())?;

    if center {
        window.center().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Keep the pill and the card wherever the producer last dragged them, but never
    // outside a screen that currently exists.
    let Ok(current) = window.outer_position() else {
        return Ok(());
    };
    let Ok(size) = window.outer_size() else {
        return Ok(());
    };

    let monitors: Vec<Rect> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            Rect { x: p.x, y: p.y, width: s.width, height: s.height }
        })
        .collect();

    let (x, y) = clamp_to_visible(
        Rect { x: current.x, y: current.y, width: size.width, height: size.height },
        &monitors,
    );

    if (x, y) != (current.x, current.y) {
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The window is created with `decorations: false`, so the ONLY way to
    /// move it is `data-tauri-drag-region`, which calls the core window
    /// plugin's `start_dragging` command. That command is NOT in
    /// `core:window`'s default permission set -- the default grants read-only
    /// getters and `internal-toggle-maximize` and nothing else. Without the
    /// explicit grant the drag is denied by the ACL and the window cannot be
    /// moved at all, with no titlebar to fall back on. This shipped once;
    /// the producer reported "I can't really move the window around".
    #[test]
    fn the_capability_grants_start_dragging() {
        let capability = include_str!("../capabilities/default.json");
        assert!(
            capability.contains("core:window:allow-start-dragging"),
            "capabilities/default.json must grant core:window:allow-start-dragging, \
             or a frameless window cannot be dragged"
        );
    }

    const LAPTOP: Rect = Rect { x: 0, y: 0, width: 1440, height: 900 };
    // A second display placed to the right, as macOS reports it.
    const EXTERNAL: Rect = Rect { x: 1440, y: 0, width: 2560, height: 1440 };

    #[test]
    fn a_window_fully_on_screen_is_left_alone() {
        let desired = Rect { x: 100, y: 100, width: 320, height: 480 };
        assert_eq!(clamp_to_visible(desired, &[LAPTOP]), (100, 100));
    }

    #[test]
    fn a_window_hanging_off_the_right_edge_is_pulled_back_in() {
        let desired = Rect { x: 1400, y: 100, width: 320, height: 480 };
        // 1440 - 320 = 1120.
        assert_eq!(clamp_to_visible(desired, &[LAPTOP]), (1120, 100));
    }

    #[test]
    fn a_window_hanging_off_the_bottom_is_pulled_back_in() {
        let desired = Rect { x: 100, y: 880, width: 320, height: 480 };
        assert_eq!(clamp_to_visible(desired, &[LAPTOP]), (100, 420));
    }

    #[test]
    fn a_negative_position_is_pulled_back_to_the_origin() {
        let desired = Rect { x: -50, y: -80, width: 320, height: 480 };
        assert_eq!(clamp_to_visible(desired, &[LAPTOP]), (0, 0));
    }

    #[test]
    fn a_position_on_the_second_monitor_is_clamped_to_that_monitor() {
        // Mostly on the external display, hanging off its right edge.
        let desired = Rect { x: 3900, y: 200, width: 320, height: 480 };
        // 1440 + 2560 - 320 = 3680.
        assert_eq!(clamp_to_visible(desired, &[LAPTOP, EXTERNAL]), (3680, 200));
    }

    #[test]
    fn a_position_on_a_monitor_that_is_gone_lands_on_the_one_that_is_left() {
        // Remembered from a session with the external display attached; the producer
        // is now on the laptop alone. Without this the card is invisible and
        // they have no titlebar to drag it back with.
        let desired = Rect { x: 3000, y: 400, width: 320, height: 480 };
        assert_eq!(clamp_to_visible(desired, &[LAPTOP]), (1120, 400));
    }

    #[test]
    fn the_monitor_holding_most_of_the_window_wins() {
        // Straddling the seam, with more area on the external display.
        let desired = Rect { x: 1380, y: 100, width: 320, height: 480 };
        // 60px on the laptop, 260px on the external -- so it belongs to the
        // external, whose left edge is 1440.
        assert_eq!(clamp_to_visible(desired, &[LAPTOP, EXTERNAL]), (1440, 100));
    }

    #[test]
    fn a_window_wider_than_its_monitor_pins_to_the_origin_rather_than_going_negative() {
        let small = Rect { x: 0, y: 0, width: 200, height: 200 };
        let desired = Rect { x: 50, y: 50, width: 320, height: 480 };
        assert_eq!(clamp_to_visible(desired, &[small]), (0, 0));
    }

    #[test]
    fn with_no_monitors_reported_the_desired_position_is_used_unchanged() {
        // Guessing is worse than trusting: an empty monitor list means the
        // platform did not tell us, not that there are no screens.
        let desired = Rect { x: 700, y: 300, width: 320, height: 480 };
        assert_eq!(clamp_to_visible(desired, &[]), (700, 300));
    }
}
