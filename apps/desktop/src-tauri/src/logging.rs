//! Rotating file log in `<data>/logs/`. Rules: never log keys, trade data, prices, file paths or
//! response bodies. As a second line of defence, known paths (data folder, home folder) are
//! replaced with placeholders before a line is written.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use log::{LevelFilter, Log, Metadata, Record};

const MAX_BYTES: u64 = 1024 * 1024;
const KEEP: usize = 5;

struct Sink {
    dir: PathBuf,
    name: String,
    file: Option<File>,
    size: u64,
}

pub struct FileLogger {
    sink: Mutex<Sink>,
    redactions: Vec<(String, &'static str)>,
}

impl Sink {
    fn path(&self, index: usize) -> PathBuf {
        if index == 0 {
            self.dir.join(format!("{}.log", self.name))
        } else {
            self.dir.join(format!("{}.{index}.log", self.name))
        }
    }

    fn open(&mut self) {
        let path = self.path(0);
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        self.file = options.open(&path).ok();
        self.size = self
            .file
            .as_ref()
            .and_then(|f| f.metadata().ok())
            .map_or(0, |m| m.len());
    }

    fn rotate(&mut self) {
        self.file = None;
        let _ = fs::remove_file(self.path(KEEP - 1));
        for i in (0..KEEP - 1).rev() {
            let _ = fs::rename(self.path(i), self.path(i + 1));
        }
        self.open();
    }

    fn write_line(&mut self, line: &str) {
        if self.file.is_none() {
            self.open();
        }
        if let Some(file) = self.file.as_mut() {
            if file.write_all(line.as_bytes()).is_ok() {
                self.size += line.len() as u64;
            }
        }
        if self.size > MAX_BYTES {
            self.rotate();
        }
    }
}

/// Replaces every known sensitive string with its placeholder (both slash styles on Windows).
pub fn redact(line: &str, redactions: &[(String, &'static str)]) -> String {
    let mut out = line.to_string();
    for (needle, placeholder) in redactions {
        if needle.is_empty() {
            continue;
        }
        out = out.replace(needle.as_str(), placeholder);
        let flipped = needle.replace('\\', "/");
        if flipped != *needle {
            out = out.replace(flipped.as_str(), placeholder);
        }
    }
    out
}

/// The default redaction list: the data folder, then the home folder (longest first).
pub fn default_redactions(data_dir: &Path) -> Vec<(String, &'static str)> {
    let mut list = vec![(data_dir.to_string_lossy().into_owned(), "<data>")];
    if let Some(home) = dirs::home_dir() {
        list.push((home.to_string_lossy().into_owned(), "<home>"));
    }
    list
}

/// UTC time as `YYYY-MM-DDTHH:MM:SSZ` (no external time crate).
pub fn utc_timestamp(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let rem = unix_secs % 86_400;
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

impl Log for FileLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let line = format!(
            "{} {:<5} {}: {}\n",
            utc_timestamp(secs),
            record.level(),
            record.target(),
            record.args()
        );
        let line = redact(&line, &self.redactions);
        if cfg!(debug_assertions) {
            eprint!("{line}");
        }
        if let Ok(mut sink) = self.sink.lock() {
            sink.write_line(&line);
        }
    }

    fn flush(&self) {
        if let Ok(mut sink) = self.sink.lock() {
            if let Some(f) = sink.file.as_mut() {
                let _ = f.flush();
            }
        }
    }
}

/// Installs the file logger. Safe to call once per process; later calls are ignored.
pub fn init(logs_dir: &Path, name: &str, redactions: Vec<(String, &'static str)>) {
    let logger = FileLogger {
        sink: Mutex::new(Sink {
            dir: logs_dir.to_path_buf(),
            name: name.to_string(),
            file: None,
            size: 0,
        }),
        redactions,
    };
    if log::set_boxed_logger(Box::new(logger)).is_ok() {
        log::set_max_level(if cfg!(debug_assertions) {
            LevelFilter::Debug
        } else {
            LevelFilter::Info
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_paths_in_both_slash_styles() {
        let list = vec![
            (r"C:\Users\Tester\AppData\Local\app".to_string(), "<data>"),
            (r"C:\Users\Tester".to_string(), "<home>"),
        ];
        let line = r"opened C:\Users\Tester\AppData\Local\app\journal.sealed and C:/Users/Tester/x";
        assert_eq!(
            redact(line, &list),
            r"opened <data>\journal.sealed and <home>/x"
        );
        assert_eq!(redact("nothing here", &list), "nothing here");
        assert_eq!(redact("x", &[(String::new(), "<e>")]), "x");
    }

    #[test]
    fn formats_utc_timestamps() {
        assert_eq!(utc_timestamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_timestamp(1_767_225_600), "2026-01-01T00:00:00Z");
        assert_eq!(utc_timestamp(1_709_164_799), "2024-02-28T23:59:59Z");
        assert_eq!(utc_timestamp(1_709_251_200), "2024-03-01T00:00:00Z");
    }

    #[test]
    fn rotates_and_keeps_a_bounded_number_of_files() {
        let tmp = tempfile::tempdir().unwrap();
        let mut sink = Sink {
            dir: tmp.path().to_path_buf(),
            name: "app".to_string(),
            file: None,
            size: 0,
        };
        let line = "x".repeat(200 * 1024) + "\n";
        for _ in 0..40 {
            sink.write_line(&line);
        }
        let count = fs::read_dir(tmp.path()).unwrap().count();
        assert_eq!(count, KEEP);
        assert!(fs::metadata(sink.path(0)).unwrap().len() <= MAX_BYTES + line.len() as u64);
    }
}
