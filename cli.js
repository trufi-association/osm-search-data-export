#!/usr/bin/env node

const fs = require('fs');
const debug = require('debug')('osm-search-data-export');
const commander = require('commander');
const pkg = require('./package.json');
const exportSearchData = require('./index');

const program = new commander.Command();
program
  .name(pkg.name)
  .version(pkg.version)
  .option('--input <type>', 'input source')
  .option('--output <type>', 'output target')
  .option('--config <filename>', 'path to custom config')
  .option('--inpath <filename>', 'path to input file if applicable')
  .option('--outpath <filename>', 'path to output file if applicable')
  .option('--cachepath <filename>', 'path to cache file used for overpass input')
  .option('--bbox <value>', 'bounding box, comma separated floating values in order left, bottom, right top')
  .option('--timeout <seconds>', 'timeout for overpass query')
  .on('--help', () => {
    console.log('');
    console.log('Input types:');
    console.log('  json - JSON file that holds an array of OSM objects');
    console.log('  overpass - Fetch OSM data from Overpass using a bounding box');
    console.log('  pbf - Fetch OSM data from a PBF export file');
    console.log('');
    console.log('Output types:');
    console.log('  json - Write search data to a JSON file');
    console.log('  json-compact - Write search data to a JSON file in a more compact style');
    console.log('  sqlite - Write search data into a SQLite db file');
    console.log('');
    console.log('Examples:');
    console.log(`  $ ${pkg.name} --input pbf --inpath data.pbf --output json --outpath search.json`)
    console.log(`  $ ${pkg.name} --input overpass --bbox -21.604769,-64.819679,-21.477032,-64.631195 --output sqlite --outpath search.db`)
  })
  .parse(process.argv);

// No params
if (program.rawArgs.length <= 2) {
  program.help();
  return 1;
}

try {
  let input;
  let output;
  let userConfig;

  switch (program.input) {
    case 'json':
      debug("Using JSON file input");
      input = require('./src/input/json')({
        inPath: program.inpath,
      });
      break;

    case 'memory':
      throw new Error('Memory input is not supported in CLI');

    case 'overpass':
      debug("Using Overpass input");
      input = require('./src/input/overpass')({
        bbox: program.bbox,
        cachePath: program.cachepath,
        timeout: program.timeout,
      });
      break;

    case 'pbf':
      debug("Using PBF file input");
      input = require('./src/input/pbf')({
        inPath: program.inpath,
      });
      break;

    default:
      throw new Error('Unknown input');
  }

  switch (program.output) {
    case 'json':
      debug("Using JSON file output");
      output = require('./src/output/json')({
        outPath: program.outpath,
      });
      break;

    case 'json-compact':
      debug("Using JSON compact file output");
      output = require('./src/output/json-compact')({
        outPath: program.outpath,
      });
      break;

    case 'memory':
      throw new Error('Memory output is not supported in CLI');

    case 'nulti':
      throw new Error('Multi output is not supported in CLI');

    case 'sqlite':
      debug("Using SQLite file output");
      output = require('./src/output/sqlite')({
        outPath: program.outpath,
      });
      break;

    default:
      throw new Error('Unknown output');
  }

  if (program.config) {
    if (!fs.existsSync(program.config)) {
      throw new Error('Unknown config path');
    }

    try {
      userConfig = JSON.parse(fs.readFileSync(program.config));
    } catch (error) {
      throw new Error("Could not parse config");
    }
  }

  // Run!
  exportSearchData(input, output, userConfig);

} catch (error) {
  console.log(`${pkg.name}: ${error.message}`);
  console.log(`Try '${pkg.name} --help' for more information.`);
  return 1;
}
