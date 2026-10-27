//! File-system security: owner-only folders and the durable "secure writer" (SPEC 6.2, 6.3).
//!
//! - Linux: folders 0700, files created 0600 with `O_CREAT|O_EXCL|O_NOFOLLOW`, fsync of the
//!   file, `rename(2)`, then fsync of the folder.
//! - Windows: folders get a protected DACL (current user + SYSTEM, inherited by files),
//!   files are created with `CREATE_NEW`, flushed with `FlushFileBuffers`, and moved into place
//!   with `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`.
//!
//! A file is never reopened or re-permissioned by path after it is written.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Writes `bytes` to `target` durably and atomically: a random temp name in the same folder,
/// create-new, write, flush to stable storage, rename over the target, flush the folder.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = target
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no folder"))?;
    let temp = temp_name(dir)?;
    let result = (|| {
        let mut file = create_new_private(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace(&temp, target)?;
        sync_dir(dir)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn temp_name(dir: &Path) -> io::Result<PathBuf> {
    let mut random = [0u8; 12];
    getrandom::fill(&mut random).map_err(|e| io::Error::other(e.to_string()))?;
    let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
    Ok(dir.join(format!(".tmp-{suffix}")))
}

#[cfg(unix)]
fn create_new_private(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(windows)]
fn create_new_private(path: &Path) -> io::Result<File> {
    // CREATE_NEW; the file inherits the folder's protected owner-only DACL.
    OpenOptions::new().write(true).create_new(true).open(path)
}

#[cfg(unix)]
fn replace(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> io::Result<()> {
    win::move_replace_write_through(from, to)
}

#[cfg(unix)]
fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

#[cfg(windows)]
fn sync_dir(_dir: &Path) -> io::Result<()> {
    // MOVEFILE_WRITE_THROUGH already returned only after the rename reached the disk.
    Ok(())
}

/// Creates a folder (and missing parents) owner-only. An existing folder is left as is.
pub fn create_private_dir(dir: &Path) -> io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    }
    #[cfg(windows)]
    {
        fs::create_dir_all(dir)?;
        win::protect_dir(dir)
    }
}

/// True when only the owner (and, on Windows, SYSTEM) can reach the folder.
pub fn dir_is_private(dir: &Path) -> io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(fs::metadata(dir)?.permissions().mode() & 0o077 == 0)
    }
    #[cfg(windows)]
    {
        win::dir_is_protected(dir)
    }
}

