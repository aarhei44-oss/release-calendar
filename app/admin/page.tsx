import { listPackagesWithInstalls, listUsers, listScanRuns, listContradictedEvents, listRecentMerges } from "./actions";
import { AdminTabs } from "./AdminTabs";

export default async function AdminPage() {
  const [packages, users, scanRuns, contradictedEvents, recentMerges] = await Promise.all([
    listPackagesWithInstalls(),
    listUsers(),
    listScanRuns(),
    listContradictedEvents(),
    listRecentMerges(),
  ]);

  return (
    <AdminTabs
      packages={packages}
      users={users}
      scanRuns={scanRuns}
      contradictedEvents={contradictedEvents}
      recentMerges={recentMerges}
    />
  );
}
