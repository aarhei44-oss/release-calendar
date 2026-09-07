import { ReviewQueue } from "./ReviewQueue";
import type { listReviewQueue } from "./actions";

type Props = {
  reviewQueue: Awaited<ReturnType<typeof listReviewQueue>>;
};

export function ReviewTab({ reviewQueue }: Props) {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium text-gray-700">Ingest review queue</h3>
          <p className="text-sm text-gray-600">
            Events the publish gate routed to a human: the sources disagree (CONFLICT) or the agreed date moved further
            than a release date plausibly moves unannounced (LARGE_SHIFT). Resolving an item closes it; accepting a
            claim also pins that date against future scans.
          </p>
        </div>
        <ReviewQueue items={reviewQueue} />
      </section>
    </div>
  );
}
