import { lexicographicSortSchema, printSchema } from "graphql";

import { createSchema } from "../../index";
import { loadSchema } from "../../graphql/snapshot/load";
import type { ParsedArgs } from "../args";
import type { ResolvedConfig } from "../config";
import { resolveArtifactPath, resolveOut } from "../config";
import { resolveProfiles } from "../profiles";

/**
 * Print the schema as SDL.
 *
 * SDL is a *secondary* artifact: it is for humans, codegen and CI diffs, and it
 * is not loadable — `printSchema` discards enum internal values, which is what
 * the JSON artifact exists to carry. `--sorted` gives a stable ordering for
 * diffing across builds whose type-construction order differs.
 */
export default async function print(
  resolved: ResolvedConfig,
  args: ParsedArgs,
  out: (line: string) => void,
): Promise<number> {
  const [profile] = resolveProfiles(resolved, args);
  const orm = await resolved.config.orm();

  const requested = resolveOut(resolved.dir, args.fromArtifact);
  const fromArtifact = requested && await resolveArtifactPath(requested);
  const schema = fromArtifact
    ? await loadSchema(fromArtifact, orm, {
      ...profile.options,
      scalars: resolved.config.scalars,
      permissionProfile: profile.permissionProfile,
      idProfile: profile.idProfile,
      cursorProfile: profile.cursorProfile,
    })
    : await createSchema(orm, profile.options);

  out(printSchema(args.sorted ? lexicographicSortSchema(schema) : schema));
  return 0;
}
