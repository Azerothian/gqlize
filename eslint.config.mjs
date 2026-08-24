// The config lives in `tools/lint` so that typescript-eslint resolves its
// `typescript` peer from there — see that package's manifest for why the linter
// runs on a different TypeScript than the build.
export {default} from "@gqlize/lint";
