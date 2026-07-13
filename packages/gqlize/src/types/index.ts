// Re-export barrel: the shared type surface now lives in
// @azerothian/gqlize-shared. Kept here to preserve the public
// `@azerothian/gqlize/types/index` subpath (used by external adapters) and
// internal `../types` imports across the core package.
export * from "@azerothian/gqlize-shared/types/index";
