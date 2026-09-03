import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { runImageEnrichmentPass } from "@/lib/crawler/imageEnrichment";

let installId: string;

async function createInstall(imageSourceConfig: unknown) {
  const pkg = await prisma.tcgProfilePackage.create({
    data: {
      slug: `image-test-${crypto.randomUUID()}`,
      name: "Image Test",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: {},
      imageSourceConfig: imageSourceConfig as never,
    },
  });
  return prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
}

async function createProductSetWithEvent(
  installId: string,
  code: string,
  status: "RUMORED" | "ANNOUNCED" | "CONFIRMED" = "CONFIRMED",
  imageUrl: string | null = null,
) {
  const productSet = await prisma.productSet.create({
    data: { tcgProfileInstallId: installId, code, name: `Set ${code}`, imageUrl },
  });
  await prisma.releaseEvent.create({
    data: { productSetId: productSet.id, type: "SHELF", dateType: "TBD", status, confidence: status === "CONFIRMED" ? 0.9 : 0.2 },
  });
  return productSet;
}

beforeEach(async () => {
  const install = await createInstall({ urlTemplate: "https://example.com/sets/{code}" });
  installId = install.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function mockFetchOnce(html: string, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => html,
    })),
  );
}

describe("runImageEnrichmentPass", () => {
  it("fetches the official product page and stores the resolved og:image URL", async () => {
    const productSet = await createProductSetWithEvent(installId, "IE-1");
    mockFetchOnce(`<html><head><meta property="og:image" content="/images/ie-1.jpg"></head></html>`);

    const result = await runImageEnrichmentPass({ installIds: [installId] });

    expect(result).toEqual({ imagesFetched: 1, errors: 0 });
    expect(fetch).toHaveBeenCalledWith("https://example.com/sets/IE-1", expect.anything());
    const reloaded = await prisma.productSet.findUniqueOrThrow({ where: { id: productSet.id } });
    expect(reloaded.imageUrl).toBe("https://example.com/images/ie-1.jpg");
  });

  it("does not fetch for a set with no CONFIRMED event", async () => {
    await createProductSetWithEvent(installId, "IE-2", "ANNOUNCED");
    mockFetchOnce(`<html><head><meta property="og:image" content="/x.jpg"></head></html>`);

    const result = await runImageEnrichmentPass({ installIds: [installId] });

    expect(result).toEqual({ imagesFetched: 0, errors: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not re-fetch a set that already has an imageUrl", async () => {
    await createProductSetWithEvent(installId, "IE-3", "CONFIRMED", "https://example.com/existing.jpg");
    mockFetchOnce(`<html><head><meta property="og:image" content="/x.jpg"></head></html>`);

    const result = await runImageEnrichmentPass({ installIds: [installId] });

    expect(result).toEqual({ imagesFetched: 0, errors: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips installs whose package has no imageSourceConfig", async () => {
    const install2 = await createInstall(null);
    await createProductSetWithEvent(install2.id, "IE-4", "CONFIRMED");
    mockFetchOnce(`<html><head><meta property="og:image" content="/x.jpg"></head></html>`);

    const result = await runImageEnrichmentPass({ installIds: [install2.id] });

    expect(result).toEqual({ imagesFetched: 0, errors: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves imageUrl unset and does not count a fetch when the page has no og:image tag", async () => {
    const productSet = await createProductSetWithEvent(installId, "IE-5");
    mockFetchOnce(`<html><head><title>No image here</title></head></html>`);

    const result = await runImageEnrichmentPass({ installIds: [installId] });

    expect(result).toEqual({ imagesFetched: 0, errors: 0 });
    const reloaded = await prisma.productSet.findUniqueOrThrow({ where: { id: productSet.id } });
    expect(reloaded.imageUrl).toBeNull();
  });

  it("counts a fetch failure as an error and leaves imageUrl unset", async () => {
    await createProductSetWithEvent(installId, "IE-6");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await runImageEnrichmentPass({ installIds: [installId] });

    expect(result).toEqual({ imagesFetched: 0, errors: 1 });
  });

  it("does not touch sets belonging to installs outside the given scope", async () => {
    const install2 = await createInstall({ urlTemplate: "https://example.com/sets/{code}" });
    await createProductSetWithEvent(install2.id, "IE-7", "CONFIRMED");
    mockFetchOnce(`<html><head><meta property="og:image" content="/x.jpg"></head></html>`);

    const result = await runImageEnrichmentPass({ installIds: [installId] });

    expect(result).toEqual({ imagesFetched: 0, errors: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
