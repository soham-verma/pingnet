//! Decode a byte stream into UTF-8 text chunk by chunk without splitting
//! multi-byte characters across reads (which String::from_utf8_lossy on each
//! raw chunk does, producing U+FFFD in terminals for box-drawing, emoji, …).

/// Return all complete text in `buf`, leaving an incomplete trailing
/// sequence (≤3 bytes) in `buf` for the next read. Genuinely invalid bytes
/// are replaced with U+FFFD.
pub fn take_utf8(buf: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(buf) {
            Ok(s) => {
                out.push_str(s);
                buf.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                // SAFETY-free: from_utf8 guarantees buf[..valid] is valid UTF-8
                out.push_str(std::str::from_utf8(&buf[..valid]).unwrap_or_default());
                match e.error_len() {
                    None => {
                        // Incomplete sequence at the end — keep it for next time
                        buf.drain(..valid);
                        return out;
                    }
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        buf.drain(..valid + bad);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::take_utf8;

    #[test]
    fn split_multibyte_is_joined_across_reads() {
        let s = "a─b😀c".as_bytes();
        let mut buf = Vec::new();
        let mut out = String::new();
        for chunk in s.chunks(2) {
            buf.extend_from_slice(chunk);
            out.push_str(&take_utf8(&mut buf));
        }
        assert_eq!(out, "a─b😀c");
        assert!(buf.is_empty());
    }

    #[test]
    fn invalid_bytes_become_replacement_chars() {
        let mut buf = vec![b'x', 0xff, b'y'];
        assert_eq!(take_utf8(&mut buf), "x\u{FFFD}y");
        assert!(buf.is_empty());
    }

    #[test]
    fn incomplete_tail_is_retained() {
        let mut buf = "ok".as_bytes().to_vec();
        buf.extend_from_slice(&"😀".as_bytes()[..2]);
        assert_eq!(take_utf8(&mut buf), "ok");
        assert_eq!(buf.len(), 2);
    }
}
