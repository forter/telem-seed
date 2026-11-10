'use strict';

const sharedRequire = [
  'test/telem/support/**/*.ts',
  'test/telem/step-definitions/**/*.ts',
];

module.exports = {
  default: {
    paths: ['test/telem/features/**/*.feature'],
    requireModule: ['tsx/cjs'],
    require: sharedRequire,
    format: ['progress-bar'],
  },
  ci: {
    paths: ['test/telem/features/**/*.feature'],
    requireModule: ['tsx/cjs'],
    require: sharedRequire,
    format: ['junit:output/bdd-tests-out.xml'],
  },
  coverage: {
    paths: ['test/telem/features/**/*.feature'],
    requireModule: ['tsx/cjs'],
    require: sharedRequire,
  },
  // Used by telem-bdd run-flag-permutations — paths and FLAG_PERMUTATION are set per-run.
  permutation: {
    paths: [],
    requireModule: ['tsx/cjs'],
    require: sharedRequire,
    format: ['junit:output/bdd-permutation-out.xml'],
    forceExit: true,
  },
};
