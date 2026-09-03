import { listPackagesWithInstalls, listUsers, listScanRuns, listContradictedEvents } from "./actions";
import { AdminTabs } from "./AdminTabs";

export default async function AdminPage() {
  const [packages, users, scanRuns, contradictedEvents] = await Promise.all([
    listPackagesWithInstalls(),
    listUsers(),
    listScanRuns(),
    listContradictedEvents(),
  ]);

  return (
    <AdminTabs packages={packages} users={users} scanRuns={scanRuns} contradictedEvents={contradictedEvents} />
  );
}
