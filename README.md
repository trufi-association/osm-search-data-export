# osm-search-data-export

A library for Node.js to generate offline search data for use in a public transport app.

[![NPM version](https://img.shields.io/npm/v/osm-search-data-export.svg?style=flat)](https://www.npmjs.com/package/osm-search-data-export)
[![Package dependencies](https://img.shields.io/david/trufi-association/osm-search-data-export.svg)](https://david-dm.org/trufi-association/osm-search-data-export)
[![GitHub license](https://img.shields.io/github/license/trufi-association/osm-search-data-export.svg)](https://github.com/trufi-association/osm-search-data-export/blob/master/LICENSE)

## Motivation

This project is part of a set of tools to provide travel data in countries where public transport works on demand and neither bus stops nor timetables exist. Check out https://github.com/trufi-association

## Usage

### Node.js

```js
const searchDataExport = require('osm-search-data-export');
const {
  pbfInput,
  overpassInput,
  memoryInput,
  multiOutput,
  jsonOutput,
  jsonCompactOutput,
  sqliteOutput,
  memoryOutput,
} = searchDataExport;

// Read from PBF and output as compact JSON
searchDataExport(
  pbfInput({ inPath: './data.pbf' }),
  jsonCompactOutput({ outPath: './search-compact.json'})
);

// Get fresh data from Overpass API and output into JSON and SQLite
searchDataExport(
  overpassInput({ bbox: '-21.604769,-64.819679,-21.477032,-64.631195' }), // Tarija
  multiOutput(
    jsonOutput({ outPath: './search.json'}),
    sqliteOutput({ outPath: './search.db' }),
    jsonCompactOutput({ outPath: './search-compact.json'}),
  )
);

// Transform data without the file system and use a custom config to control included objects
const result = {};
const myConfig = {
  // Only include certain POIs
  poiTypeTags: [
    'amenity',
    'shop',
  ],
  // Only include motorways
  pathTypes: [
    'motorway',
  ],
};
searchDataExport(
  memoryInput({ data: [ /* ... */ ]}),
  memoryOutput({ outRef: result }),
  myConfig
);
```

### CLI

```sh
$ node cli.js --input pbf --inpath data.pbf --output json --outpath search.json
; Wrote to file search.json
```

```sh
$ node cli.js --input overpass --bbox -21.604769,-64.819679,-21.477032,-64.631195 --output sqlite --outpath search.db
; Wrote to file search.db
```

Run `node cli.js --help` for more details.

### Docker

```sh
docker build . --tag osm-search-data-export:latest

docker run --volume /tmp:/data osm-search-data-export \
  --input overpass --bbox "-21.604769,-64.819679,-21.477032,-64.631195" \
  --output json-compact --outpath /data/search.json
           
; Wrote to file /tmp/search.json
```

## Input types

* json - JSON file that holds an array of OSM objects
* overpass - Fetch OSM data from Overpass using a bounding box
* pbf - OSM data in PBF export file
* memory - Use data from a local variable

## Output types

* json - Write search data to a JSON file
* json-compact - Write search data to a JSON file in a more compact style - **this is the style required by Trufi-Core based apps for the `search.json`**
* sqlite - Write search data into a SQLite db file');
* memory - Write data into a local variable
* multi - Wraps multiple outputs

## Config

Please consult `src/config.js` for a list of whitelisted types that will be included in the resulting file. See Usage on information on how to override these values.
