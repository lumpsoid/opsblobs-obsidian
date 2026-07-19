// ─────────────────────────────────────────────
//  Hybrid Logical Clock (HLC)
//  Phase 1.1
// ─────────────────────────────────────────────
//
//  Guarantees:
//    - Monotonically increasing per device
//    - Captures causal ordering across devices
//    - Total ordering: wallTime → counter → deviceId
//    - Handles clock drift by taking max(wall, remote.wall)

import { HLC } from '../types';

export class HybridLogicalClock {
  private current: HLC;

  constructor(
    deviceId: string,
    initial?: HLC,
    private wallClock: () => number = () => Date.now(),
  ) {
    this.current = initial ?? { wallTime: 0, counter: 0, deviceId };
  }

  /**
   * Generate a new HLC timestamp for a local event.
   * Increments counter if wall clock hasn't advanced.
   */
  now(): HLC {
    const wall = this.wallClock();
    if (wall > this.current.wallTime) {
      this.current = { wallTime: wall, counter: 0, deviceId: this.current.deviceId };
    } else {
      this.current = {
        wallTime: this.current.wallTime,
        counter: this.current.counter + 1,
        deviceId: this.current.deviceId,
      };
    }
    return { ...this.current };
  }

  /**
   * Merge a remote HLC into the local clock on receiving a remote event.
   * Advances the local clock past the remote's timestamp.
   */
  merge(remote: HLC): HLC {
    const wall = this.wallClock();
    const maxWall = Math.max(wall, this.current.wallTime, remote.wallTime);

    let counter: number;
    if (maxWall === this.current.wallTime && maxWall === remote.wallTime) {
      counter = Math.max(this.current.counter, remote.counter) + 1;
    } else if (maxWall === this.current.wallTime) {
      counter = this.current.counter + 1;
    } else if (maxWall === remote.wallTime) {
      counter = remote.counter + 1;
    } else {
      counter = 0;
    }

    this.current = { wallTime: maxWall, counter, deviceId: this.current.deviceId };
    return { ...this.current };
  }

  getCurrent(): HLC {
    return { ...this.current };
  }

  /**
   * Fast-forward the clock to at least `hlc`'s wall/counter, keeping OUR own
   * deviceId. Used after a merge to advance past the merged HLC so a freshly
   * minted op (e.g. a user-resolved conflict) dominates the remote it supersedes.
   * The passed HLC may be a *remote* one — adopting its deviceId would make our
   * future `now()` timestamps claim a foreign author and corrupt the tie-break
   * (exactly the divergence seen when two devices rename at the same wall/counter),
   * so we preserve `this.current.deviceId`, mirroring `now()` and `merge()`.
   */
  setCurrent(hlc: HLC): void {
    this.current = { wallTime: hlc.wallTime, counter: hlc.counter, deviceId: this.current.deviceId };
  }
}

/**
 * Total ordering of two HLC timestamps.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function hlcCompare(a: HLC, b: HLC): number {
  if (a.wallTime !== b.wallTime) return a.wallTime - b.wallTime;
  if (a.counter !== b.counter) return a.counter - b.counter;
  if (a.deviceId < b.deviceId) return -1;
  if (a.deviceId > b.deviceId) return 1;
  return 0;
}

/** Returns the later of two HLC timestamps. */
export function hlcMax(a: HLC, b: HLC): HLC {
  return hlcCompare(a, b) >= 0 ? a : b;
}

/** Serialize HLC to a sortable string: "wallTime-counter-deviceId" */
export function hlcToString(hlc: HLC): string {
  return `${hlc.wallTime.toString().padStart(15, '0')}-${hlc.counter
    .toString()
    .padStart(8, '0')}-${hlc.deviceId}`;
}

/** Deserialize HLC from string */
export function hlcFromString(s: string): HLC {
  const parts = s.split('-');
  if (parts.length < 3) throw new Error(`Invalid HLC string: ${s}`);
  // deviceId may contain hyphens; everything from index 2 onward is the deviceId
  const wallTime = parseInt(parts[0]!, 10);
  const counter = parseInt(parts[1]!, 10);
  if (!Number.isInteger(wallTime) || !Number.isInteger(counter)) {
    throw new Error(`Invalid HLC string: ${s}`);
  }
  return {
    wallTime,
    counter,
    deviceId: parts.slice(2).join('-'),
  };
}

/** Check whether two HLCs represent the same logical time */
export function hlcEqual(a: HLC, b: HLC): boolean {
  return a.wallTime === b.wallTime && a.counter === b.counter && a.deviceId === b.deviceId;
}
