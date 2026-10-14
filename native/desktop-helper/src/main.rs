//! Small process supervisor. Native backends own the versioned JSON-RPC stream.
//! Stdin is forwarded through a private pipe so supervisor termination closes the
//! backend's input and releases held keys. No command comes from model input.
use std::io;
#[cfg(not(target_os = "macos"))]
use std::io::Write;
use std::process::{Command, Stdio};

#[cfg(target_os = "macos")]
fn macos(root: &std::path::Path) -> io::Result<()> {
    use std::net::Shutdown;
    use std::os::unix::fs::DirBuilderExt;
    use std::os::unix::net::UnixListener;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    // Launch Services gives the application its own TCC identity. A direct
    // child process would inherit the terminal/IDE's responsible application.
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let directory = std::path::PathBuf::from(format!("/private/tmp/pulse-desktop-{}-{}", std::process::id(), nonce));
    std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup { fn drop(&mut self) { std::fs::remove_dir_all(&self.0).ok(); } }
    let _cleanup = Cleanup(directory.clone());
    let socket = directory.join("rpc.sock");
    let listener = UnixListener::bind(&socket)?;
    listener.set_nonblocking(true)?;
    let mut launcher = Command::new("/usr/bin/open")
        .args(["-n", "-g", "-W", "-a"])
        .arg(root.join("Pulse Desktop Helper.app"))
        .arg("--args").arg("--socket").arg(&socket)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn()?;
    let start = Instant::now();
    let stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if launcher.try_wait()?.is_some() || start.elapsed() > Duration::from_secs(20) {
                    launcher.kill().ok();
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "Desktop application did not connect"));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(error),
        }
    };
    stream.set_nonblocking(false)?;
    // No listening endpoint remains after the one private connection is made.
    drop(listener);
    std::fs::remove_file(&socket).ok();
    let mut input = stream.try_clone()?;
    let reader = std::thread::spawn(move || io::copy(&mut &stream, &mut io::stdout().lock()));
    let copied = io::copy(&mut io::stdin().lock(), &mut input);
    input.shutdown(Shutdown::Write).ok();
    if copied.is_err() { input.shutdown(Shutdown::Both).ok(); }
    reader.join().map_err(|_| io::Error::other("Desktop stream failed"))??;
    launcher.wait()?;
    copied.map(|_| ())
}

fn main() -> io::Result<()> {
    let root = std::env::current_exe()?.parent().unwrap().to_owned();
    #[cfg(target_os = "macos")]
    { return macos(&root); }
    #[cfg(not(target_os = "macos"))]
    {
    let mut command;
    if cfg!(target_os = "windows") {
        command = Command::new("powershell.exe");
        command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
        command.arg(root.join("windows.ps1"));
    } else if cfg!(target_os = "linux") {
        command = Command::new("python3");
        command.arg(root.join("linux.py"));
    } else {
        return Err(io::Error::new(io::ErrorKind::Unsupported, "Unsupported desktop platform"));
    }
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).spawn()?;
    let mut input = child.stdin.take().unwrap();
    let copied = io::copy(&mut io::stdin().lock(), &mut input);
    input.flush().ok();
    drop(input);
    if copied.is_err() { child.kill().ok(); }
    let status = child.wait()?;
    if !status.success() { std::process::exit(status.code().unwrap_or(1)); }
    Ok(())
    }
}
