//! OS moments that lock the app (SPEC 6.7). The idle timer and minimize live in `session.rs`
//! and `lib.rs`; this module adds:
//!
//! | Trigger | Windows | Linux (best effort, depends on the desktop) |
//! |---|---|---|
//! | Session locked | `WTS_SESSION_LOCK` | logind `Session.Lock`, `ScreenSaver.ActiveChanged(true)` |
//! | Sleep | `WM_POWERBROADCAST` / `PBT_APMSUSPEND` | logind `PrepareForSleep(true)` |
//! | User switch / log off | `WTS_CONSOLE_DISCONNECT`, `WTS_REMOTE_DISCONNECT`, `WTS_SESSION_LOGOFF` | logind `Session.Active = false` |
//!
//! Every trigger only *requests* a lock; the session ignores it while App Lock is off.

/// Called with a short reason ("os-lock", "sleep", "user-switch") for logs.
pub type OnTrigger = std::sync::Arc<dyn Fn(&'static str) + Send + Sync>;

#[cfg(windows)]
#[allow(unsafe_code)]
mod win {
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::RemoteDesktop::WTSRegisterSessionNotification;
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};

    use super::OnTrigger;

    const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
    const WM_POWERBROADCAST: u32 = 0x0218;
    const PBT_APMSUSPEND: WPARAM = 0x0004;
    const WTS_CONSOLE_DISCONNECT: WPARAM = 0x2;
    const WTS_REMOTE_DISCONNECT: WPARAM = 0x4;
    const WTS_SESSION_LOGOFF: WPARAM = 0x6;
    const WTS_SESSION_LOCK: WPARAM = 0x7;
    const NOTIFY_FOR_THIS_SESSION: u32 = 0;
    const SUBCLASS_ID: usize = 0x4458_4C4B; // "DXLK"

    static HANDLER: OnceLock<OnTrigger> = OnceLock::new();

    pub fn reason(msg: u32, wparam: WPARAM) -> Option<&'static str> {
        match (msg, wparam) {
            (WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK) => Some("os-lock"),
            (
                WM_WTSSESSION_CHANGE,
                WTS_CONSOLE_DISCONNECT | WTS_REMOTE_DISCONNECT | WTS_SESSION_LOGOFF,
            ) => Some("user-switch"),
            (WM_POWERBROADCAST, PBT_APMSUSPEND) => Some("sleep"),
            _ => None,
        }
    }

    unsafe extern "system" fn subclass(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if let (Some(why), Some(handler)) = (reason(msg, wparam), HANDLER.get()) {
            handler(why);
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    /// Hooks the main window's messages. Must run on the window's (UI) thread.
    /// `hwnd` is the window handle as an integer (it is only passed back to Windows).
    pub fn install(hwnd: isize, on_trigger: OnTrigger) -> Result<(), String> {
        let _ = HANDLER.set(on_trigger);
        let hwnd = hwnd as HWND;
        unsafe {
            if SetWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID, 0) == 0 {
                return Err("could not hook the window's messages".to_string());
            }
            if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) == 0 {
                log::warn!("session-lock notifications are unavailable");
            }
        }
        Ok(())
    }
}

#[cfg(windows)]
pub use win::install as install_windows;

#[cfg(target_os = "linux")]
mod linux {
    use std::time::Duration;

    use dbus::blocking::Connection;
    use dbus::message::MatchRule;
    use dbus::Message;

    use super::OnTrigger;

    const LOGIND: &str = "org.freedesktop.login1";

    fn session_path(conn: &Connection) -> Option<dbus::Path<'static>> {
        let proxy = conn.with_proxy(LOGIND, "/org/freedesktop/login1", Duration::from_secs(5));
        let reply: Result<(dbus::Path<'static>,), dbus::Error> = proxy.method_call(
            "org.freedesktop.login1.Manager",
            "GetSessionByPID",
            (std::process::id(),),
        );
        reply.ok().map(|(p,)| p)
    }

    fn system_bus(handler: OnTrigger) -> Result<(), dbus::Error> {
        let conn = Connection::new_system()?;
        let h = handler.clone();
        conn.add_match(
            MatchRule::new_signal("org.freedesktop.login1.Manager", "PrepareForSleep"),
            move |(starting,): (bool,), _: &Connection, _: &Message| {
                if starting {
                    h("sleep");
                }
                true
            },
        )?;
        let session = session_path(&conn);
        let mut lock_rule = MatchRule::new_signal("org.freedesktop.login1.Session", "Lock");
        lock_rule.path = session.clone();
        let h = handler.clone();
        conn.add_match(lock_rule, move |(): (), _: &Connection, _: &Message| {
            h("os-lock");
            true
        })?;
        if let Some(path) = session {
            let mut rule =
                MatchRule::new_signal("org.freedesktop.DBus.Properties", "PropertiesChanged");
            rule.path = Some(path);
            let h = handler.clone();
            conn.add_match(
                rule,
                move |(iface, changed, _): (String, dbus::arg::PropMap, Vec<String>),
                      _: &Connection,
                      _: &Message| {
                    if iface == "org.freedesktop.login1.Session" {
                        let inactive = changed
                            .get("Active")
                            .and_then(|v| dbus::arg::cast::<bool>(&v.0))
                            .is_some_and(|active| !*active);
                        if inactive {
                            h("user-switch");
                        }
                    }
                    true
                },
            )?;
        }
        loop {
            conn.process(Duration::from_secs(1))?;
        }
    }

    fn session_bus(handler: OnTrigger) -> Result<(), dbus::Error> {
        let conn = Connection::new_session()?;
        for iface in ["org.freedesktop.ScreenSaver", "org.gnome.ScreenSaver"] {
            let h = handler.clone();
            conn.add_match(
                MatchRule::new_signal(iface, "ActiveChanged"),
                move |(active,): (bool,), _: &Connection, _: &Message| {
                    if active {
                        h("os-lock");
                    }
                    true
                },
            )?;
        }
        loop {
            conn.process(Duration::from_secs(1))?;
        }
    }

    /// Listens on the system and session buses in two background threads. Failures are
    /// logged: the idle timer and minimize still lock.
    pub fn install(handler: OnTrigger) {
        let h = handler.clone();
        let spawned = std::thread::Builder::new()
            .name("lock-triggers-system".into())
            .spawn(move || {
                if let Err(e) = system_bus(h) {
                    log::warn!("logind lock/sleep signals unavailable: {e}");
                }
            });
        if let Err(e) = spawned {
            log::warn!("could not start the logind listener: {e}");
        }
        let spawned = std::thread::Builder::new()
            .name("lock-triggers-session".into())
            .spawn(move || {
                if let Err(e) = session_bus(handler) {
                    log::warn!("screensaver signals unavailable: {e}");
                }
            });
        if let Err(e) = spawned {
            log::warn!("could not start the screensaver listener: {e}");
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::install as install_linux;

#[cfg(all(test, windows))]
mod tests {
    use super::win::reason;

    #[test]
    fn windows_messages_that_lock() {
        assert_eq!(reason(0x02B1, 0x7), Some("os-lock"));
        assert_eq!(reason(0x02B1, 0x2), Some("user-switch"));
        assert_eq!(reason(0x02B1, 0x6), Some("user-switch"));
        assert_eq!(reason(0x0218, 0x4), Some("sleep"));
        assert_eq!(reason(0x02B1, 0x8), None, "unlock does nothing");
        assert_eq!(reason(0x0218, 0x7), None, "resume does nothing");
    }
}
