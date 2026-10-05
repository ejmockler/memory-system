// bm25-projection.js — B2: model-neutral lexical index selection.
//
// BM25 contains no dense vectors, but its historical storage key is the
// dense embedding model version.  This module provides the opt-in seam that
// lets recall select a separately published lexical generation instead:
//
//   flag off (default)  indices/<embedding_model_version>/bm25.json
//   flag on             indices/_lexical/<manifest-declared member>
//
// The neutral path is never accepted as a loose file.  Its active manifest
// must exist and its BM25 member must pass size + sha256 verification first.
// Publishing is likewise side-by-side: copy an already-built BM25 index to a
// new generation member, verify it, then atomically switch only the manifest.
// This module never rebuilds an index and never writes a ledger.

import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import { MEMORY_ROOT } from "../config.js";
import {
  assertCoverageFloor,
  probeBm25Coverage,
} from "./bm25-coverage-probe.js";
import {
  activateManifest,
  buildManifest,
  checksumMemberFile,
  gcGenerations,
  memberStatIdentity,
  readActiveManifest,
  verifyGenerationMembers,
} from "./index-manifest.js";

export const BM25_MODEL_NEUTRAL_FLAG = "MEMORY_BM25_MODEL_NEUTRAL";
export const LEXICAL_INDEX_KEY = "_lexical";
export const DEFAULT_BM25_PROJECTION_COVERAGE_PCT = 99;

export class Bm25ProjectionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "Bm25ProjectionError";
    this.code = code;
    this.details = details;
  }
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Bm25ProjectionError(
      "bm25_projection_bad_arguments",
      `${name} must be a non-empty string`,
      { [name]: value },
    );
  }
  return value;
}

function rootFrom(opts) {
  const root = opts != null && opts.memoryRoot != null ? opts.memoryRoot : MEMORY_ROOT;
  return requireNonEmptyString(root, "memoryRoot");
}

function lexicalMembers(bm25) {
  return { bm25, hnsw: null, hnsw_meta: null };
}

function throwManifestReadError(dir, error) {
  throw new Bm25ProjectionError(
    error?.code ?? "index_manifest_unreadable",
    `BM25 projection manifest at ${dir} is unreadable: ${error?.message ?? "unknown error"}`,
    { dir, manifest_error: error ?? null },
  );
}

/** Exact opt-in: unset, empty, "true", and every value except "1" are off. */
export function isModelNeutralBm25Enabled(env = process.env) {
  return env != null && env[BM25_MODEL_NEUTRAL_FLAG] === "1";
}

/**
 * Resolve the lexical member for a dense model version.
 *
 * With the flag off this is deliberately a pure path calculation matching
 * index-cache.js's historical path.  With it on, a missing, malformed, or
 * checksum-mismatched neutral generation throws: there is no fallback to a
 * loose `_lexical/bm25.json` and no accidental cross-model selection.
 */
export function resolveBm25Member(modelVersion, opts = {}) {
  requireNonEmptyString(modelVersion, "modelVersion");
  const memoryRoot = rootFrom(opts);
  const enabled =
    typeof opts.enabled === "boolean"
      ? opts.enabled
      : isModelNeutralBm25Enabled(opts.env ?? process.env);

  if (!enabled) {
    const dir = join(memoryRoot, "indices", modelVersion);
    return {
      enabled: false,
      model_neutral: false,
      dir,
      bm25Path: join(dir, "bm25.json"),
      member: null,
      manifest: null,
      generation: null,
    };
  }

  const dir = join(memoryRoot, "indices", LEXICAL_INDEX_KEY);
  const read = readActiveManifest(dir);
  if (read.error != null) throwManifestReadError(dir, read.error);
  if (read.manifest == null) {
    throw new Bm25ProjectionError(
      "bm25_projection_unavailable",
      `model-neutral BM25 is enabled but no active manifest exists at ${dir}`,
      { dir },
    );
  }
  const member = read.manifest.members?.bm25 ?? null;
  if (member == null) {
    throw new Bm25ProjectionError(
      "bm25_projection_unavailable",
      `model-neutral BM25 manifest generation ${read.manifest.generation} declares no bm25 member`,
      { dir, generation: read.manifest.generation },
    );
  }

  const verified = verifyGenerationMembers(dir, lexicalMembers(member));
  if (!verified.ok) {
    throw new Bm25ProjectionError(
      verified.error?.code ?? "index_manifest_member_mismatch",
      `model-neutral BM25 generation ${read.manifest.generation} failed checksum verification`,
      {
        dir,
        generation: read.manifest.generation,
        verification_error: verified.error ?? null,
      },
    );
  }

  return {
    enabled: true,
    model_neutral: true,
    dir,
    bm25Path: join(dir, member.file),
    member,
    manifest: read.manifest,
    generation: read.manifest.generation,
  };
}

