import { createScanJobStore } from "../lib/scan-job-store.mjs";
import { withDeadline } from "../lib/ai.mjs";
import { cleanupMarketCache } from "../lib/ebay.mjs";
import { upcCacheStore } from "../lib/upc.mjs";

export const config = { schedule: "17 * * * *" };

export default async () => {
  await withDeadline(async () => {
    const store = createScanJobStore();
    // The store persists its sweep cursor, so later runs also reach old jobs
    // beyond the first page. Normal completion deletes photo bytes immediately.
    await store.cleanupExpiredJobs({ limit: 200 });
    await cleanupMarketCache();
    await cleanupMarketCache({ store: upcCacheStore() });
  }, { timeoutMs: 25000 });
  return new Response(null, { status: 204 });
};
