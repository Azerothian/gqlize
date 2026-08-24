import js from "@eslint/js";
import jest from "eslint-plugin-jest";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * The repo's lint layer.
 *
 * Scoped deliberately. `tsc` already runs over every file with `strict` and
 * `noUnusedLocals`, so anything the compiler catches has no business being a
 * lint rule as well. What is left is the class of defect a type system
 * structurally cannot see — a promise nobody awaited, an `async` handler passed
 * where a `void` callback was expected — which is why the type-aware layer is
 * the point of this config rather than an optional extra. In a codebase this
 * full of async resolvers, adapter round trips and Temporal activities, a
 * floating promise is a swallowed error and an unhandled rejection.
 *
 * Nothing stylistic is enabled. There is no prettier here and no formatting
 * rule: reformatting 17.5k lines to settle an argument nobody has had would
 * bury the history for no correctness gain.
 */

/** Generated, vendored, or owned by another toolchain. */
const IGNORES = [
  "**/publish/**",
  "**/lib/**",
  "**/cjs/**",
  "**/coverage/**",
  "**/.yalc/**",
  "**/node_modules/**",
  "**/*.d.ts",
  // Their own workspace members, on their own TypeScript, outside the published
  // surface — and not wired into any turbo task yet either. Worth linting once
  // they are in CI at all.
  "examples/**",
  // Deliberately outside every tsconfig program: these assert that certain
  // definitions *fail* to typecheck, so a type-aware pass cannot read them.
  "**/__tests__/types/**",
];

/**
 * Rules from `recommendedTypeChecked` that this repo does not enforce.
 *
 * Two reasons, and it is worth keeping them apart. The `no-unsafe-*` family is
 * declined on the merits: values crossing the ORM boundary are `any` by
 * construction, so those rules fire in the hundreds on code that is doing the
 * only thing it can, and satisfying them would mean mass-casting — strictly
 * worse than the `any` it replaces. The rest are narrower judgement calls noted
 * inline.
 */
const DECLINED = {
  "@typescript-eslint/no-unsafe-argument": "off",
  "@typescript-eslint/no-unsafe-assignment": "off",
  "@typescript-eslint/no-unsafe-call": "off",
  "@typescript-eslint/no-unsafe-member-access": "off",
  "@typescript-eslint/no-unsafe-return": "off",

  // `tsc`'s `noUnusedLocals` already covers the locals, and the two disagree
  // about parameters — which the compiler is deliberately not configured to
  // flag, because an unused parameter is usually positional and load-bearing.
  "@typescript-eslint/no-unused-vars": "off",
  "no-unused-vars": "off",

  // `x?: string | undefined` is redundant only until `exactOptionalPropertyTypes`
  // is turned on, at which point it stops being. Writing it out is a deliberate
  // note about which optionals accept an explicit `undefined`.
  "@typescript-eslint/no-redundant-type-constituents": "off",
  "@typescript-eslint/no-duplicate-type-constituents": "off",

  // Marker and brand interfaces are part of the published typesystem surface;
  // `object` is not the same declaration and would be a breaking change.
  "@typescript-eslint/no-empty-object-type": "off",

  // The repo's single `@ts-ignore` carries its own explanation next to it.
  "@typescript-eslint/ban-ts-comment": "off",
};

/**
 * Rules that report something worth a human look but that nobody should be
 * blocked on today. The root `lint` script caps the total with `--max-warnings`
 * at whatever it is now, which makes it a ratchet: the number can only be
 * lowered, and a change that adds a warning has to remove one first.
 *
 * `no-explicit-any` is ~1150 of them and is the honest state of the ported
 * v5-era code. `require-await` is ~60 and is mostly structural: an `async`
 * method that satisfies a `Promise`-returning interface has to be `async`
 * whether or not its body awaits, and dropping the keyword would change the
 * declared return type. `await-thenable` and `no-base-to-string` are a dozen
 * between them and each one needs reading before it is touched.
 */
const WATCHED = {
  "@typescript-eslint/no-explicit-any": "warn",
  "@typescript-eslint/require-await": "warn",
  "@typescript-eslint/await-thenable": "warn",
  "@typescript-eslint/no-base-to-string": "warn",
  "@typescript-eslint/restrict-template-expressions": "warn",
  "@typescript-eslint/no-unsafe-enum-comparison": "warn",
  "@typescript-eslint/no-this-alias": "warn",
};

export default tseslint.config(
  {ignores: IGNORES},

  {
    linterOptions: {
      // The repo carries `eslint-disable` comments from an airbnb-era config,
      // naming rules this one does not enable. Reporting those as unused invites
      // `--fix` to delete comments that document a deliberate choice, so the
      // check is off and stale directives are cleaned by hand.
      reportUnusedDisableDirectives: "off",
    },
  },

  // Plain JS: jest configs, build scripts, this file. Syntax-only — there is no
  // tsconfig that would give any of them types.
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: {globals: {...globals.node}},
    rules: {"@typescript-eslint/no-require-imports": "off"},
  },

  // The typed layer. `project` names the *test* programs on purpose: each one is
  // `src/**` plus `__tests__/**`, so one glob covers everything worth linting and
  // the tests get the same type information the source does.
  {
    files: ["packages/*/{src,__tests__}/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: {...globals.node},
      parserOptions: {
        project: ["packages/*/tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname + "/../..",
      },
    },
    rules: {
      ...DECLINED,
      ...WATCHED,

      // The two this config exists for.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // A library writing to the process's stdout is writing to someone else's
      // log. The three deliberate `log.warn` seams carry an inline disable, which
      // is what makes them visible as decisions.
      "no-console": "error",

      // A thrown non-Error arrives at the caller with no stack.
      "@typescript-eslint/only-throw-error": "error",
    },
  },

  // Package-local build and bench scripts. No tsconfig covers them, so this is
  // the TypeScript parser without type information — enough for the base JS
  // rules, which is all they need.
  {
    files: ["packages/*/scripts/**/*.ts", "scripts/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {globals: {...globals.node}},
    rules: {...DECLINED, "@typescript-eslint/no-explicit-any": "warn", "no-console": "off"},
  },

  // The CLI is the one place stdout is the product rather than a side effect.
  {
    files: ["packages/*/src/cli/**/*.ts"],
    rules: {"no-console": "off"},
  },

  // Test files: the jest plugin's correctness rules only, not its style rules.
  // A suite that says `expect(x).toBe(true)` rather than `toBeTruthy()` is not a
  // defect, and the existing 900-odd tests would all have an opinion.
  {
    files: ["packages/*/__tests__/**/*.{ts,tsx}"],
    plugins: {jest},
    languageOptions: {globals: {...globals.jest}},
    rules: {
      // A `.only` left behind silently stops CI running the rest of the file —
      // this layer's own failure mode, in test form.
      "jest/no-focused-tests": "error",
      "jest/no-identical-title": "error",
      "jest/no-standalone-expect": "error",
      "jest/valid-expect": "error",
      // A test harness prints to the terminal for a living, and a fixture that
      // picks its dialect at runtime has to `require` it.
      "no-console": "off",
      "@typescript-eslint/no-require-imports": "off",
      // An assertion reached only on one branch passes vacuously on the other.
      "jest/no-conditional-expect": "warn",
      // A test that asserts nothing passes forever.
      "jest/expect-expect": ["warn", {assertFunctionNames: ["expect", "expect*"]}],
    },
  },
);
