import {
  listPackagesWithInstalls,
  listUsers,
  listContradictedEvents,
  listRecentMerges,
  listIngestRunHealth,
  listProviderHealth,
  listReviewQueue,
} from "./actions";
import { PROVIDER_STALE_HOURS } from "@/data/admin/adminRepo";
import { AdminTabs } from "./AdminTabs";

export default async function AdminPage() {
  const [packages, users, contradictedEvents, recentMerges, ingestRuns, providerHealth, reviewQueue] =
    await Promise.all([
      listPackagesWithInstalls(),
      listUsers(),
      listContradictedEvents(),
      listRecentMerges(),
      // Supersedes the old listScanRuns() call: this returns the same ScanRun
      // rows plus each run's per-provider outcome, which is what the System
      // tab now renders. listScanRuns stays exported for anything else that
      // wants the bare list.
      listIngestRunHealth(),
      listProviderHealth(),
      listReviewQueue(),
    ]);

  return (
    <AdminTabs
      packages={packages}
      users={users}
      contradictedEvents={contradictedEvents}
      recentMerges={recentMerges}
      ingestRuns={ingestRuns}
      providerHealth={providerHealth}
      providerStaleHours={PROVIDER_STALE_HOURS}
      reviewQueue={reviewQueue}
    />
  );
}