/// Re-applies owner-only protection to an existing folder.
pub fn make_dir_private(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
    }
    #[cfg(windows)]
    {
        win::protect_dir(dir)
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod win {
    //! Win32 calls for the owner-only DACL and the write-through rename.

    use std::ffi::OsStr;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW,
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetFileSecurityW, GetTokenInformation, SetFileSecurityW, TokenUser,
        DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    fn wide(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Reads a NUL-terminated UTF-16 string allocated by Windows, then frees it.
    unsafe fn take_local_wstr(p: *mut u16) -> String {
        let mut len = 0;
        while *p.add(len) != 0 {
            len += 1;
        }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
        LocalFree(p.cast());
        s
    }

    fn current_user_sid() -> io::Result<String> {
        unsafe {
            let mut token: HANDLE = ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut needed = 0u32;
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed);
            // u64 storage keeps the TOKEN_USER properly aligned.
            let mut buf = vec![0u64; (needed as usize).div_ceil(8).max(1)];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buf.as_mut_ptr().cast(),
                (buf.len() * 8) as u32,
                &mut needed,
            );
            CloseHandle(token);
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut sid_str: *mut u16 = ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut sid_str) == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(take_local_wstr(sid_str))
        }
    }

    /// The expected DACL: protected (no inheritance from the parent), full control for the
    /// current user and SYSTEM, inherited by files and sub-folders.
    fn expected_sddl() -> io::Result<String> {
        let user = current_user_sid()?;
        Ok(format!("D:P(A;OICI;FA;;;{user})(A;OICI;FA;;;SY)"))
    }

    pub fn protect_dir(dir: &Path) -> io::Result<()> {
        let sddl = wide(OsStr::new(&expected_sddl()?));
        let path = wide(dir.as_os_str());
        unsafe {
            let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                ptr::null_mut(),
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let ok = SetFileSecurityW(
                path.as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                sd,
            );
            LocalFree(sd);
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    fn dacl_sddl(dir: &Path) -> io::Result<String> {
        let path = wide(dir.as_os_str());
        unsafe {
            let mut needed = 0u32;
            GetFileSecurityW(
                path.as_ptr(),
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                0,
                &mut needed,
            );
            if needed == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
            if GetFileSecurityW(
                path.as_ptr(),
                DACL_SECURITY_INFORMATION,
                buf.as_mut_ptr().cast(),
                (buf.len() * 8) as u32,
                &mut needed,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let mut out: *mut u16 = ptr::null_mut();
            if ConvertSecurityDescriptorToStringSecurityDescriptorW(
                buf.as_mut_ptr().cast(),
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut out,
                ptr::null_mut(),
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(take_local_wstr(out))
        }
    }

    /// True when the folder's DACL is protected and grants access to exactly the current user
    /// and SYSTEM.
    pub fn dir_is_protected(dir: &Path) -> io::Result<bool> {
        let actual = dacl_sddl(dir)?;
        let expected = expected_sddl()?;
        Ok(normalise(&actual) == normalise(&expected))
    }

    /// Splits "D:P(ace)(ace)" into "is protected" and a sorted ACE list. Windows may add the
    /// AI flag and writes SYSTEM as its alias SY, so both forms compare equal.
    fn normalise(sddl: &str) -> (bool, Vec<String>) {
        let body = sddl.strip_prefix("D:").unwrap_or(sddl);
        let (flags, aces) = body.split_at(body.find('(').unwrap_or(body.len()));
        let mut list: Vec<String> = aces
            .split(')')
            .filter(|a| !a.is_empty())
            .map(|a| a.trim_start_matches('(').replace(";S-1-5-18", ";SY"))
            .collect();
        list.sort();
        (flags.contains('P'), list)
    }

    pub fn move_replace_write_through(from: &Path, to: &Path) -> io::Result<()> {
        let from = wide(from.as_os_str());
        let to = wide(to.as_os_str());
        let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::normalise;

        #[test]
        fn sddl_comparison_ignores_ace_order() {
            let a = normalise("D:P(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;S-1-5-21-1)");
            let b = normalise("D:PAI(A;OICI;FA;;;S-1-5-21-1)(A;OICI;FA;;;SY)");
            assert_eq!(a, b);
            assert_ne!(a, normalise("D:AI(A;OICI;FA;;;S-1-5-21-1)(A;OICI;FA;;;SY)"));
            assert_ne!(a, normalise("D:P(A;OICI;FA;;;S-1-5-21-1)(A;OICI;FA;;;SY)(A;;FA;;;BA)"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_replaces_the_target_and_leaves_no_temp_files() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("journal.sealed");
        write_atomic(&target, b"first").unwrap();
        write_atomic(&target, b"second").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"second");
        let names: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("journal.sealed")]);
    }

    #[test]
    fn private_dirs_are_private() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("data").join("nested");
        create_private_dir(&dir).unwrap();
        assert!(dir_is_private(&dir).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn written_files_are_owner_only_and_loose_dirs_are_repaired() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("f");
        write_atomic(&target, b"x").unwrap();
        assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o600);

        let loose = tmp.path().join("loose");
        fs::create_dir(&loose).unwrap();
        fs::set_permissions(&loose, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!dir_is_private(&loose).unwrap());
        make_dir_private(&loose).unwrap();
        assert!(dir_is_private(&loose).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn a_plain_folder_is_not_private_until_protected() {
        let tmp = tempfile::tempdir().unwrap();
        let plain = tmp.path().join("plain");
        fs::create_dir(&plain).unwrap();
        assert!(!dir_is_private(&plain).unwrap());
        make_dir_private(&plain).unwrap();
        assert!(dir_is_private(&plain).unwrap());
    }
}
