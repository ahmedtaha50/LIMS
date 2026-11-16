// The data shapes the factory reads and writes. Used by the JSDoc types of the tools (checked by `bash scripts/typecheck.sh`).

/** One gap of the roadmap: something the product lacks, with the criteria that say it is done. */
export interface Gap { id: string; title?: string; acceptance?: string[]; [k: string]: unknown }

/** A track as written in the roadmap. */
export interface TrackInput { track: string; gapIds?: string[]; ownsFiles?: string[]; dependsOn?: string[]; migrations?: string; summary?: string; [k: string]: unknown }

/** A track after loading: lists are always present, and it knows its release. */
export interface Track extends TrackInput { gapIds: string[]; ownsFiles: string[]; dependsOn: string[]; release: string; releaseIndex: number }

export interface Release { name: string; goal?: string; tracks?: TrackInput[]; [k: string]: unknown }

export interface Roadmap { releases: Release[]; gaps: Gap[]; tracks: Track[]; byName: Map<string, Track>; gapById: Map<string, Gap> }

/** factory.config.json merged over the defaults. Keys beyond the defaults are project facts that fill the briefs. */
export interface Config {
  ROADMAP: string; CHANGES_DIR: string; EVIDENCE_DIR: string; VALIDATION_DIR: string; OPEN_ITEMS: string; DB_PREFIX: string; BASE_PORT: number;
  VALIDATION_DOCS?: string; DEVIATIONS_CSV?: string; HOUSE_RULES_FILE?: string; TRAILERS?: string; PROJECT?: string; BRANCH?: string;
  [k: string]: unknown;
}

/** One answer of a track's acceptance ledger. */
export interface LedgerEntry { gap: string; n: number; status: 'met' | 'partly' | 'not-met'; evidence?: string }

/** The report a track sends at the end of its work (assets/briefs/report.schema.json, REPORT). */
export interface Report {
  track: string; status: 'complete' | 'partial' | 'blocked';
  done: string[]; notDone: string[]; filesChanged: string[]; testsAdded: string[]; testEvidence: string;
  decisionsForUser: string[]; needsFromOtherTracks: string[]; acceptance?: LedgerEntry[];
}

/** An entry of the open-items register. */
export interface OpenItem {
  id: string; kind: 'not-done' | 'acceptance' | 'decision' | 'deviation'; source: string; text: string;
  status: 'open' | 'resolved' | 'dropped'; opened: string; key: string;
  by?: string; reason?: string; decidedBy?: string; closed?: string;
}
