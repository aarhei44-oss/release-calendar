import * as cheerio from "cheerio";
import * as crawlerRepo from "@/data/crawler/crawlerRepo";
import { logEvent, withActionLogging } from "@/lib/logger";
import { fetchWithRetry } from "./httpFetch";
import type { ImageSourceConfig } from "./adapters/types";

export type ImageEnrichmentResult = { imagesFetched: number; errors: number };

/**
 * Second-stage crawler pass: fetches the official marketing image for
 * product sets that already have a CONFIRMED release event, once each --
 * ProductSet.imageUrl is only ever set here, and only from a single
 * consistent per-package source (an official product-page URL template),
 * not from the varied SourceClaim tiers/hosts the date-scraping stage
 * pulls from. Runs at the end of every scan (see orchestrate.ts), after
 * the lifecycle pass has finalized statuses for this run, and is also
 * admin-triggerable, same as dedupPass/lifecycle/retention.
 */
export async function runImageEnrichmentPass(
  params: { installIds?: string[] } = {},
): Promise<ImageEnrichmentResult> {
  return withActionLogging("crawler.runImageEnrichmentPass", async () => {
    const productSets = await crawlerRepo.getProductSetsNeedingImages(params.installIds);

    let imagesFetched = 0;
    let errors = 0;

    for (const productSet of productSets) {
      const config = productSet.install.package.imageSourceConfig as ImageSourceConfig | null;
      if (!config?.urlTemplate) continue;

      try {
        const pageUrl = buildProductPageUrl(config.urlTemplate, productSet);
        const imageUrl = await fetchOgImage(pageUrl);
        if (!imageUrl) continue;

        await crawlerRepo.setProductSetImageUrl(productSet.id, imageUrl);
        imagesFetched += 1;
      } catch (error) {
        errors += 1;
        logEvent({
          action: "crawler.imageEnrichment.fetch",
          productSetId: productSet.id,
          outcome: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { imagesFetched, errors };
  });
}

function buildProductPageUrl(
  urlTemplate: string,
  productSet: { code: string | null; name: string | null },
): string {
  return urlTemplate
    .replace("{code}", encodeURIComponent(productSet.code ?? ""))
    .replace("{name}", encodeURIComponent(productSet.name ?? ""));
}

/** Fetches a product page and reads its og:image meta tag, resolved to an absolute URL. Returns null if the page has none. */
async function fetchOgImage(pageUrl: string): Promise<string | null> {
  const response = await fetchWithRetry(pageUrl);
  if (!response.ok) return null;
  const html = await response.text();

  const $ = cheerio.load(html);
  const content = $('meta[property="og:image"]').attr("content") ?? $('meta[name="og:image"]').attr("content");
  if (!content) return null;

  try {
    return new URL(content, pageUrl).toString();
  } catch {
    return null;
  }
}
