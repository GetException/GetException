import eslint from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/coverage/**",
      "**/dist/**",
      "**/out/**",
      ".yarn/**",
      ".artifacts/**",
      "runtime/**",
      "test-results/**",
      "playwright-report/**",
      "packages/db/generated/**",
      "packages/db/generated-ingest/**",
      "apps/web/next-env.d.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    plugins: { "@stylistic": stylistic },
    rules: {
      curly: ["error", "all"],
      "@stylistic/lines-between-class-members": ["error", "always"],
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "directive", next: "*" },
        { blankLine: "any", prev: "directive", next: "directive" },
        { blankLine: "always", prev: "import", next: "*" },
        { blankLine: "any", prev: "import", next: "import" },
        {
          blankLine: "always",
          prev: "*",
          next: ["export", "function", "class"],
        },
        {
          blankLine: "always",
          prev: ["export", "function", "class", "block-like"],
          next: "*",
        },
        { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
        {
          blankLine: "any",
          prev: ["const", "let", "var"],
          next: ["const", "let", "var"],
        },
        {
          blankLine: "always",
          prev: "*",
          next: [
            "return",
            "throw",
            "if",
            "for",
            "while",
            "do",
            "switch",
            "try",
          ],
        },
      ],
    },
  },
  {
    files: ["apps/web/src/components/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Program > :matches(ExportNamedDeclaration[exportKind='value'], ExportDefaultDeclaration) ~ :matches(ExportNamedDeclaration[exportKind='value'], ExportDefaultDeclaration)",
          message:
            "Keep one exported component per TSX file; move other components and values to their own files. Type exports are allowed.",
        },
        {
          selector:
            "ExportNamedDeclaration[exportKind='value'] > ExportSpecifier[exportKind='value'] ~ ExportSpecifier[exportKind='value']",
          message: "Export one component per TSX file.",
        },
        {
          selector: "ExportAllDeclaration[exportKind='value']",
          message: "Import components directly from their files.",
        },
      ],
    },
  },
];
