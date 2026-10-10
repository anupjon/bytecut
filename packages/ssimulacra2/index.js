import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";

const WASM_URL = new URL("./ssimulacra2.wasm", import.meta.url);
const WORKER_URL = new URL("./worker.js", import.meta.url);

/** The smallest side SSIMULACRA2 accepts: its multi-scale pyramid needs real content. */
export const MIN_SIDE = 8;

let compiled;
/** Compiles the module once per process; a worker compiles its own. */
export function compile() {
  compiled ??= readFile(WASM_URL).then((bytes) => WebAssembly.compile(bytes));
  return compiled;
}

/**
 * The module imports a few wasm-bindgen hooks because a dependency of the Rust crate
 * links its runtime. None is reachable from the exported functions; if one ever were,
 * failing loudly beats returning a wrong score.
 */
function imports(module) {
  const unreachable = (name) => () => {
    throw new Error(`ssimulacra2.wasm called an unexpected import: ${name}`);
  };
  const result = {};
  for (const { module: ns, name, kind } of WebAssembly.Module.imports(module)) {
    if (kind !== "function") throw new Error(`unsupported import ${ns}.${name} (${kind})`);
    (result[ns] ??= {})[name] = unreachable(`${ns}.${name}`);
  }
  return result;
}

function check(label, image) {
  const { data, width, height } = image ?? {};
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) {
    throw new TypeError(`${label}.data must be a Uint8Array of packed RGB`);
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`${label}: width and height must be positive integers`);
  }
  if (data.length !== width * height * 3) {
    throw new RangeError(
      `${label}: expected ${width * height * 3} bytes (${width}x${height} RGB), got ${data.length}`,
    );
  }
}

/**
 * Instantiates a scorer in the current thread.
 * @param {WebAssembly.Module} [module] a compiled module, to share one compile between instances
 */
export async function loadScorer(module) {
  const instance = await WebAssembly.instantiate(
    module ?? (await compile()),
    imports(module ?? (await compile())),
  );
  const { alloc, dealloc, score: rawScore, memory } = instance.exports;

  return {
    /** SSIMULACRA2 of `distorted` against `reference`: 100 is identical, lower is worse. */
    score(reference, distorted) {
      check("reference", reference);
      check("distorted", distorted);
      if (reference.width !== distorted.width || reference.height !== distorted.height) {
        throw new RangeError(
          `images differ in size: ${reference.width}x${reference.height} vs ${distorted.width}x${distorted.height}`,
        );
      }
      if (reference.width < MIN_SIDE || reference.height < MIN_SIDE) {
        throw new RangeError(`images must be at least ${MIN_SIDE}x${MIN_SIDE}`);
      }
      const length = reference.data.length;
      const a = alloc(length);
      const b = alloc(length);
      try {
        // Memory may grow during alloc, so the view is taken after both allocations.
        const bytes = new Uint8Array(memory.buffer);
        bytes.set(reference.data, a);
        bytes.set(distorted.data, b);
        const result = rawScore(a, b, reference.width, reference.height);
        if (Number.isNaN(result)) throw new Error("ssimulacra2 could not score these images");
        return result;
      } finally {
        dealloc(a, length);
        dealloc(b, length);
      }
    },
  };
}

/**
 * A pool of worker threads, each with its own instance, so scoring never blocks the caller.
 * Inputs are copied to the worker (structured clone).
 * @param {{ size?: number }} [options]
 */
export function createPool(options = {}) {
  const size = Math.max(1, options.size ?? 2);
  const workers = [];
  const waiting = [];
  let nextId = 1;
  let closed = false;

  const pending = new Map();
  const idle = [];

  function dispatch() {
    while (idle.length > 0 && waiting.length > 0) {
      const worker = idle.pop();
      const job = waiting.shift();
      pending.set(job.id, { ...job, worker });
      worker.postMessage({ id: job.id, reference: job.reference, distorted: job.distorted });
    }
  }

  const ready = Promise.all(
    Array.from({ length: size }, async () => {
      // A worker inherits the parent's execArgv; flags such as --input-type only make sense
      // for the parent's own entry point, so start it clean.
      const worker = new Worker(WORKER_URL, { execArgv: [] });
      workers.push(worker);
      await new Promise((resolve, reject) => {
        const onFirst = (message) => {
          if (message?.ready) {
            worker.off("error", reject);
            resolve();
          }
        };
        worker.once("error", reject);
        worker.on("message", onFirst);
      });
      worker.on("message", (message) => {
        if (message?.ready) return;
        const job = pending.get(message.id);
        if (!job) return;
        pending.delete(message.id);
        idle.push(job.worker);
        if (message.error) job.reject(new Error(message.error));
        else job.resolve(message.score);
        dispatch();
      });
      worker.on("error", (error) => {
        for (const [id, job] of pending) {
          if (job.worker === worker) {
            pending.delete(id);
            job.reject(error);
          }
        }
      });
      idle.push(worker);
    }),
  );

  return {
    size,
    /** @returns {Promise<number>} */
    async score(reference, distorted) {
      if (closed) throw new Error("the pool is closed");
      check("reference", reference);
      check("distorted", distorted);
      await ready;
      return new Promise((resolve, reject) => {
        waiting.push({ id: nextId++, reference, distorted, resolve, reject });
        dispatch();
      });
    },
    async close() {
      closed = true;
      await Promise.allSettled(workers.map((w) => w.terminate()));
    },
  };
}
