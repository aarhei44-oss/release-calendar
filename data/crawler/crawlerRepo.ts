import { prisma } from "@/lib/prisma";
import type {
  ScanScopeType,
  ScanStatus,
  ScanTrigger,
  SourceTier,
  SourceDisposition,
  Prisma,
} from "@/app/generated/prisma/client";

export async function createScanRun(params: { scopeType: ScanScopeType; scopeId?: string; trigger: ScanTrigger }) {
  return prisma.scanRun.create({
    data: {
      scopeType: params.scopeType,
      scopeId: params.scopeId,
      trigger: params.trigger,
      status: "RUNNING",
      startedAt: new Date(),
    },
  });
}

export async function finalizeScanRun(
  id: string,
  params: { status: ScanStatus; totals?: Prisma.InputJsonValue },
) {
  return prisma.scanRun.update({
    where: { id },
    data: { status: params.status, totals: params.totals, finishedAt: new Date() },
  });
}

export async function recordDiscoveryHit(params: {
  tcgProfileInstallId: string;
  url: string;
  title?: string;
  raw?: Prisma.InputJsonValue;
}) {
  return prisma.discoveryHit.upsert({
    where: {
      tcgProfileInstallId_url: {
        tcgProfileInstallId: params.tcgProfileInstallId,
        url: params.url,
      },
    },
    update: { title: params.title, raw: params.raw, seenAt: new Date() },
    create: {
      tcgProfileInstallId: params.tcgProfileInstallId,
      url: params.url,
      title: params.title,
      raw: params.raw,
    },
  });
}

export async function recordSourceClaim(params: {
  releaseEventId: string;
  tier: SourceTier;
  disposition: SourceDisposition;
  confidenceWeight: number;
  url: string;
  host?: string;
  dateExact?: Date;
  dateStart?: Date;
  dateEnd?: Date;
  raw?: Prisma.InputJsonValue;
}) {
  return prisma.sourceClaim.create({
    data: { ...params, lastVerifiedAt: new Date() },
  });
}

export async function acquireJobLock(jobName: string, scopeKey: string, ttlMs: number) {
  const expiresAt = new Date(Date.now() + ttlMs);

  const existing = await prisma.jobLock.findUnique({
    where: { jobName_scopeKey: { jobName, scopeKey } },
  });

  if (existing && existing.expiresAt && existing.expiresAt > new Date()) {
    return null;
  }

  return prisma.jobLock.upsert({
    where: { jobName_scopeKey: { jobName, scopeKey } },
    update: { acquiredAt: new Date(), expiresAt },
    create: { jobName, scopeKey, acquiredAt: new Date(), expiresAt },
  });
}

export async function releaseJobLock(jobName: string, scopeKey: string) {
  await prisma.jobLock.deleteMany({ where: { jobName, scopeKey } });
}
