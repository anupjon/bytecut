#!/usr/bin/env bash
# Rebuilds ssimulacra2.wasm from rust/. Needs Rust with the wasm32-unknown-unknown target:
#   rustup target add wasm32-unknown-unknown
# The built file is committed, so installing or testing bytecut never needs Rust.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --release --locked --target wasm32-unknown-unknown --manifest-path rust/Cargo.toml
cp rust/target/wasm32-unknown-unknown/release/bytecut_ssimulacra2.wasm ssimulacra2.wasm
sha256sum ssimulacra2.wasm
