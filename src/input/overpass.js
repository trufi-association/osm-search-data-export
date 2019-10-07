const debug = require('debug')('osm-search-data-export');
const fs = require('fs');
const queryOverpass = require('@derhuerst/query-overpass');

function overpassInput({ bbox, timeout = 300, cachePath = null }) {
  return async function({ onItem, onComplete }) {
    let result = null;

    if (cachePath != null && fs.existsSync(cachePath)) {
      debug('Using cached overpass data');
      const data = fs.readFileSync(cachePath);

      if (data) {
        result = JSON.parse(data);
      }
    }

    if (result == null) {
      debug('Querying overpass for fresh data');

      const query = `[bbox:${bbox}][out:json][timeout:${timeout}];(node;<;);out body;`;
      debug(query);

      result = queryOverpass(query)
        .then(data => {
          debug(`Received ${data.length} rows`);
          if (cachePath != null) {
            debug('Writing overpass cache');
            fs.writeFileSync(cachePath, JSON.stringify(data));
          }

          return data;
        });
    }

    result
      .then(items => items.forEach(onItem))
      .then(() => onComplete());
  };
}

module.exports = overpassInput;
