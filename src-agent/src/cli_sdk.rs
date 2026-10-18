//! Strict, isolated CLI surface for the SDK stdio adapter.
//!
//! Only an immediate `sdk` after argv[0] selects this parser. In particular,
//! legacy commands keep their existing permissive flag/help handling.

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SdkCli {
    Serve,
    Help,
    Usage(String),
}

pub(crate) const HELP: &str = "koma sdk — SDK stdio adapter

usage:
  koma sdk serve
  koma sdk --help | -h
  koma sdk help
  koma sdk serve --help | -h

serve accepts no flags or positional arguments.
The adapter uses stdin/stdout for its protocol; diagnostics go to stderr.
Select the koma executable path in your SDK client, not with a serve flag.";

/// Parse the complete argv, returning `None` for non-SDK invocations.
/// Help is only accepted in the exact forms advertised above: a stray help
/// flag must not hide an invalid SDK command or unsupported serve option.
pub(crate) fn parse(args: impl IntoIterator<Item = String>) -> Option<SdkCli> {
    let mut args = args.into_iter();
    args.next(); // argv[0], which may itself be named `sdk`.
    if args.next().as_deref() != Some("sdk") {
        return None;
    }
    let tail: Vec<String> = args.collect();
    let tokens: Vec<&str> = tail.iter().map(String::as_str).collect();
    Some(match tokens.as_slice() {
        ["serve"] => SdkCli::Serve,
        ["--help" | "-h" | "help"] | ["serve", "--help" | "-h"] => SdkCli::Help,
        [] => SdkCli::Usage("missing SDK command; expected `serve`".into()),
        ["serve", ..] => SdkCli::Usage("`koma sdk serve` accepts no flags or arguments".into()),
        _ => SdkCli::Usage("unknown SDK command or unsupported arguments".into()),
    })
}

/// Requested help goes to stdout; invalid invocations go entirely to stderr so
/// they cannot be mistaken for protocol output by an SDK client.
pub(crate) fn print_help() -> i32 {
    println!("{HELP}");
    0
}

pub(crate) fn print_usage(error: &str) -> i32 {
    eprintln!("error: {error}\n\n{HELP}");
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sdk(args: &[&str]) -> Option<SdkCli> {
        parse(args.iter().copied().map(String::from))
    }

    #[test]
    fn serve_requires_exact_command() {
        assert_eq!(sdk(&["/path/to/koma", "sdk", "serve"]), Some(SdkCli::Serve));
        for tail in [
            vec![],
            vec!["unknown"],
            vec!["serve", "extra"],
            vec!["serve", "--session", "id"],
            vec!["serve", "--workdir", "/tmp"],
            vec!["serve", "--executable", "/path/to/koma"],
            vec!["serve", "--version"],
            vec!["serve", "--"],
            vec!["serve", "--unknown", "--help"],
            vec!["unknown", "--help"],
            vec!["--help", "serve"],
            vec!["help", "extra"],
        ] {
            let args: Vec<_> = ["koma", "sdk"].into_iter().chain(tail).collect();
            assert!(matches!(sdk(&args), Some(SdkCli::Usage(_))), "{args:?}");
        }
    }

    #[test]
    fn dedicated_help_forms() {
        for tail in [
            vec!["--help"],
            vec!["-h"],
            vec!["help"],
            vec!["serve", "--help"],
            vec!["serve", "-h"],
        ] {
            let args: Vec<_> = ["koma", "sdk"].into_iter().chain(tail).collect();
            assert_eq!(sdk(&args), Some(SdkCli::Help), "{args:?}");
        }
    }

    #[test]
    fn non_sdk_routing_is_untouched() {
        for args in [
            vec![],
            vec!["sdk"],
            vec!["koma"],
            vec!["koma", "--help"],
            vec!["koma", "legacy", "sdk", "serve"],
            vec!["koma", "run", "--prompt", "sdk"],
            vec!["koma", "--session", "sdk"],
        ] {
            assert_eq!(sdk(&args), None, "{args:?}");
        }
    }

    #[test]
    fn help_documents_flagless_serve_and_client_executable_selection() {
        assert!(HELP.contains("koma sdk serve"));
        assert!(HELP.contains("serve accepts no flags or positional arguments"));
        assert!(HELP.contains("executable path in your SDK client"));
        assert!(!HELP.contains("--session"));
    }
}
