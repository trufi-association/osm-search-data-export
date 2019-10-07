const debug = require('debug')('osm-search-data-export');
const fs = require('fs');

function jsonCompactOutput({ outPath }) {
  if (!fs.existsSync(outPath)) {
    throw new Error("Invalid JSON compact output path");
  }

  return function ({ pois, streets, streetJunctions }) {
    const mappedPois = pois.map(poi => [
      poi.name,
      poi.alternativeNames,
      poi.localizedNames,
      poi.coordinates,
      poi.address,
      poi.type
    ]);

    const mappedStreets = {};
    Object.keys(streets).forEach(key => {
      const street = streets[key];
      mappedStreets[key] = [
        street.name,
        street.alternativeNames,
        street.coordinates,
        street.region,
      ];
    });

    const mappedStreetJunctions = {};
    Object.keys(streetJunctions).forEach(key => {
      mappedStreetJunctions[key] = streetJunctions[key].map(streetJunction => [
        streetJunction.streetRef,
        streetJunction.coordinates,
      ]);
    });

    const data = {
      _version: '3.1',
      _fields: {
        pois: ['name', 'alternativeNames', 'localizedNames', 'coordinates', 'address', 'type'],
        streets: ['name', 'alternativeNames', 'coordinates', 'region'],
        streetJunctions: ['streetRef', 'coordinates']
      },
      pois: mappedPois,
      streets: mappedStreets,
      streetJunctions: mappedStreetJunctions,
    };

    debug("Writing JSON file");
    fs.writeFileSync(outPath, JSON.stringify(data));
  };
}

module.exports = jsonCompactOutput;
