//! A stand-in for the bundled Node in the launcher's tests: it prints each
//! argument on its own line, then the names of any `NODE_` variables it was
//! given and whether `KEPT` arrived. With `ready=<path>` it creates that file
//! once it runs; with `release=<path>` it waits until that file exists; it
//! sleeps for `sleep=<ms>`, creates `done=<path>` and exits
//! with `exit=<code>`, all read from its arguments.

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    for argument in &arguments {
        println!("arg:{argument}");
    }
    for (name, _) in std::env::vars_os() {
        let name = name.to_string_lossy();
        if name.to_ascii_uppercase().starts_with("NODE_") {
            println!("node:{name}");
        }
    }
    println!("kept:{}", std::env::var("KEPT").unwrap_or_default());
    let value = |key: &str| {
        arguments
            .iter()
            .find_map(|argument| argument.strip_prefix(&format!("{key}=")))
            .and_then(|value| value.parse::<u64>().ok())
    };
    let path = |key: &str| {
        arguments
            .iter()
            .find_map(|argument| argument.strip_prefix(&format!("{key}=")).map(str::to_owned))
    };
    if let Some(ready) = path("ready") {
        std::fs::write(ready, b"").unwrap();
    }
    if let Some(release) = path("release") {
        let started = std::time::Instant::now();
        while !std::path::Path::new(&release).exists()
            && started.elapsed() < std::time::Duration::from_secs(30)
        {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    if let Some(ms) = value("sleep") {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
    if let Some(done) = path("done") {
        std::fs::write(done, b"").unwrap();
    }
    std::process::exit(value("exit").unwrap_or(0) as i32);
}
