import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { files: ["desktop/**/*.cjs"], rules: { "@typescript-eslint/no-require-imports": "off" } },
  {
    ignores: [
      ".next/**",
      "desktop-resources/**",
      "release/**",
      ".desktop-cache/**",
      "vendor/**",
      ".next-dev/**",
      ".test-dist/**",
      "data/auto-runs/**",
      "data/mini-venv/**",
      "next-env.d.ts",
      "node_modules/**",
    ],
  },
];

export default eslintConfig;
