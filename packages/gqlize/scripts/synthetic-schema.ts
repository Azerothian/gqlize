import Sequelize from "sequelize";

/**
 * A parameterised pile of ormize definitions, for measuring and for pinning
 * behaviour at a size no hand-written fixture reaches.
 *
 * Two things vary independently and both matter:
 *
 * - **size** — how many types the schema ends up with, which is what the load
 *   time scales with;
 * - **depth** — how far the type graph chains before it closes, which is what
 *   the reachability walks scale with. A schema can be enormous and shallow (a
 *   thousand models all pointing at one hub) or modest and very deep, and only
 *   the deep shape reaches the recursion limits.
 *
 * `chain` links model *i* to model *i+1*, so the walk from `Query` descends
 * once per model. `wide` points every model at model 0, so the same type count
 * sits two levels below the root.
 */
export type Topology = "chain" | "wide";

export interface SyntheticOptions {
  models: number;
  topology?: Topology;
  /** scalar columns per model, before relationships */
  fields?: number;
  /** type-name prefix, so two generated sets can coexist in one process */
  prefix?: string;
}

export function syntheticDefinitions(opts: SyntheticOptions): any[] {
  const {models, topology = "chain", fields = 8, prefix = "Synth"} = opts;
  const name = (i: number) => `${prefix}${i}`;
  const definitions: any[] = [];
  for (let i = 0; i < models; i++) {
    const define: Record<string, any> = {};
    for (let f = 0; f < fields; f++) {
      define[`field${f}`] = {
        type: f % 4 === 3 ? Sequelize.INTEGER : Sequelize.STRING,
        allowNull: f % 2 === 0,
      };
    }
    const relationships: any[] = [];
    if (topology === "chain") {
      // `hasMany`, not `belongsTo`, because that is what a chain costs in
      // practice: the link runs model -> Connection -> Edge -> model, so each
      // model is four type hops rather than one. A chain of plain `belongsTo`
      // links is the same model count at a quarter of the depth, and depth is
      // the whole point of this topology.
      if (i + 1 < models) {
        relationships.push({
          type: "hasMany",
          model: name(i + 1),
          name: "children",
          options: {as: "children", foreignKey: "parentId"},
        });
      }
      // The reciprocal side is not optional: `hasMany` puts `parentId` on the
      // child, and the adapter refuses a foreign-key column it cannot trace
      // back to an association. Same pairing as the Parent/Child fixture in
      // `__tests__/helper`.
      if (i > 0) {
        relationships.push({
          type: "belongsTo",
          model: name(i - 1),
          name: "parent",
          options: {as: "parent", foreignKey: "parentId"},
        });
      }
    } else if (i > 0) {
      relationships.push({
        type: "belongsTo",
        model: name(0),
        name: "hub",
        options: {as: "hub", foreignKey: "hubId"},
      });
    }
    definitions.push({name: name(i), define, relationships});
  }
  return definitions;
}
