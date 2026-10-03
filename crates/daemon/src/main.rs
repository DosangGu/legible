use std::{env, process::ExitCode};

const HELP: &str = "legible-daemon: Rust migration scaffold

Usage: legible-daemon --help | --version

HTTP serving and daemon lifecycle are not implemented in this binary yet.
Run the current application with npm run legible.";

fn main() -> ExitCode {
    let args: Vec<_> = env::args_os().skip(1).collect();
    match args.as_slice() {
        [argument] if argument == "--version" || argument == "-V" => {
            println!("legible-daemon {}", legible_daemon::VERSION);
            ExitCode::SUCCESS
        }
        [argument] if argument == "--help" || argument == "-h" => {
            println!("{HELP}");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{HELP}");
            ExitCode::from(2)
        }
    }
}
