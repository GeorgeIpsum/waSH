import react from "@tilli-pro/eslint-config/react-internal.mjs";

export default [
  ...react,
  {
    languageOptions: {
      parserOptions: {
        EXPERIMENTAL_useProjectService: true,
      },
    },
  },
];
