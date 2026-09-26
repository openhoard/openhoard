export { declaredKind, mayExtract } from "./detect.ts";
export { DEFAULT_LIMITS, MAX_TEXT_BYTES, resolveLimits } from "./limits.ts";
export { extract, type ExtractOptions } from "./sandbox.ts";
export {
  CSV_TYPES,
  EXTRACTION_KINDS,
  PERMANENT_FAILURES,
  SIGNAL_KINDS,
  TRANSIENT_FAILURES,
  WARNING_CODES,
  type CsvColumn,
  type CsvType,
  type Extraction,
  type ExtractionKind,
  type ExtractionMetadata,
  type ExtractHint,
  type ExtractLimits,
  type ExtractResult,
  type ExtractStats,
  type FailureCode,
  type PermanentFailure,
  type Signal,
  type SignalKind,
  type TransientFailure,
  type WarningCode,
} from "./types.ts";

/** The extractor's version, stored with every extraction so a newer one can find what to redo. */
export const EXTRACTOR_VERSION = "openhoard-extract/1";
