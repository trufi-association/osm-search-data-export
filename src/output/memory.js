const debug = require('debug')('osm-search-data-export');

function memoryOutput({ outRef }) {
  return function (data) {
    debug("Writing data in-memory variable");
    Object.assign(outRef, data);
  };
}

module.exports = memoryOutput;
