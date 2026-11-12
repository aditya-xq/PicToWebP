#![no_main]

use libfuzzer_sys::fuzz_target;

// Feed arbitrary bytes to the image decoder. The production CLI caps decoded
// dimensions before allocating, but the decoder itself is still the largest
// untrusted-input surface.
fuzz_target!(|data: &[u8]| {
    if data.len() > 64 * 1024 * 1024 {
        return;
    }
    let _ = image::load_from_memory(data);
});
