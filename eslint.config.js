import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default defineConfig(
  {
    ignores: ["dist/", "coverage/", ".kikimora/", "node_modules/", "scripts/"],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js", "tsup.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },
  {
    files: ["test/**"],
    rules: {
      "@typescript-eslint/no-dynamic-delete": "off",
    },
  },
  {
    files: ["src/ui/**", "test/ui/**"],
    extends: [reactHooks.configs.flat.recommended],
  },
  prettier,
);
