//! One running copy per data folder (SPEC 6.9): `journal.lock` held with an exclusive OS lock
//! (`LockFileEx` on Windows, `flock` on Linux) for the life of the process.

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::Path;

/// Holds the lock until dropped (normally: until the process exits).
#[derive(Debug)]
pub struct InstanceLock {
    _file: File,
}

#[derive(Debug)]
pub enum LockOutcome {
    Held(InstanceLock),
    /// Another process holds it: this data folder is already open.
    AlreadyOpen,
    /// The folder doesn't support locks (some network or FUSE mounts). The app opens anyway.
    Unsupported(io::Error),
}

fn open_lock_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

/// Tries to take the lock without waiting.
pub fn acquire(path: &Path) -> io::Result<LockOutcome> {
    let file = open_lock_file(path)?;
    Ok(match file.try_lock() {
        Ok(()) => LockOutcome::Held(InstanceLock { _file: file }),
        Err(TryLockError::WouldBlock) => LockOutcome::AlreadyOpen,
        Err(TryLockError::Error(e)) => LockOutcome::Unsupported(e),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_holder_is_refused_until_the_first_lets_go() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("journal.lock");
        let first = acquire(&path).unwrap();
        assert!(matches!(first, LockOutcome::Held(_)));
        assert!(matches!(acquire(&path).unwrap(), LockOutcome::AlreadyOpen));
        drop(first);
        assert!(matches!(acquire(&path).unwrap(), LockOutcome::Held(_)));
    }
}
