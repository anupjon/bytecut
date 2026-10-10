import { parentPort } from "node:worker_threads";
import { loadScorer } from "./index.js";

const scorer = await loadScorer();
parentPort.postMessage({ ready: true });
parentPort.on("message", ({ id, reference, distorted }) => {
  try {
    parentPort.postMessage({ id, score: scorer.score(reference, distorted) });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
