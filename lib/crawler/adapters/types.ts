import type { ReleaseEventType, Region, SourceTier } from "@/app/generated/prisma/client";
import type { ParsedDate } from "../dateParsing";

export type RawFetchResult = {
  url: string;
  status: number;
  html: string;
  fetchedAt: Date;
};

export type ParsedCandidate = {
  productSetCode: string;
  productSetName: string;
  eventType: ReleaseEventType;
  region: Region;
} & ParsedDate;

export type SourceConfig = {
  url: string;
  tier: SourceTier;
  parser: string;
  /**
   * Adapter-specific tuning (e.g. which table column to read); shape is
   * per-adapter. Kept JSON-safe (string | string[] values only) so a
   * SourceConfig can be stored directly in TcgProfilePackage.sourceConfigs
   * without a cast.
   */
  options?: Record<string, string | string[]>;
};

export interface ParserAdapter {
  key: string;
  fetch(config: SourceConfig): Promise<RawFetchResult>;
  parse(raw: RawFetchResult, config: SourceConfig): ParsedCandidate[];
}
