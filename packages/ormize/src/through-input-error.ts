// The error the relationship verbs raise for a `belongsToMany` `add`/`set`
// entry the caller's projection did not offer. Exported from the package entry
// so a projection (nestize, temporalize) can map it to its own "forbidden".

/**
 * Raised when a `belongsToMany` `add`/`set` entry has the wrong shape for the
 * relationship's mode, or its `through` payload holds a column the join model
 * does not accept. See `splitLinkEntry` in `relationship-mutations.ts`.
 */
export class ThroughInputError extends Error {
  readonly defName: string;
  readonly relName: string;
  constructor(defName: string, relName: string, message: string) {
    super(`'${defName}.${relName}': ${message}`);
    this.name = "ThroughInputError";
    this.defName = defName;
    this.relName = relName;
  }
}
