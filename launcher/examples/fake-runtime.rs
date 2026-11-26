//! A stand-in for the bundled Node in the launcher's tests: it prints each
//! argument on its own line, then the names of any `NODE_` variables it was
//! given and whether `KEPT` arrived, sleeps for `sleep=<ms>` and exits with
//! `exit=<code>`, both read from its arguments.

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
    if let Some(ms) = value("sleep") {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
    std::process::exit(value("exit").unwrap_or(0) as i32);
}
