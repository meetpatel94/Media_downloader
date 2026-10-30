/**
 * Small in-process semaphore so a single server instance cannot spawn an
 * unbounded number of downloads/conversions at once.
 */

import { getConfig } from "@/lib/config";
import { DownloadError } from "@/lib/errors";

let active = 0;
let waiting: Array<() => void> = [];

export type Slot = { release: () => void };

export async function acquireSlot(signal?: AbortSignal): Promise<Slot> {
  const config = getConfig();

  if (active < config.maxConcurrentJobs) {
    active += 1;
    return makeSlot();
  }

  if (waiting.length >= config.maxQueuedJobs) {
    throw new DownloadError("SERVER_BUSY", "The server is busy right now. Please try again in a moment.");
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      waiting = waiting.filter((entry) => entry !== grant);
      reject(new DownloadError("CANCELLED", "The download was cancelled."));
    };

    const grant = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    waiting.push(grant);
  });

  active += 1;
  return makeSlot();
}

function makeSlot(): Slot {
  let released = false;

  return {
    release: () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      const next = waiting.shift();
      if (next) next();
    },
  };
}

export function getConcurrencySnapshot(): { active: number; waiting: number } {
  return { active, waiting: waiting.length };
}
