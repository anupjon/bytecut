# @bytecut/ssimulacra2

The [SSIMULACRA 2](https://github.com/cloudinary/ssimulacra2) image quality metric as WebAssembly
for Node.js 22+. No native dependency and no install script.

```js
import { loadScorer, createPool } from "@bytecut/ssimulacra2";

const scorer = await loadScorer();
// Packed 8-bit sRGB, 3 bytes per pixel. 100 is identical; higher is better.
const score = scorer.score(
  { data: referenceRgb, width, height },
  { data: encodedRgb, width, height },
);

// Or off the main thread:
const pool = createPool({ size: 4 });
await pool.score(reference, distorted);
await pool.close();
```

Rough guide: 90+ is visually indistinguishable, 70+ is high quality, 50 is medium.

`ssimulacra2.wasm` is committed; rebuild it with `pnpm build:wasm` (needs Rust with the
`wasm32-unknown-unknown` target). The crate is pinned in `rust/Cargo.lock`. See `NOTICE` for
what is compiled in and under which licences.
