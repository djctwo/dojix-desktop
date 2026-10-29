//! The main window's size, position and maximised state across launches (SPEC 2.1: minimum
//! 900 × 600, default 1200 × 800). Kept in `window.json` in the data folder, in logical pixels so
//! it survives a change of display scaling. It holds no trading data. A missing, damaged or
//! off-screen record means the defaults (centred, 1200 × 800).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fsec;

pub const FILE: &str = "window.json";
pub const MIN_WIDTH: f64 = 900.0;
pub const MIN_HEIGHT: f64 = 600.0;
/// Larger than any real display; a bigger value is treated as damage.
const MAX_SIDE: f64 = 16_384.0;
/// How much of the window's top edge must be on a monitor to restore the position.
const VISIBLE_WIDTH: f64 = 120.0;
const VISIBLE_HEIGHT: f64 = 40.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

/// A monitor's work area in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl WindowState {
    /// The state with its size raised to the minimum; None when a value is not a finite,
    /// plausible number.
    pub fn sanitized(self) -> Option<Self> {
        let values = [self.x, self.y, self.width, self.height];
        if values.iter().any(|v| !v.is_finite() || v.abs() > MAX_SIDE * 4.0) {
            return None;
        }
        if self.width > MAX_SIDE || self.height > MAX_SIDE {
            return None;
        }
        Some(Self {
            width: self.width.max(MIN_WIDTH),
            height: self.height.max(MIN_HEIGHT),
            ..self
        })
    }

    /// True when enough of the window's title area lies on one of the monitors to grab it.
    pub fn visible_on(&self, monitors: &[Area]) -> bool {
        monitors.iter().any(|m| {
            let left = self.x.max(m.x);
            let right = (self.x + self.width).min(m.x + m.width);
            let top = self.y.max(m.y);
            let bottom = (self.y + VISIBLE_HEIGHT).min(m.y + m.height);
            right - left >= VISIBLE_WIDTH && bottom - top >= VISIBLE_HEIGHT
        })
    }
}

pub fn path(root: &Path) -> PathBuf {
    root.join(FILE)
}

/// The saved state, if it is readable and sane.
pub fn load(root: &Path) -> Option<WindowState> {
    let bytes = std::fs::read(path(root)).ok()?;
    serde_json::from_slice::<WindowState>(&bytes).ok()?.sanitized()
}

pub fn save(root: &Path, state: &WindowState) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(state).map_err(std::io::Error::other)?;
    fsec::write_atomic(&path(root), &bytes)
}

/// The state to open with: the saved one when it is still on a monitor (the position is dropped
/// otherwise, and the window is centred at the saved size).
pub fn restore(saved: Option<WindowState>, monitors: &[Area]) -> Option<(WindowState, bool)> {
    let state = saved?;
    let on_screen = monitors.is_empty() || state.visible_on(monitors);
    Some((state, on_screen))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Area = Area {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1040.0,
    };

    fn state(x: f64, y: f64) -> WindowState {
        WindowState {
            x,
            y,
            width: 1200.0,
            height: 800.0,
            maximized: false,
        }
    }

    #[test]
    fn round_trips_and_rejects_damage() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(load(tmp.path()), None);
        save(tmp.path(), &state(10.0, 20.0)).unwrap();
        assert_eq!(load(tmp.path()), Some(state(10.0, 20.0)));
        std::fs::write(path(tmp.path()), b"not json").unwrap();
        assert_eq!(load(tmp.path()), None);
        std::fs::write(
            path(tmp.path()),
            br#"{"x":0,"y":0,"width":100,"height":100,"maximized":true}"#,
        )
        .unwrap();
        let small = load(tmp.path()).unwrap();
        assert_eq!((small.width, small.height, small.maximized), (900.0, 600.0, true));
        std::fs::write(
            path(tmp.path()),
            br#"{"x":0,"y":0,"width":99999,"height":800,"maximized":false}"#,
        )
        .unwrap();
        assert_eq!(load(tmp.path()), None);
    }

    #[test]
    fn non_finite_values_are_damage() {
        let mut s = state(0.0, 0.0);
        s.x = f64::NAN;
        assert_eq!(s.sanitized(), None);
        s.x = 1e9;
        assert_eq!(s.sanitized(), None);
    }

    #[test]
    fn restores_only_on_a_monitor() {
        assert!(state(100.0, 100.0).visible_on(&[SCREEN]));
        assert!(!state(5000.0, 100.0).visible_on(&[SCREEN]));
        assert!(!state(100.0, 1030.0).visible_on(&[SCREEN]));
        let second = Area {
            x: 1920.0,
            ..SCREEN
        };
        assert!(state(2500.0, 50.0).visible_on(&[SCREEN, second]));
        assert_eq!(restore(None, &[SCREEN]), None);
        assert_eq!(
            restore(Some(state(5000.0, 0.0)), &[SCREEN]),
            Some((state(5000.0, 0.0), false))
        );
        assert_eq!(restore(Some(state(0.0, 0.0)), &[]), Some((state(0.0, 0.0), true)));
    }
}
