// Accessibility lint of the client: every rule of jsx-a11y's recommended set is an error (E05#2).
import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'server/**', 'tests/**', 'migrations/**', '*.config.*', 'client/public/**'] },
  { ...jsxA11y.flatConfigs.strict, files: ['client/**/*.tsx'], languageOptions: { ...jsxA11y.flatConfigs.strict.languageOptions, parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } } },
];
