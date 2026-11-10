import js from '@eslint/js';
import {defineConfig, globalIgnores} from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const unused = {argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true};
const appGlobals = Object.fromEntries([
  'DATA', 'Learning', 'accountLoaded', 'answers', 'attempt', 'audio', 'autoPronounce',
  'busy', 'deck', 'deckLoaded', 'decks', 'failedOperation', 'importBusy', 'importCommit',
  'importDraft', 'importError', 'importFile', 'importPreview', 'importRecoveryNeeded',
  'importRequestId', 'importStage', 'importedDeckId', 'lastSession', 'loadError', 'playback', 'position',
  'qaAudio', 'questions', 'render', 'screen', 'searchQuery', 'selected', 'selectedWord', 'startPractice',
  'stopAudio', 'terms', 'user'
].map(name => [name, 'writable']));

export default defineConfig(
  globalIgnores([
    'node_modules/**', 'dist/**', 'data/**', 'data-backup*/**', 'backups/**',
    'artifacts/**', '.playwright-mcp/**', '.agents/**', '.aws/**', '.codex/**',
    'web/data.js'
  ]),
  {
    files: ['**/*.{js,mjs,ts}'],
    extends: [js.configs.recommended],
    rules: {'no-empty': ['error', {allowEmptyCatch: true}], 'no-unused-vars': ['error', unused]}
  },
  {
    files: ['server/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {globals: globals.node},
    rules: {'@typescript-eslint/no-unused-vars': ['error', unused]}
  },
  {
    files: ['tests/**/*.ts'],
    rules: {'@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-require-imports': 'off'}
  },
  {
    files: ['server/training.ts', 'server/imports.ts', 'server/import-worker.ts'],
    rules: {'@typescript-eslint/no-require-imports': 'off'}
  },
  {
    files: ['server/import-html.ts', 'server/import-package.ts'],
    rules: {'no-control-regex': 'off'}
  },
  {
    files: ['tests/**/*.js'],
    ignores: ['tests/*browser-check.js'],
    languageOptions: {sourceType: 'commonjs', globals: globals.node}
  },
  {files: ['*.mjs'], languageOptions: {globals: globals.node}},
  {
    files: ['web/*.js'],
    languageOptions: {sourceType: 'script', globals: {...globals.browser, screen: 'off', DATA: 'readonly', Learning: 'readonly'}}
  },
  {
    files: ['web/learning.js'],
    languageOptions: {globals: globals.node},
    rules: {'no-shadow': 'error'}
  },
  {
    files: ['tests/*browser-check.js'],
    languageOptions: {sourceType: 'script', globals: {...globals.browser, ...appGlobals}}
  }
);
