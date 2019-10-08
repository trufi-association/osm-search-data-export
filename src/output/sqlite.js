const debug = require('debug')('osm-search-data-export');
const fs = require('fs')
const path = require('path');
const Database = require('better-sqlite3');

function sqliteOutput({ outPath }) {
  return function ({ pois, streets, streetJunctions }) {
    if (!fs.existsSync(path.dirname(outPath))) {
      throw new Error("Invalid SQLite output path");
    }

    if (fs.existsSync(outPath)) {
      fs.unlinkSync(outPath);
    }

    const db = new Database(outPath, { verbose: debug });

    db.exec(`
      CREATE TABLE pois (
        id      INTEGER PRIMARY KEY,
        name    TEXT,
        lat     REAL,
        lng     REAL,
        address TEXT,
        type    TEXT
      );

      CREATE TABLE poi_altnames (
        poi  INTEGER,
        name TEXT,
        FOREIGN KEY (poi) REFERENCES pois(id)
      );

      CREATE INDEX "poi_altnames-name" ON poi_altnames (name ASC);

      CREATE TABLE poi_locnames (
        poi    INTEGER,
        name   TEXT,
        locale TEXT,
        FOREIGN KEY (poi) REFERENCES pois(id)
      );

      CREATE INDEX "poi_locnames-locale-name" ON poi_locnames (locale ASC, name ASC);

      CREATE TABLE streets (
        id     INTEGER PRIMARY KEY,
        name   TEXT,
        lat    REAL,
        lng    REAL,
        region TEXT
      );

      CREATE TABLE street_altnames (
        street INTEGER,
        name   TEXT,
        FOREIGN KEY (street) REFERENCES streets(id)
      );

      CREATE INDEX "street_altnames-name" ON street_altnames (name ASC);

      CREATE TABLE street_junctions (
        street1 INTEGER,
        street2 INTEGER,
        lat     REAL,
        lng     REAL,
        FOREIGN KEY (street1) REFERENCES streets(id),
        FOREIGN KEY (street2) REFERENCES streets(id)
      );

      CREATE VIEW search_pois AS
        SELECT search_string, name AS title, address AS subtitle, alternative, locale, type, lat, lng
        FROM (
          SELECT id, name AS search_string, name, 0 AS alternative, NULL AS locale, lat, lng, address, type
          FROM pois

          UNION

          SELECT id, poi_altnames.name AS search_string, pois.name, 1 AS alternative, NULL AS locale, lat, lng, address, type
          FROM poi_altnames
          INNER JOIN pois ON poi_altnames.poi=pois.id

          UNION

          SELECT id, poi_locnames.name AS search_string, pois.name, 1 AS alternative, locale, lat, lng, address, type
          FROM poi_locnames
          INNER JOIN pois ON poi_locnames.poi=pois.id
        ) AS tmp

        GROUP BY id, search_string
        ORDER BY name ASC;

      CREATE VIEW search_streets AS
        SELECT search_string, name AS title, NULL AS subtitle, alternative, lat, lng
        FROM (
          SELECT id, name AS search_string, name, 0 AS alternative, lat, lng
          FROM streets

          UNION

          SELECT id, street_altnames.name AS search_string, streets.name, 1 AS alternative, lat, lng
          FROM street_altnames
          INNER JOIN streets ON street_altnames.street=streets.id
        ) AS tmp

        GROUP BY id, search_string
        ORDER BY name ASC;

      CREATE VIEW search_all AS
        SELECT "poi" AS category, search_string, title, subtitle, alternative, locale, type, lat, lng
        FROM search_pois

        UNION

        SELECT "street" AS category, search_string, title, subtitle, alternative, NULL AS locale, NULL as type, lat, lng
        FROM search_streets

        ORDER BY title, subtitle;
    `);

    const poiStmt = db.prepare("INSERT INTO pois VALUES (?, ?, ?, ?, ?, ?)");
    const poiAltStmt = db.prepare("INSERT INTO poi_altnames VALUES (?, ?)");
    const poiLocStmt = db.prepare("INSERT INTO poi_locnames VALUES (?, ?, ?)");

    pois.forEach((poi, id) => {
      poiStmt.run(
        id,
        poi.name,
        poi.coordinates[1],
        poi.coordinates[0],
        poi.address,
        poi.type
      );

      poi.alternativeNames
        .forEach(altName => poiAltStmt.run(id, altName));

      Object.keys(poi.localizedNames)
        .forEach(loc => poiLocStmt.run(id, poi.localizedNames[loc], loc));
    });

    const streetStmt = db.prepare("INSERT INTO streets VALUES (?, ?, ?, ?, ?)");
    const streetAltStmt = db.prepare("INSERT INTO street_altnames VALUES (?, ?)");

    Object.keys(streets).forEach(id => {
      const street = streets[id];
      const numericId = id.substr(1);

      streetStmt.run(
        numericId,
        street.name,
        street.coordinates[1],
        street.coordinates[0],
        street.region,
      );

      street.alternativeNames
        .forEach(altName => streetAltStmt.run(numericId, altName));
    });

    streetJunctionStmt = db.prepare("INSERT INTO street_junctions VALUES (?, ?, ?, ?)");

    Object.keys(streetJunctions).forEach(streetRef => {
      streetJunctions[streetRef].forEach(junction => {
        streetJunctionStmt.run(
          streetRef.substr(1),
          junction.streetRef.substr(1),
          junction.coordinates[1],
          junction.coordinates[0]
        );
      });
    });

    db.close();
  };
}

module.exports = sqliteOutput;
