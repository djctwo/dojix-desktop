//! SPEC 5.4 / phase 5 gate: an idle MT5 watcher uses under 1% CPU. This test binary holds only
//! this test, so the process's CPU time is the watcher's (plus a sleeping test thread).
#![cfg(feature = "brand-dojix")]

mod common;

use std::collections::HashMap;
use std::fs;
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use dojix_desktop_lib::mt5::discover::Roots;
use dojix_desktop_lib::mt5::watch::{FileState, Timing};
use dojix_desktop_lib::mt5::{Config, ImportSummary, Service};

/// CPU time (user + system) this process has used.
fn process_cpu() -> Duration {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        // SAFETY: valid out-pointers to local FILETIMEs and the current-process pseudo handle.
        let ok = unsafe {
            GetProcessTimes(
                GetCurrentProcess(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        };
        assert_ne!(ok, 0, "GetProcessTimes failed");
        let ticks = |t: FILETIME| (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime);
        Duration::from_nanos((ticks(kernel) + ticks(user)) * 100)
    }
    #[cfg(unix)]
    {
        // SAFETY: getrusage fills the zeroed struct it is given.
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
        assert_eq!(rc, 0, "getrusage failed");
        let tv = |t: libc::timeval| {
            Duration::from_secs(t.tv_sec as u64) + Duration::from_micros(t.tv_usec as u64)
        };
        tv(usage.ru_utime) + tv(usage.ru_stime)
    }
}

/// Process CPU time over wall time while this thread sleeps (the watcher runs meanwhile).
fn idle_share(window: Duration) -> f64 {
    let (cpu0, wall0) = (process_cpu(), Instant::now());
    std::thread::sleep(window);
    let cpu = process_cpu().saturating_sub(cpu0).as_secs_f64();
    cpu / wall0.elapsed().as_secs_f64()
}

#[test]
fn an_idle_watcher_uses_under_one_percent_cpu() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    let folders = [
        &tree.common_files,
        &tree.terminal_a_files,
        &tree.terminal_b_files,
        &tree.portable_files,
    ];
    for (i, dir) in folders.iter().enumerate() {
        for day in 0..10 {
            fs::write(
                dir.join(format!("DojixExport_{i}_202610{day:02}.csv")),
                SAMPLE,
            )
            .unwrap();
        }
        fs::write(dir.join("other.csv"), b"x\r\n").unwrap();
    }
    let paths: Vec<String> = folders
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    // Added on this machine ("Add folder…") and enabled.
    let config = Config {
        enabled: paths.clone(),
        custom: paths,
        ..Config::default()
    };

    for (name, timing, window) in [
        // The app's clocks (60 s poll): only folder events would wake it.
        ("default timing", Timing::default(), Duration::from_secs(10)),
        // A worst case: a full poll of four folders every 500 ms.
        (
            "500 ms poll",
            Timing {
                poll: Duration::from_millis(500),
                ..Timing::default()
            },
            Duration::from_secs(8),
        ),
    ] {
        let service = Service::new(Arc::new(CountSink::default()), Roots::default(), timing);
        service.reconcile(&config, HashMap::new).unwrap();
        // Let the start-up scan queue all 40 files, then handle them, so the watcher is idle.
        wait_until("all files queued", Duration::from_secs(30), || {
            service.status(&config).watch.pending.len() == 40
        });
        for p in service.status(&config).watch.pending {
            service.finish(
                p.token,
                ImportSummary {
                    file_name: p.file_name.clone(),
                    folder_id: p.folder_id.clone(),
                    format: Some("dojix_export".into()),
                    result: "imported".into(),
                    message: None,
                    parsed: 3,
                    inserted: 3,
                    duplicates: 0,
                    skipped: 0,
                    at_ms: 0,
                },
            );
        }
        let status = service.status(&config);
        assert!(status
            .watch
            .files
            .iter()
            .filter(|f| f.file_name.starts_with("DojixExport_"))
            .all(|f| f.state == FileState::Imported));
        let share = idle_share(window);
        println!("{name}: idle CPU {:.3}%", share * 100.0);
        assert!(
            share < 0.01,
            "{name}: the idle watcher used {:.2}% CPU",
            share * 100.0
        );
        service.suspend();
    }
}
