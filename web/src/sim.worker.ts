// The balance simulator's worker: batches of scenario runs off the page's thread (see simHost.ts).
import { createSimHost, type FromSim, type ToSim } from './simHost';

const scope = self as unknown as { postMessage(m: FromSim): void; onmessage: ((e: MessageEvent<ToSim>) => void) | null };
// A MessageChannel turn lets cancel messages in between slices without setTimeout's clamp.
const channel = new MessageChannel();
const queue: (() => void)[] = [];
channel.port1.onmessage = () => { queue.shift()?.(); };
const later = (f: () => void) => { queue.push(f); channel.port2.postMessage(0); };

const handle = createSimHost((m: FromSim) => scope.postMessage(m), later, () => performance.now());
scope.onmessage = (e: MessageEvent<ToSim>) => handle(e.data);
