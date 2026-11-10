module.exports = {
  outputDir: 'test/telem/coverage',
  reports: ['v8', 'console-details', 'json'],
  // Exclude node_modules — MCR can't parse some minified CJS files there (e.g. tsx's register shim)
  entryFilter: (entry) => !entry.url.includes('node_modules'),
};
