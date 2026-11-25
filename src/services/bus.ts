import { EventEmitter } from 'node:events';

export interface RunSignal {
  runId: string;
  type: 'case' | 'defect' | 'run';
  id?: string;
  at: string;
}

/** In-process fan-out for SSE. One Railway instance is enough for this app. */
const emitter = new EventEmitter();
emitter.setMaxListeners(1000);

export function publish(runId: string, type: RunSignal['type'], id?: string): void {
  emitter.emit(`run:${runId}`, { runId, type, id, at: new Date().toISOString() } satisfies RunSignal);
}

export function subscribe(runId: string, fn: (s: RunSignal) => void): () => void {
  emitter.on(`run:${runId}`, fn);
  return () => emitter.off(`run:${runId}`, fn);
}
