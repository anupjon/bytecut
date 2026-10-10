//! A tiny C-ABI wrapper over rust-av/ssimulacra2 (BSD-2-Clause) for use from JavaScript.
//!
//! Images cross the boundary as tightly packed 8-bit sRGB (3 bytes per pixel). The caller
//! allocates inside this module's memory with `alloc`, writes the pixels, calls `score`, and
//! releases with `dealloc`.

use ssimulacra2::{compute_frame_ssimulacra2, ColorPrimaries, Rgb, TransferCharacteristic};

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// # Safety
/// `pointer` and `len` must come from a previous `alloc(len)` and be released once.
#[no_mangle]
pub unsafe extern "C" fn dealloc(pointer: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(pointer, 0, len));
}

fn to_rgb(bytes: &[u8], width: usize, height: usize) -> Option<Rgb> {
    let pixels: Vec<[f32; 3]> = bytes
        .chunks_exact(3)
        .map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0])
        .collect();
    Rgb::new(
        pixels,
        width,
        height,
        TransferCharacteristic::SRGB,
        ColorPrimaries::BT709,
    )
    .ok()
}

/// The SSIMULACRA2 score of `distorted` against `reference` (100 is identical; it can go
/// negative). NaN when the inputs are unusable, e.g. smaller than 8 x 8.
///
/// # Safety
/// Both pointers must address `width * height * 3` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn score(
    reference: *const u8,
    distorted: *const u8,
    width: u32,
    height: u32,
) -> f64 {
    let (w, h) = (width as usize, height as usize);
    let length = w * h * 3;
    let a = std::slice::from_raw_parts(reference, length);
    let b = std::slice::from_raw_parts(distorted, length);
    match (to_rgb(a, w, h), to_rgb(b, w, h)) {
        (Some(a), Some(b)) => compute_frame_ssimulacra2(a, b).unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}
