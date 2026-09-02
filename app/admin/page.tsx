import { listPackagesWithInstalls, listUsers, listScanRuns } from "./actions";
import { AdminTabs } from "./AdminTabs";

export default async function AdminPage() {
  const [packages, users, scanRuns] = await Promise.all([
    listPackagesWithInstalls(),
    listUsers(),
    listScanRuns(),
  ]);

  return <AdminTabs packages={packages} users={users} scanRuns={scanRuns} />;
}
