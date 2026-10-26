// The accessibility lint of the client (roadmap M24): eslint-plugin-jsx-a11y over every .tsx under src/.
//
//   npx eslint                     (needs the devDependencies eslint, typescript-eslint and eslint-plugin-jsx-a11y)
//
// The shell, the UI primitives and the screens rebuilt on them (the "foundation" files below) must stay clean: their rules are
// errors. Screens not yet moved to the primitives are reported as warnings, so the lint can run in CI from day one and each
// track sees its own debt without the whole build turning red; a track turns a file into an error by adding it to FOUNDATION.
// Type checking is tsc's job (npm run lint), not this file's.
import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';

const FOUNDATION = [
  'src/App.tsx',
  'src/components/Layout.tsx',
  'src/components/Samples.tsx',
  'src/components/Inbox.tsx',
  'src/components/DataGrid.tsx',
  'src/components/ui/**/*.tsx',
  'src/components/shell/**/*.tsx',
];

// The plugin's recommended set, with its own options; only the level of the rules it switches on is changed.
const a11yRules = (level) => Object.fromEntries(Object.entries(jsxA11y.flatConfigs.recommended.rules).map(([rule, setting]) => {
  const [current, ...options] = Array.isArray(setting) ? setting : [setting];
  return [rule, current === 'off' || current === 0 ? 'off' : [level, ...options]];
}));

export default [
  { ignores: ['dist/**', 'dist-server/**', 'release/**', 'node_modules/**', 'src/server/**', 'src/db/**'] },
  {
    files: ['src/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    plugins: { 'jsx-a11y': jsxA11y },
    settings: { 'jsx-a11y': { components: { Button: 'button', IconButton: 'button' } } },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: a11yRules('warn'),
  },
  {
    files: FOUNDATION,
    rules: {
      ...a11yRules('error'),
      // A dialog's own container takes the focus (tabIndex -1) and handles Tab and Esc for the focus trap: that is the pattern.
      'jsx-a11y/no-noninteractive-element-interactions': ['error', { handlers: ['onClick', 'onMouseDown', 'onMouseUp', 'onKeyPress'] }],
      'jsx-a11y/no-noninteractive-tabindex': ['error', { roles: ['dialog', 'alertdialog'], tags: ['main'] }],
    },
  },
];
