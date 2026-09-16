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

## Street regions

Every street carries a `region`: the name of the municipality it lies in, taken from the
`admin_level=8` boundary relations (`type=boundary`, `boundary=administrative`, with a `name`)
found in the input. The outer ways of each relation are stitched into rings by their endpoint
nodes. Every highway way is then assigned the municipality its middle node (by index) falls in;
when that node falls into several polygons the smallest one wins. A long way that crosses a
boundary is not split: it counts as a whole for the municipality of its middle node.

Streets are grouped by name **and** municipality, so a name that exists in several towns of the
extract yields one street entry per town, each with its own centre, alternative names and
junctions. A street that keeps its name across a municipal boundary is not listed as a corner
of itself. Streets outside every municipality have no region (`null` in the compact output).
Streets are sorted by name, then by region, with English collation (`Intl.Collator('en')`) so
that the ids are the same on every machine.

Municipalities at the edge of the extract are never complete: Overpass (`(node;<;)`) and
`osmium extract` return only the boundary ways that have nodes inside the bounding box and do
not complete relations, so an open chain of outer ways is the normal case there. Such a chain
is closed with a straight segment from its last to its first node. When that segment would
cross the chain (a self-intersecting ring, whose parts the even-odd test would flip), the
concave hull of the chain's nodes is used instead. Either way the polygon is only approximate
where the boundary was clipped. A relation whose outer ways yield no polygon at all falls back
to the concave hull of all their nodes.

## Config

Please consult `src/config.js` for a list of whitelisted types that will be included in the resulting file. See Usage on information on how to override these values.