/** Convenience adapter for callers that need only the selected filename. */
export function resolveBm25Path(modelVersion, opts = {}) {
  return resolveBm25Member(modelVersion, opts).bm25Path;
}

function sourceBm25(sourceDir) {
  const read = readActiveManifest(sourceDir);
  if (read.error != null) throwManifestReadError(sourceDir, read.error);
  if (read.manifest == null || read.manifest.members?.bm25 == null) {
    throw new Bm25ProjectionError(
      "bm25_projection_source_unverified",
      `source BM25 at ${sourceDir} has no manifest-declared active member`,
      { sourceDir },
    );
  }
  return {
    manifest: read.manifest,
    member: read.manifest.members.bm25,
    path: join(sourceDir, read.manifest.members.bm25.file),
  };
}

function nextGenerationFile(dir, active) {
  let generation = active == null ? 0 : active.generation + 1;
  while (existsSync(join(dir, `bm25.gen-${generation}.json`))) generation += 1;
  return { generation, file: `bm25.gen-${generation}.json` };
}

/**
 * Publish an existing, coverage-proven BM25 index under `indices/_lexical/`.
 *
 * The B1 probe supplies the coverage measurement and integrity witness.  No
 * member is written until the probe clears `minCoveragePct` and reports a
 * manifest-verified source.  The source is then copied to a never-before-used
 * generation filename, checksummed in the neutral directory, verified via
 * index-manifest.js, and finally made active by one atomic manifest rename.
 * Existing neutral members are never replaced or deleted.
 */
