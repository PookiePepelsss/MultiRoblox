// Durable reads/writes for the JSON files in the app-data folder.
//
// Both halves of this exist because the previous behaviour could lose an
// entire accounts file without saying anything:
//
//   * Writes were std::fs::write, which truncates the target and then writes.
//     A crash, a power cut or a full disk mid-write leaves a truncated file.
//   * Reads did serde_json::from_str(..).unwrap_or_default(), so that
//     truncated file parsed as "no accounts" -- and the very next save wrote
//     that empty list back over the only copy.
//
// Now writes land via a temp file + rename (atomic on the same volume), and a
// file that exists but doesn't parse is copied aside and flagged, so callers
// can refuse to overwrite it.
use once_cell::sync::Lazy;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

static UNREADABLE: Lazy<Mutex<HashSet<PathBuf>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// File contents minus a leading UTF-8 BOM. serde rejects the BOM outright,
/// which would make a perfectly good file look corrupt -- and plenty of
/// Windows editors write one by default.
fn read_text(path: &Path) -> Option<String> {
    let s = std::fs::read_to_string(path).ok()?;
    Some(s.trim_start_matches('\u{feff}').to_string())
}

/// Keeps the unparseable bytes around under a sibling name so nothing the
/// user cares about is lost, and records the path so writes can be refused.
/// Only backs up once -- a second pass must not overwrite the first (good)
/// copy with a later, emptier one.
fn note_corrupt(path: &Path) {
    UNREADABLE.lock().unwrap().insert(path.to_path_buf());
    let backup = path.with_extension("corrupt-backup.json");
    if !backup.exists() {
        match std::fs::copy(path, &backup) {
            Ok(_) => eprintln!(
                "[storage] {} could not be parsed; original copied to {}",
                path.display(),
                backup.display()
            ),
            Err(e) => eprintln!("[storage] {} could not be parsed, and the backup failed: {}", path.display(), e),
        }
    }
}

/// True when this path exists but failed to parse during this run.
pub fn is_unreadable(path: &Path) -> bool {
    UNREADABLE.lock().unwrap().contains(path)
}

/// Missing file means "nothing saved yet" and reads as empty. A file that is
/// present but unparseable reads as empty *and* is flagged.
pub fn read_array(path: &Path) -> Vec<Value> {
    let Some(text) = read_text(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<Value>>(&text) {
        Ok(v) => {
            UNREADABLE.lock().unwrap().remove(path);
            v
        }
        Err(_) => {
            note_corrupt(path);
            Vec::new()
        }
    }
}

pub fn read_object(path: &Path) -> Map<String, Value> {
    let Some(text) = read_text(path) else {
        return Map::new();
    };
    match serde_json::from_str::<Map<String, Value>>(&text) {
        Ok(m) => {
            UNREADABLE.lock().unwrap().remove(path);
            m
        }
        Err(_) => {
            note_corrupt(path);
            Map::new()
        }
    }
}

/// Writes to a unique temp file, flushes it to disk, then renames over the
/// target. The reader therefore only ever sees a complete file: the old one
/// or the new one. sync_all before the rename matters -- without it the
/// rename can land while the contents are still only in the page cache.
///
/// The temp name carries a counter because two concurrent saves sharing one
/// temp path would interleave their bytes into it.
pub fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("tmp{}", TMP_SEQ.fetch_add(1, Ordering::Relaxed)));

    let written = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    // std::fs::rename replaces an existing destination on Windows
    // (MoveFileEx + MOVEFILE_REPLACE_EXISTING).
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One directory per call: cargo runs these in parallel, so a shared
    /// directory would let one test observe another's in-flight temp file.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("mr-jsonfile-tests")
            .join(format!("{}-{}", name, TMP_SEQ.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("data.json")
    }

    #[test]
    fn missing_file_reads_as_empty_and_is_not_flagged() {
        let p = scratch("missing");
        assert!(read_array(&p).is_empty());
        assert!(read_object(&p).is_empty());
        assert!(!is_unreadable(&p), "a file that was never created is not corrupt");
    }

    #[test]
    fn write_then_read_round_trips() {
        let p = scratch("roundtrip");
        write_atomic(&p, r#"[{"id":"a"},{"id":"b"}]"#).unwrap();
        let v = read_array(&p);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0]["id"], "a");
    }

    #[test]
    fn write_leaves_no_temp_files_behind() {
        let p = scratch("notemp");
        write_atomic(&p, "[]").unwrap();
        write_atomic(&p, r#"[{"id":"x"}]"#).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(p.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {:?}", leftovers);
    }

    #[test]
    fn overwrite_replaces_contents_completely() {
        let p = scratch("overwrite");
        write_atomic(&p, r#"[{"id":"first"},{"id":"second"}]"#).unwrap();
        write_atomic(&p, r#"[{"id":"only"}]"#).unwrap();
        let v = read_array(&p);
        assert_eq!(v.len(), 1, "a shorter write must not leave a tail of the old file");
        assert_eq!(v[0]["id"], "only");
    }

    #[test]
    fn utf8_bom_is_tolerated() {
        let p = scratch("bom");
        std::fs::write(&p, "\u{feff}[{\"id\":\"a\"}]").unwrap();
        assert_eq!(read_array(&p).len(), 1, "a BOM must not make a good file look corrupt");
        assert!(!is_unreadable(&p));
    }

    #[test]
    fn truncated_file_is_flagged_and_backed_up() {
        let p = scratch("truncated");
        // Exactly what a crash mid-write used to leave behind.
        std::fs::write(&p, r#"[{"id":"a"},{"id":"#).unwrap();
        assert!(read_array(&p).is_empty());
        assert!(is_unreadable(&p), "corrupt file must be flagged so writes can be refused");
        let backup = p.with_extension("corrupt-backup.json");
        assert!(backup.exists(), "original bytes must be preserved");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), r#"[{"id":"a"},{"id":"#);
    }

    #[test]
    fn backup_is_not_overwritten_by_a_later_read() {
        let p = scratch("backup-once");
        std::fs::write(&p, "{ truncated").unwrap();
        read_array(&p);
        std::fs::write(&p, "different garbage").unwrap();
        read_array(&p);
        let backup = p.with_extension("corrupt-backup.json");
        assert_eq!(
            std::fs::read_to_string(&backup).unwrap(),
            "{ truncated",
            "the first (closest to intact) copy must survive"
        );
    }

    #[test]
    fn a_good_read_clears_the_flag() {
        let p = scratch("recover");
        std::fs::write(&p, "not json").unwrap();
        read_array(&p);
        assert!(is_unreadable(&p));
        write_atomic(&p, "[]").unwrap();
        read_array(&p);
        assert!(!is_unreadable(&p), "fixing the file must unblock saving");
    }

    #[test]
    fn object_read_handles_corruption_the_same_way() {
        let p = scratch("obj");
        std::fs::write(&p, "{\"a\":1,").unwrap();
        assert!(read_object(&p).is_empty());
        assert!(is_unreadable(&p));
        assert!(p.with_extension("corrupt-backup.json").exists());
    }
}
