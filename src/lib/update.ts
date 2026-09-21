import { channelOf, isUpdateFor, type Channel } from "./version.ts";

/**
 * The app's half of the update system.
 *
 * A build only ever knows one update endpoint — the workflow compiles it in
 * from the branch that produced the build — so a stable install is physically
 * unable to fetch the beta manifest, and vice versa. The channel check here is
 * the second lock on the same door: whatever a manifest claims, an update is
 * only offered when it belongs to the channel the running build was installed
 * from.
 */

export type { Channel };

export function channelLabel(version: string): string {
  return channelOf(version) === "testing" ? "beta" : "stable";
}

export interface ServedUpdate {
  version: string;
  body?: string | null;
  date?: string | null;
  downloadAndInstall: (
    onEvent?: (event: {
      event: string;
      data: { contentLength?: number; chunkLength?: number };
    }) => void,
  ) => Promise<void>;
}

export interface UpdateIo {
  getVersion: () => Promise<string>;
  check: () => Promise<ServedUpdate | null>;
  relaunch: () => Promise<void>;
}

export interface AvailableUpdate {
  version: string;
  notes: string | null;
  date: string | null;
  install: (onProgress?: (fraction: number | null) => void) => Promise<void>;
}

/** Pure gate: refuse a served manifest from the other channel. */
export function selectUpdate(
  current: string,
  served: { version: string } | null,
): { version: string } | null {
  if (!served) return null;
  if (!isUpdateFor(current, served.version)) return null;
  return served;
}

export async function checkForUpdateWith(io: UpdateIo): Promise<AvailableUpdate | null> {
  const current = await io.getVersion();
  const update = await io.check();
  if (!selectUpdate(current, update)) return null;
  const served = update as ServedUpdate;

  return {
    version: served.version,
    notes: served.body ?? null,
    date: served.date ?? null,
    install: async (onProgress) => {
      let total = 0;
      let received = 0;
      await served.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          onProgress?.(total > 0 ? 0 : null);
        } else if (event.event === "Progress") {
          received += event.data.chunkLength ?? 0;
          onProgress?.(total > 0 ? Math.min(1, received / total) : null);
        } else if (event.event === "Finished") {
          onProgress?.(1);
        }
      });
      await io.relaunch();
    },
  };
}

const liveIo: UpdateIo = {
  getVersion: async () => {
    const { getVersion } = await import("@tauri-apps/api/app");
    return getVersion();
  },
  check: async () => {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check({ timeout: 30_000 });
    if (!update) return null;
    return {
      version: update.version,
      body: update.body,
      date: update.date,
      downloadAndInstall: (onEvent) =>
        update.downloadAndInstall((event) => {
          onEvent?.({
            event: event.event,
            data: {
              contentLength:
                event.event === "Started" ? event.data.contentLength : undefined,
              chunkLength:
                event.event === "Progress" ? event.data.chunkLength : undefined,
            },
          });
        }),
    };
  },
  relaunch: async () => {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },
};

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  return checkForUpdateWith(liveIo);
}
