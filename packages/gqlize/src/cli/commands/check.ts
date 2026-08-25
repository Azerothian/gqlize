import { lexicographicSortSchema, printSchema } from "graphql";

import { createSchema } from "../../index";
import { compareFingerprints, fingerprintDefinitions } from "../../graphql/snapshot/fingerprint";
import { readSnapshot } from "../../graphql/snapshot/load";
import { materializeSchema } from "../../graphql/snapshot/materialize";
import type { ParsedArgs } from "../args";
import { resolveArtifactPath, resolveOut, type ResolvedConfig } from "../config";
import { resolveProfiles, type ResolvedProfile } from "../profiles";

/**
 * Compare an artifact against the live definitions. Exit 0 clean, 1 on drift.
 *
 * Two levels, because the fingerprint has a known blind spot:
 *
 *  - the fingerprint compare is instant, but `options.permission` is a bag of
 *    closures and cannot be hashed, so it cannot see permission drift;
 *  - `--strict` (the default) additionally builds the schema live, materializes
 *    the artifact, and diffs the sorted SDL. That catches *any* divergence,
 *    permissions included, and is what belongs in CI.
 */
export default async function check(
  resolved: ResolvedConfig,
  args: ParsedArgs,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const profiles = resolveProfiles(resolved, args);
  const orm = await resolved.config.orm();
  let failed = false;

  for (const profile of profiles) {
    const path = await resolveArtifactPath(resolveOut(resolved.dir, args.artifact) || profile.out);
    if (!(await checkOne(resolved, profile, path, orm, args.strict, out, err))) {
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

async function checkOne(
  resolved: ResolvedConfig,
  profile: ResolvedProfile,
  path: string,
  orm: any,
  strict: boolean,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<boolean> {
  const label = profile.name ? `${profile.name}: ` : "";
  let artifact;
  try {
    artifact = await readSnapshot(path);
  } catch (e: any) {
    err(`${label}${e.message}`);
    return false;
  }

  if (!artifact.fingerprint) {
    err(`${label}${path} has no fingerprint — rebuild it`);
    return false;
  }
  const drift = compareFingerprints(
    artifact.fingerprint,
    fingerprintDefinitions(orm, {
      permissionProfile: profile.permissionProfile,
      idProfile: profile.idProfile,
      cursorProfile: profile.cursorProfile,
      options: profile.options,
    }),
  );
  if (drift.length) {
    err(`${label}${path} is stale — ${drift.join(", ")} differ from the live definitions`);
    return false;
  }
  if (!strict) {
    out(`${label}${path} — fingerprint ok (not strict: permission drift is not covered)`);
    return true;
  }

  const live = printSchema(lexicographicSortSchema(await createSchema(orm, profile.options)));
  const rebuilt = printSchema(lexicographicSortSchema(
    await materializeSchema(artifact, orm, {
      ...profile.options,
      scalars: resolved.config.scalars,
      permissionProfile: profile.permissionProfile,
      idProfile: profile.idProfile,
      cursorProfile: profile.cursorProfile,
    }),
  ));
  if (live !== rebuilt) {
    err(`${label}${path} does not match a live build:\n${firstDiff(live, rebuilt)}`);
    return false;
  }
  out(`${label}${path} — ok`);
  return true;
}

/**
 * The first few differing lines rather than a full diff. The point is to name
 * *what* moved so the operator knows whether a rebuild is enough; a 3000-line
 * SDL diff in CI output helps nobody.
 */
function firstDiff(a: string, b: string, context = 6): string {
  const left = a.split("\n");
  const right = b.split("\n");
  const lines: string[] = [];
  for (let i = 0; i < Math.max(left.length, right.length) && lines.length < context; i++) {
    if (left[i] !== right[i]) {
      lines.push(`  ${i + 1} live:     ${left[i] ?? "<end of file>"}`);
      lines.push(`  ${i + 1} artifact: ${right[i] ?? "<end of file>"}`);
    }
  }
  return lines.join("\n");
}
