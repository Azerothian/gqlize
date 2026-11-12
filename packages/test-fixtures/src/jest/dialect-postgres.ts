// Jest `setupFiles` entry for a project that runs its suites on Postgres,
// through PGlite — see `../dialect`.
process.env.TEST_DIALECT = "postgres";
