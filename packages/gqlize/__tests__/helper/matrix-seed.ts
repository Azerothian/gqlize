/**
 * Deterministic seeder for the Alpha / Beta matrix fixture.
 *
 * A fixed-seed PRNG assigns foreign-key relationships so that every
 * relationship type has rows with zero, one, and multiple related rows.
 * The returned graph is the single source of truth for the oracle.
 */

// ---------- simple seeded PRNG (mulberry32) ----------
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- types ----------
export interface AlphaRow {
  id: number;
  name: string;
  rank: number;
  /** FK for Alpha.toB (belongsTo Beta) */
  betaId: number | null;
  /** FK for Beta.oneA -> Alpha (hasOne from Beta side) */
  oneBetaId: number | null;
}

export interface BetaRow {
  id: number;
  name: string;
  rank: number;
  /** FK for Beta.toA (belongsTo Alpha) — inverse of Alpha.manyB */
  alphaId: number | null;
  /** FK for Alpha.oneB -> Beta (hasOne from Alpha side) */
  oneAlphaId: number | null;
}

export interface LinkRow {
  alphaId: number;
  betaId: number;
}

export interface SeedGraph {
  alphas: AlphaRow[];
  betas: BetaRow[];
  links: LinkRow[];
}

/**
 * Seed the database and return the in-memory graph.
 *
 * `models` is the `db.models` bag from a synced Ormize instance that
 * includes Alpha and Beta (with the through table auto-created by
 * the belongsToMany association).
 */
export async function seedMatrix(models: {
  Alpha: {create: (v: Record<string, unknown>) => Promise<{get: (k: string) => unknown}>};
  Beta: {create: (v: Record<string, unknown>) => Promise<{get: (k: string) => unknown}>};
}): Promise<SeedGraph> {
  const rng = mulberry32(42);

  const N = 12;
  const alphas: AlphaRow[] = [];
  const betas: BetaRow[] = [];
  const links: LinkRow[] = [];

  // ---- Create Betas first (Alpha.betaId points at Beta) ----
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw Sequelize instances for FK updates
  const betaInstances: any[] = [];
  for (let i = 1; i <= N; i++) {
    const row = await models.Beta.create({
      name: `b${i}`,
      rank: Math.floor(rng() * 20),
      alphaId: null,
      oneAlphaId: null,
    });
    betaInstances.push(row);
    betas.push({
      id: row.get("id") as number,
      name: `b${i}`,
      rank: row.get("rank") as number,
      alphaId: null,
      oneAlphaId: null,
    });
  }

  // ---- Create Alphas ----
  // Alpha.betaId (belongsTo Beta "toB"):
  //   first 2 alphas: null, next 4 each point to a distinct beta, remaining share some
  const betaIdMap: (number | null)[] = [
    null, null,
    betas[0].id, betas[1].id, betas[2].id, betas[3].id,
    betas[0].id, betas[1].id, betas[4].id, betas[5].id,
    null, betas[6].id,
  ];

  // Alpha.oneBetaId (Beta.oneA hasOne Alpha):
  //   unique or null — first 6 get one each, rest null
  const oneBetaIdMap: (number | null)[] = [
    betas[0].id, betas[1].id, betas[2].id, betas[3].id, betas[4].id, betas[5].id,
    null, null, null, null, null, null,
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- need Sequelize instance methods (addLinkB) not exposed in the typed interface
  const alphaInstances: any[] = [];
  for (let i = 1; i <= N; i++) {
    const row = await models.Alpha.create({
      name: `a${i}`,
      rank: Math.floor(rng() * 20),
      betaId: betaIdMap[i - 1],
      oneBetaId: oneBetaIdMap[i - 1],
    });
    alphaInstances.push(row);
    alphas.push({
      id: row.get("id") as number,
      name: `a${i}`,
      rank: row.get("rank") as number,
      betaId: betaIdMap[i - 1],
      oneBetaId: oneBetaIdMap[i - 1],
    });
  }

  // ---- Beta.alphaId (belongsTo Alpha "toA", inverse of Alpha.manyB) ----
  //   first 2 betas: null, next 4 each point to a distinct alpha, remaining share some
  const alphaIdMap: (number | null)[] = [
    null, null,
    alphas[0].id, alphas[1].id, alphas[2].id, alphas[3].id,
    alphas[0].id, alphas[1].id, alphas[4].id, alphas[5].id,
    null, alphas[6].id,
  ];

  // Beta.oneAlphaId (Alpha.oneB hasOne Beta):
  //   unique or null — first 6 get one each, rest null
  const oneAlphaIdMap: (number | null)[] = [
    alphas[0].id, alphas[1].id, alphas[2].id, alphas[3].id, alphas[4].id, alphas[5].id,
    null, null, null, null, null, null,
  ];

  for (let i = 0; i < N; i++) {
    // Update beta rows in-place with FK values
    betas[i].alphaId = alphaIdMap[i];
    betas[i].oneAlphaId = oneAlphaIdMap[i];
    // Update in DB via raw model (Sequelize doesn't expose .update on a created row easily,
    // so we just create them correctly; but we already created them with null. We need
    // to use a raw update.)
  }

  // Update beta rows with Alpha FKs using the Sequelize instance methods.
  for (let i = 0; i < N; i++) {
    if (alphaIdMap[i] !== null || oneAlphaIdMap[i] !== null) {
      if (alphaIdMap[i] !== null) betaInstances[i].alphaId = alphaIdMap[i];
      if (oneAlphaIdMap[i] !== null) betaInstances[i].oneAlphaId = oneAlphaIdMap[i];
      await betaInstances[i].save();
    }
  }

  // ---- BelongsToMany links ----
  // Guarantee some alphas with 0, 1, and multiple linked betas (and vice versa).
  const linkPairs: [number, number][] = [
    // alpha index -> beta index (0-based)
    [0, 0], [0, 1], [0, 2],   // a1 -> b1,b2,b3 (multiple)
    [1, 3],                     // a2 -> b4 (one)
    // a3: no links (zero)
    [3, 0], [3, 4],            // a4 -> b1,b5 (multiple)
    [4, 5],                     // a5 -> b6 (one)
    [5, 6], [5, 7],            // a6 -> b7,b8 (multiple)
    // a7-a12: no links
    [6, 8],                     // a7 -> b9 (one)
    [7, 9], [7, 10],           // a8 -> b10,b11 (multiple)
    // b12: no links from alpha side
  ];

  for (const [ai, bi] of linkPairs) {
    const alphaId = alphas[ai].id;
    const betaId = betas[bi].id;
    // Use Sequelize's association method to insert into the through table.
    await alphaInstances[ai].addLinkB(betaInstances[bi]);
    links.push({alphaId, betaId});
  }

  return {alphas, betas, links};
}
