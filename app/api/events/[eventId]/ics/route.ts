import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import { getEventDetail } from "@/data/calendar/calendarRepo";
import { buildIcsFeed } from "@/lib/ical";
import { eventTitle } from "@/app/calendar/mapEvents";
import { logEvent } from "@/lib/logger";

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "event";
}

/**
 * Single-event .ics download -- the per-event "Add to Calendar" premium
 * feature (see EventDrawer). Event dates/titles are already public
 * elsewhere in the app; this is gated server-side purely as the paid
 * convenience feature it's sold as, same as every other premium action
 * (see lib/authGuards.ts), not because the data itself is sensitive.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const session = await getServerSession(authOptions);

  if (!session?.user?.isPremium) {
    logEvent({ action: "event.ics", outcome: "denied" });
    return new Response("Premium required", { status: 403 });
  }

  const event = await getEventDetail(eventId);
  if (!event) {
    return new Response("Not found", { status: 404 });
  }

  const ics = buildIcsFeed([event]);
  logEvent({ action: "event.ics", outcome: "success", userId: session.user.id, eventId });

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slugify(eventTitle(event))}.ics"`,
    },
  });
}
