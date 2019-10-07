const debug = require('debug')('osm-search-data-export');
const fs = require('fs');
const parseOSM = require('osm-pbf-parser');
const through = require('through2');

function pbfInput({ inPath }) {
  return function ({ onItem, onComplete }) {
    if (!fs.existsSync(inPath)) {
      throw new Error("Invalid PBF input filename");
    }

    debug('Parsing PBF file');

    fs.createReadStream(inPath)
      .pipe(parseOSM())
      .pipe(through.obj((items, enc, next) => {
        items.forEach(onItem);
        next();
      }))
      .on('finish', () => onComplete());
  };
}

module.exports = pbfInput;
