const debug = require('debug')('osm-search-data-export');
const fs = require('fs');

function jsonOutput({ outPath }) {
  if (!fs.existsSync(outPath)) {
    throw new Error("Invalid JSON output path");
  }

  return function (data) {
    debug("Writing JSON file");
    fs.writeFileSync(outPath, JSON.stringify(data));
  };
}

module.exports = jsonOutput;
