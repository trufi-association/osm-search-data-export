const searchDataExport = require('./index');
const {
  overpassInput,
  multiOutput,
  jsonOutput,
  jsonCompactOutput,
  sqliteOutput
} = searchDataExport;

searchDataExport(
  // Get fresh data from Overpass API
  overpassInput({ bbox: '-21.604769,-64.819679,-21.477032,-64.631195' }), // Tarija
  // Chain multiple outputs using multiOutput. Typically this will only be one output.
  multiOutput(
    jsonOutput({ outPath: './search.json'}),
    jsonCompactOutput({ outPath: './search-compact.json'}),
    sqliteOutput({ outPath: './search.db' }),
  ),
);
