const debug = require('debug')('osm-search-data-export');

function readMemory({ data }) {
  return function ({ onItem, onComplete }) {
    debug('Iterating over in-memory items');
    data.forEach(onItem);
    onComplete();
  };
}

module.exports = readMemory;