export function activateBm25Projection(opts = {}) {
  const memoryRoot = rootFrom(opts);
  const sourceModelVersion = requireNonEmptyString(
    opts.sourceModelVersion,
    "sourceModelVersion",
  );
  if (sourceModelVersion === LEXICAL_INDEX_KEY) {
    throw new Bm25ProjectionError(
      "bm25_projection_bad_arguments",
      `${LEXICAL_INDEX_KEY} cannot be used as sourceModelVersion`,
      { sourceModelVersion },
    );
  }
  const ledgerPath = requireNonEmptyString(opts.ledgerPath, "ledgerPath");
  const minCoveragePct =
    opts.minCoveragePct == null
      ? DEFAULT_BM25_PROJECTION_COVERAGE_PCT
      : opts.minCoveragePct;
  if (
    typeof minCoveragePct !== "number" ||
    !Number.isFinite(minCoveragePct) ||
    minCoveragePct < 0 ||
    minCoveragePct > 100
  ) {
    throw new Bm25ProjectionError(
      "bm25_projection_bad_arguments",
      `minCoveragePct must be a finite percent in [0,100], got ${String(minCoveragePct)}`,
      { minCoveragePct },
    );
  }

  const sourceDir = join(memoryRoot, "indices", sourceModelVersion);
  const source = sourceBm25(sourceDir);
  const coverage = probeBm25Coverage({
    indexPath: source.path,
    ledgerPath,
    snapshot: opts.snapshot,
    growthCheckPath: opts.growthCheckPath,
    verifyIndexDigest: true,
  });
  assertCoverageFloor(coverage, minCoveragePct);
  if (coverage.index_integrity !== "manifest-verified") {
    throw new Bm25ProjectionError(
      "bm25_projection_source_unverified",
      `source BM25 passed coverage but not manifest integrity: ${coverage.index_integrity}`,
      { sourceDir, sourcePath: source.path, coverage },
    );
  }

  // Bind the copy to the exact source inode measured by the coverage probe.
  // A concurrent source publication replaces the path with a new inode and
  // is refused before any neutral file is created.
  let sourceStat;
  try {
    sourceStat = statSync(source.path);
  } catch (error) {
    throw new Bm25ProjectionError(
      "bm25_projection_source_moved",
      `source BM25 disappeared after coverage verification: ${source.path}`,
      { sourcePath: source.path, errno: error?.code ?? null },
    );
  }
  if (memberStatIdentity(sourceStat) !== coverage.index_stat_identity_after) {
    throw new Bm25ProjectionError(
      "bm25_projection_source_moved",
      `source BM25 changed after coverage verification: ${source.path}`,
      {
        sourcePath: source.path,
        measured_identity: coverage.index_stat_identity_after,
        current_identity: memberStatIdentity(sourceStat),
      },
    );
  }

  const lexicalDir = join(memoryRoot, "indices", LEXICAL_INDEX_KEY);
  mkdirSync(lexicalDir, { recursive: true, mode: 0o700 });
  const current = readActiveManifest(lexicalDir);
  if (current.error != null) throwManifestReadError(lexicalDir, current.error);
  const { generation, file } = nextGenerationFile(lexicalDir, current.manifest);
  const candidatePath = join(lexicalDir, file);

  // COPYFILE_EXCL makes every candidate immutable-by-convention from birth:
  // no retry can overwrite an orphan left by a crash before activation.
  copyFileSync(source.path, candidatePath, fsConstants.COPYFILE_EXCL);

  try {
    const copiedSourceStat = statSync(source.path);
    if (memberStatIdentity(copiedSourceStat) !== memberStatIdentity(sourceStat)) {
      throw new Bm25ProjectionError(
        "bm25_projection_source_moved",
        `source BM25 changed while its neutral candidate was copied: ${source.path}`,
        {
          sourcePath: source.path,
          before_identity: memberStatIdentity(sourceStat),
          after_identity: memberStatIdentity(copiedSourceStat),
          orphan_candidate: candidatePath,
        },
      );
    }

    const candidate = checksumMemberFile(lexicalDir, file);
    if (candidate.sha256 !== source.member.sha256 || candidate.size !== source.member.size) {
      throw new Bm25ProjectionError(
        "index_manifest_member_mismatch",
        "neutral BM25 candidate does not match the manifest-verified source bytes",
        {
          source_member: source.member,
          candidate_member: candidate,
          orphan_candidate: candidatePath,
        },
      );
    }
    const members = lexicalMembers(candidate);
    const verified = verifyGenerationMembers(lexicalDir, members);
    if (!verified.ok) {
      throw new Bm25ProjectionError(
        verified.error?.code ?? "index_manifest_member_mismatch",
        "neutral BM25 candidate failed checksum verification; manifest was not activated",
        {
          verification_error: verified.error ?? null,
          orphan_candidate: candidatePath,
        },
      );
    }

    const previous =
      current.manifest == null
        ? null
        : {
            generation: current.manifest.generation,
            wal_cursor: current.manifest.wal_cursor,
            members: current.manifest.members,
          };
    const manifest = buildManifest({
      generation,
      embedding_model_version: null,
      dims: null,
      hnsw_backend: null,
      hnsw_format: null,
      wal_cursor: source.manifest.wal_cursor,
      members,
      previous,
    });
    activateManifest(lexicalDir, manifest);

    // Keep only the active generation and its manifest-retained fallback.
    // Without this, each periodic rebuild leaks another full BM25 copy.
    const gc = gcGenerations(lexicalDir, manifest);
    if (gc.error != null) {
      console.error(
        `bm25-projection: generation GC failed: ${JSON.stringify(gc.error)}`,
      );
    }

    return {
      coverage,
      manifest,
      sourcePath: source.path,
      lexicalDir,
      bm25Path: candidatePath,
      gc,
    };
  } catch (error) {
    // Every failure after COPYFILE_EXCL owns this exact candidate. Remove it
    // so a checksum/race failure cannot leak a full-size unreferenced copy.
    try {
      unlinkSync(candidatePath);
      if (error?.details && typeof error.details === "object") {
        error.details.orphan_candidate_removed = true;
      }
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        if (error?.details && typeof error.details === "object") {
          error.details.orphan_cleanup_error = cleanupError.message;
        }
      }
    }
    throw error;
  }
}

// Naming alias for operator/scripts code that reads more naturally as a verb.
export const projectBm25Index = activateBm25Projection;
