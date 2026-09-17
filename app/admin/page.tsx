import {
  listPackagesWithInstalls,
  listUsers,
  listIngestRunHealth,
  listProviderHealth,
  getLastScheduledRun,
  listReviewQueue,
} from "./actions";
import { PROVIDER_STALE_HOURS, SCHEDULED_RUN_STALE_HOURS } from "@/data/admin/adminRepo";
import { AdminTabs } from "./AdminTabs";

export default async function AdminPage() {
  const [packages, users, ingestRuns, providerHealth, lastScheduledRun, reviewQueue] = await Promise.all([
    listPackagesWithInstalls(),
    listUsers(),
    // Supersedes the old listScanRuns() call: this returns the same ScanRun
    // rows plus each run's per-provider outcome, which is what the System
    // tab now renders. listScanRuns stays exported for anything else that
    // wants the bare list.
    listIngestRunHealth(),
    listProviderHealth(),
    getLastScheduledRun(),
    listReviewQueue(),
  ]);

  return (
    <AdminTabs
      packages={packages}
      users={users}
      ingestRuns={ingestRuns}
      providerHealth={providerHealth}
      providerStaleHours={PROVIDER_STALE_HOURS}
      lastScheduledRun={lastScheduledRun}
      scheduledRunStaleHours={SCHEDULED_RUN_STALE_HOURS}
      reviewQueue={reviewQueue}
    />
  );
}
