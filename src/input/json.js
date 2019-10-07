const debug = require('debug')('osm-search-data-export');
const fs = require('fs');

function jsonInput({ inPath }) {
  return async function({ onItem, onComplete }) {
    debug('Parsing JSON file');

    if (!fs.existsSync(inPath)) {
      throw new Error("Invalid JSON input filename");
    }

    let items = null;

    try {
      items = JSON.parse(fs.readFileSync(inPath));
    } catch (error) {
      throw new Error("Invalid JSON input data: " + error.message);
    }

    items.forEach(onItem);
    onComplete();
  };
}

module.exports = jsonInput;
