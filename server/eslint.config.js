import globals from 'globals';

/**
 * Flat config (ESLint 10) for the Express server (ES modules, Node runtime).
 *
 * Motivated by the client incident class: an undefined-variable ReferenceError
 * crashed the app at runtime while the build tool stayed silent. `no-undef`
 * catches it before commit.
 *
 * Scope: no-undef, no-unused-vars, plus const-assign/redeclare sanity rules.
 */
export default [
  {
    ignores: ['node_modules/**', 'coverage/**']
  },
  {
    files: ['src/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
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
      ],
      'no-const-assign': 'error',
      'no-redeclare': 'error'
    }
  }
];
