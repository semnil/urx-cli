//! The environment the bundled Node starts with (K24): every inherited
//! `NODE_` entry removed, every other entry kept as it is.

use std::ffi::{OsStr, OsString};

/// Whether an environment name starts with `NODE_`: exactly on macOS, without
/// regard to case on Windows, whose environment names are case-insensitive.
pub fn is_node_name(name: &OsStr, case_insensitive: bool) -> bool {
    let Some(name) = name.to_str() else {
        // A name that is not Unicode cannot start with the ASCII prefix
        // unless its first five bytes are those; compare them as bytes.
        return node_prefix_bytes(name, case_insensitive);
    };
    let prefix = name.get(..5);
    match prefix {
        Some(prefix) if case_insensitive => prefix.eq_ignore_ascii_case("NODE_"),
        Some(prefix) => prefix == "NODE_",
        None => false,
    }
}

#[cfg(unix)]
fn node_prefix_bytes(name: &OsStr, case_insensitive: bool) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let bytes = name.as_bytes();
    bytes.len() >= 5
        && if case_insensitive {
            bytes[..5].eq_ignore_ascii_case(b"NODE_")
        } else {
            &bytes[..5] == b"NODE_"
        }
}

#[cfg(windows)]
fn node_prefix_bytes(name: &OsStr, case_insensitive: bool) -> bool {
    use std::os::windows::ffi::OsStrExt;
    let units: Vec<u16> = name.encode_wide().take(5).collect();
    units.len() == 5
        && units.iter().zip(b"NODE_").all(|(&unit, &expected)| {
            let unit = u8::try_from(unit).unwrap_or(0);
            if case_insensitive {
                unit.eq_ignore_ascii_case(&expected)
            } else {
                unit == expected
            }
        })
}

/// `entries` without the `NODE_` names, in their order. An empty value is
/// an entry like any other.
pub fn without_node(
    entries: impl IntoIterator<Item = (OsString, OsString)>,
    case_insensitive: bool,
) -> Vec<(OsString, OsString)> {
    entries
        .into_iter()
        .filter(|(name, _)| !is_node_name(name, case_insensitive))
        .collect()
}

/// Whether this platform compares environment names without regard to case.
pub const CASE_INSENSITIVE: bool = cfg!(windows);

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(names: &[&str]) -> Vec<(OsString, OsString)> {
        names
            .iter()
            .map(|name| (OsString::from(name), OsString::from("x")))
            .collect()
    }

    fn names(entries: &[(OsString, OsString)]) -> Vec<String> {
        entries
            .iter()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn the_prefix_is_removed_exactly_on_macos() {
        let kept = without_node(
            entries(&[
                "NODE_OPTIONS",
                "NODE_PATH",
                "NODE_",
                "PATH",
                "node_options",
                "NODEOPTIONS",
                "XNODE_A",
                "Node_x",
            ]),
            false,
        );
        assert_eq!(
            names(&kept),
            ["PATH", "node_options", "NODEOPTIONS", "XNODE_A", "Node_x"]
        );
    }

    #[test]
    fn the_prefix_is_removed_in_any_case_on_windows() {
        let kept = without_node(
            entries(&[
                "NODE_OPTIONS",
                "node_options",
                "Node_Path",
                "PATH",
                "NODEX",
                "Path",
            ]),
            true,
        );
        assert_eq!(names(&kept), ["PATH", "NODEX", "Path"]);
    }

    #[test]
    fn an_empty_value_is_still_present() {
        let kept = without_node(
            vec![(OsString::from("NODE_OPTIONS"), OsString::new())],
            false,
        );
        assert!(kept.is_empty());
    }
}
