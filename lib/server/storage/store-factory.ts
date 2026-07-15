import { getClaimGraphStorageDriver } from "@/lib/server/storage/config";
import type { ClaimGraphStore } from "@/lib/server/storage/claimgraph-store";

let localStorePromise: Promise<ClaimGraphStore> | null = null;
let hostedStorePromise: Promise<ClaimGraphStore> | null = null;

export async function getClaimGraphStore(): Promise<ClaimGraphStore> {
  const driver = getClaimGraphStorageDriver();

  if (driver === "hosted") {
    hostedStorePromise ??= import("@/lib/server/storage/hosted-store").then(
      (module) => module.hostedClaimGraphStore
    );
    return hostedStorePromise;
  }

  localStorePromise ??= import("@/lib/server/storage/local-store").then(
    (module) => module.localClaimGraphStore
  );
  return localStorePromise;
}

export function isHostedClaimGraphStoreSelected() {
  return getClaimGraphStorageDriver() === "hosted";
}
