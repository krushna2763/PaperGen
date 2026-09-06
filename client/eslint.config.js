import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * Flat config (ESLint 10) for the React client.
 *
 * Motivated by a real incident: a ReferenceError for an undeclared variable
 * (`generating`) shipped to the browser and white-screened the app. `no-undef`
 * catches that class of bug before commit — Vite's esbuild transform does not.
 *
 * Scope: no-undef, no-unused-vars, react-hooks/rules-of-hooks,
 * react-hooks/exhaustive-deps. Kept deliberately small so every finding is
 * actionable; extend rather than silence.
 */
export default [
  // Global ignores (must be an ignores-only object to apply to every file)
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**']
  },

  // Application + test code: browser globals (React runs in the DOM)
  {
    files: ['src/**/*.{js,jsx}', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true }
      },
      globals: {
        ...globals.browser,
        ...globals.es2024
      }
    },
    plugins: {
      'react-hooks': reactHooks
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_' }
      ],
      'no-const-assign': 'error',
      'no-redeclare': 'error',

      // Hooks correctness
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },

  // Build/tooling configs run in Node, not the browser
  {
    files: ['vite.config.js', 'tailwind.config.js', 'postcss.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2024
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_' }
      ]
    }
  }
];
