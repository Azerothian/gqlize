import Sequelize from "sequelize";
import type {Definition} from "../../../src/types";

/**
 * Matrix test fixture: two models (Alpha, Beta) with all four Sequelize
 * relationship types between them, plus a join model for the belongsToMany.
 *
 * Kept out of the shared fixture set — pass via `createInstance(matrixDefs)` —
 * so that the `schema-golden` snapshot is unaffected.
 */

const AlphaDef: Definition = {
  name: "Alpha",
  define: {
    name: {type: Sequelize.STRING, allowNull: false, unique: true},
    rank: {type: Sequelize.INTEGER, allowNull: false},
    // FK for belongsTo Beta
    betaId: {type: Sequelize.INTEGER, allowNull: true, writable: true},
    // FK for hasOne Beta -> oneA
    oneBetaId: {type: Sequelize.INTEGER, allowNull: true, writable: true},
  },
  relationships: [
    {
      type: "belongsTo",
      model: "Beta",
      name: "toB",
      options: {foreignKey: "betaId"},
    },
    {
      type: "hasOne",
      model: "Beta",
      name: "oneB",
      options: {foreignKey: "oneAlphaId"},
    },
    {
      type: "hasMany",
      model: "Beta",
      name: "manyB",
      options: {foreignKey: "alphaId"},
    },
    {
      type: "belongsToMany",
      model: "Beta",
      name: "linkB",
      options: {
        through: "alpha_beta_links",
        foreignKey: "alphaId",
        otherKey: "betaId",
      },
    },
  ],
  options: {tableName: "alphas"},
};

const BetaDef: Definition = {
  name: "Beta",
  define: {
    name: {type: Sequelize.STRING, allowNull: false, unique: true},
    rank: {type: Sequelize.INTEGER, allowNull: false},
    // FK for belongsTo Alpha (inverse of Alpha.manyB)
    alphaId: {type: Sequelize.INTEGER, allowNull: true, writable: true},
    // FK for hasOne Alpha -> oneB
    oneAlphaId: {type: Sequelize.INTEGER, allowNull: true, writable: true},
  },
  relationships: [
    {
      type: "belongsTo",
      model: "Alpha",
      name: "toA",
      options: {foreignKey: "alphaId"},
    },
    {
      type: "hasOne",
      model: "Alpha",
      name: "oneA",
      options: {foreignKey: "oneBetaId"},
    },
    {
      type: "hasMany",
      model: "Alpha",
      name: "manyA",
      options: {foreignKey: "betaId"},
    },
    {
      type: "belongsToMany",
      model: "Alpha",
      name: "linkA",
      options: {
        through: "alpha_beta_links",
        foreignKey: "betaId",
        otherKey: "alphaId",
      },
    },
  ],
  options: {tableName: "betas"},
};

export const matrixDefs: Definition[] = [AlphaDef, BetaDef];
