//! SIGTERM, SIGINT and SIGHUP (a `systemctl stop` from the Jatify Launcher, Ctrl+C, a closed terminal) take the
//! normal shutdown, as closing the window does: the local server is stopped and the running marker cleared, so the
//! next start does not offer a crash report for a stop that was asked for.
use std::sync::atomic::{AtomicBool, Ordering};

/// Set (inside the signal handler) once one of the signals arrived.
static SIGNALLED: AtomicBool = AtomicBool::new(false);

/// True once the app was told to stop by a signal. Under systemd's default KillMode the local server gets the same
/// SIGTERM and may exit before the shell has stopped it: that exit is then not a crash.
pub fn signalled() -> bool {
    SIGNALLED.load(Ordering::SeqCst)
}

#[cfg(unix)]
pub const SIGNALS: [libc::c_int; 3] = [libc::SIGTERM, libc::SIGINT, libc::SIGHUP];

/// Installs the handlers and a thread that runs `on_signal` with the first signal's number. The handler only sets
/// `SIGNALLED` and writes one byte to a pipe (both async-signal-safe); later signals change nothing.
#[cfg(unix)]
pub fn watch(on_signal: impl FnOnce(libc::c_int) + Send + 'static) -> std::io::Result<()> {
    use std::io;
    let mut fds = [0 as libc::c_int; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let (read_fd, write_fd) = (fds[0], fds[1]);
    unsafe {
        // Not inherited by the server or WebKit; the handler never blocks on a full pipe.
        libc::fcntl(read_fd, libc::F_SETFD, libc::FD_CLOEXEC);
        libc::fcntl(write_fd, libc::F_SETFD, libc::FD_CLOEXEC);
        let flags = libc::fcntl(write_fd, libc::F_GETFL);
        libc::fcntl(write_fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
    for sig in SIGNALS {
        // Safety: the action only does an atomic store and a write(2), both async-signal-safe.
        unsafe {
            signal_hook_registry::register(sig, move || {
                SIGNALLED.store(true, Ordering::SeqCst);
                let byte = sig as u8;
                libc::write(write_fd, &byte as *const u8 as *const libc::c_void, 1);
            })?;
        }
    }
    std::thread::Builder::new().name("signals".into()).spawn(move || {
        let mut byte = 0u8;
        loop {
            let n = unsafe { libc::read(read_fd, &mut byte as *mut u8 as *mut libc::c_void, 1) };
            if n == 1 {
                break;
            }
            if n < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return;
        }
        on_signal(libc::c_int::from(byte));
    })?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn sigterm_runs_the_shutdown_once_and_the_process_lives_on() {
        // The only test that installs handlers or raises signals.
        let (tx, rx) = mpsc::channel();
        watch(move |sig| tx.send(sig).unwrap()).unwrap();
        assert!(!signalled());
        unsafe { libc::raise(libc::SIGTERM) };
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), libc::SIGTERM);
        assert!(signalled());
        // A second signal does not kill the process either (the shutdown is already under way).
        unsafe { libc::raise(libc::SIGHUP) };
        unsafe { libc::raise(libc::SIGINT) };
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err(), "on_signal runs once");
    }
}
