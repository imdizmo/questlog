// Runs in a worker thread: loads one direction of the language pack, then serves translate requests.
// Plain JS so it can be copied beside the server bundle.
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const { dir, from, to } = workerData;
const mod = await import(pathToFileURL(join(dir, 'engine.mjs')).href);
await mod.load(dir, from, to);
parentPort.postMessage({ ready: true });
parentPort.on('message', async ({ id, texts, from, to }) => {
  try {
    parentPort.postMessage({ id, out: await mod.translate(texts, from, to) });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e?.message ?? e) });
  }
});
