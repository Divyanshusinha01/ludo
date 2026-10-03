import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  {
    files: ["convex/lib/game/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "../../_generated/server",
              message: "Pure game module must not import Convex server.",
            },
            {
              name: "../_generated/server",
              message: "Pure game module must not import Convex server.",
            },
          ],
          patterns: ["**/_generated/**", "convex/server"],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date']",
          message: "No Date in pure game reducer.",
        },
        {
          selector:
            "MemberExpression[object.name='Math'][property.name='random']",
          message: "No Math.random in pure game reducer.",
        },
      ],
    },
  },
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Convex codegen — not hand-edited
    "convex/_generated/**",
  ]),
]);

export default eslintConfig;
