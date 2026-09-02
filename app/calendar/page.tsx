import { getFilteredEvents } from "./actions";
import { listEnabledInstallsForFilters } from "@/data/calendar/calendarRepo";
import { parseCalendarSearchParams, monthRange, type RawSearchParams } from "./searchParams";
import { CalendarShell } from "./CalendarShell";

type Props = {
  searchParams: Promise<RawSearchParams>;
};

function dateRangeFor(parsed: ReturnType<typeof parseCalendarSearchParams>) {
  if (parsed.tab === "list") return monthRange(parsed.listMonth);
  if (parsed.tab === "upcoming") {
    const from = new Date();
    const to = new Date();
    to.setDate(to.getDate() + 90);
    return { from, to };
  }
  return monthRange(parsed.calMonth);
}

export default async function CalendarPage({ searchParams }: Props) {
  const parsed = parseCalendarSearchParams(await searchParams);
  const { from, to } = dateRangeFor(parsed);

  const [events, installs] = await Promise.all([
    getFilteredEvents({
      installIds: parsed.installIds,
      types: parsed.types,
      statuses: parsed.statuses,
      search: parsed.search || undefined,
      from,
      to,
    }),
    listEnabledInstallsForFilters(),
  ]);

  const installOptions = installs.map((install) => ({ id: install.id, name: install.package.name }));

  return <CalendarShell parsed={parsed} events={events} installOptions={installOptions} />;
}
