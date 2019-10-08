const debug = require('debug')('osm-search-data-export');
const fs = require('fs');
const path = require('path');

function jsonOutput({ outPath }) {
  if (!fs.existsSync(path.dirname(outPath))) {
    throw new Error("Invalid JSON output path");
  }

  return function (data) {
    debug("Writing JSON file");
    fs.writeFileSync(outPath, JSON.stringify(data));
  };
}

module.exports = jsonOutput;
