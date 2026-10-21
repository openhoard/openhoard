import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/.turbo/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // T-1406: the core imports no model client and no enricher. Model calls happen in the
  // ai/enrich steps (and the server's find tool); text extraction runs through them too.
  {
    files: ["core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@openhoard/ai-*", "@openhoard/enricher-*"],
              message:
                "core/* imports no model client and no enricher (T-1406): put the step in ai/enrich.",
            },
          ],
        },
      ],
    },
  },
  // The admin web app runs in a browser.
  {
    files: ["apps/web/src/**"],
    languageOptions: { globals: { ...globals.browser } },
  },
  prettier,
);
