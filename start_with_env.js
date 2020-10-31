const searchDataExport = require('.');
const {
    overpassInput,
    multiOutput,
    jsonOutput,
    jsonCompactOutput,
    sqliteOutput
} = searchDataExport;

searchDataExport(
    // Get fresh data from Overpass API
    overpassInput({ bbox: `${process.env.SOUTH_BOUND},${process.env.WEST_BOUND},${process.env.NORTH_BOUND},${process.env.EAST_BOUND}` }),
    multiOutput(
        jsonOutput({ outPath: './out/search.json' }),
        jsonCompactOutput({ outPath: './out/search-compact.json' }),
        // sqliteOutput({ outPath: './out/search.db' }),
    ),
);