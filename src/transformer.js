const debug = require('debug')('osm-search-data-export');
const without = require('lodash.without');
const geoPoint = require('@turf/helpers').point;
const geoFeatureCollection = require('@turf/helpers').featureCollection;
const geoLineString = require('@turf/helpers').lineString;
const geoDistance = require('@turf/distance').default;
const geoAlong = require('@turf/along').default;
const geoLength = require('@turf/length').default;
const geoCenterOfMass = require('@turf/center-of-mass').default;
const geoConcave = require('@turf/concave').default;
const geoPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const intlCompare = new Intl.Collator().compare;

function getCenterCoordsOfPath(path) {
  const lineString = geoLineString(path);
  const halfLength = geoLength(lineString) / 2;
  const centerPoint = geoAlong(lineString, halfLength);
  const coords = centerPoint.geometry.coordinates;

  return coords;
}

class Transformation {
  constructor(config) {
    this.poiTypeTags = config.poiTypeTags;
    this.pathTypes = config.pathTypes;
    this.leisureTypes = config.leisureTypes;
    this.manMadeTypes = config.manMadeTypes;

    this.nodes = {};
    this.ways = {};
    this.pois = [];
    this.nodeToStreet = {};
    this.streetToNodeGroups = {};
    this.streetToNodes = {};
    this.streetsToIds = {};
    this.idsToStreets = {};
    this.streets = {};
    this.streetJunctions = {};
    this.streetAlternativeNames = {};
    this.cityPolygons = {};
  }

  addItem(item) {
    switch (item.type) {
      case 'node':
        this.processNode(item);
        break;

      case 'way':
        this.processWay(item);
        break;

      case 'relation':
        this.processRelation(item);
        break;
    }
  }

  complete() {
    debug("Flattening street node groups");
    this.flattenStreetNodeGroups();
    debug("Extracting streets");
    this.extractStreets();
    debug("Extracting street junctions");
    this.extractStreetJunctions();

    return {
      pois: this.pois,
      streets: this.streets,
      streetJunctions: this.streetJunctions,
    };
  }

  // eslint-disable-next-line complexity
  processNode(node) {
    const { tags = {}, lat, lon } = node;
    const { name } = tags;
    const coordinates = [lon, lat]; // GeoJSON order
    this.nodes[node.id] = coordinates;

    if (!tags.name) {
      return;
    }

    const alternativeNames = []
      .concat(tags.alt_name && tags.alt_name.split(';'))
      .concat([
        tags.int_name,
        tags.nat_name,
        tags.official_name,
        tags.reg_name,
        tags.short_name
      ])
      .filter(name => name != null);

    const nameLangs = Object.keys(tags)
      .filter(tag => tag.indexOf('name:') === 0)
      .map(tag => tag.substring(5));

    const localizedNames = {};

    nameLangs.forEach(lang => {
      localizedNames[lang] = tags[`name:${lang}`];
    });

    const address = (() => {
      if (tags['addr:street']) {
        if (tags['addr:housenumber']) {
          return `${tags['addr:street']} ${tags['addr:housenumber']}`;
        }

        return tags['addr:street'];
      }

      return null;
    })();

    const type = this.getPoiTypeFromTags(tags);

    this.pois.push({
      name,
      alternativeNames,
      localizedNames,
      coordinates,
      address,
      type,
    });
  }

  // eslint-disable-next-line complexity, max-statements
  processWay(way) {
    this.ways[way.id] = way;

    const { tags = {} } = way;
    const { name, alt_name: altName } = tags;
    const refs = way.refs || way.nodes;
    const alternativeNames = altName ? altName.split(';') : [];

    // For ways that run out of the bounding box, we might be
    // missing referenced nodes. Skip way in that case.
    if (refs.find(ref => !this.nodes[ref])) {
      return;
    }

    // We only list highway types as streets. Everything else will end up
    // a point of interest.
    if (this.hasSupportedStreetTags(tags)) {
      // Assign street name to node (a node can be linked to multiple streets)
      refs.forEach(ref => {
        this.nodeToStreet[ref] = this.nodeToStreet[ref] || [];

        if (this.nodeToStreet[ref].indexOf(name) === -1) {
          this.nodeToStreet[ref].push(name);
        }
      });

      // Collect all ways that belong to a street (by name)
      this.streetToNodeGroups[name] = this.streetToNodeGroups[name] || [];
      this.streetToNodeGroups[name].push(refs);

      // Save alt names
      if (alternativeNames) {
        this.streetAlternativeNames[name] = alternativeNames;
      }
    } else if (this.hasSupportedPoiTags(tags)) {
      const localizedNames = {};
      const address = null;
      const type = this.getPoiTypeFromTags(tags);
      let coordinates = null;

      // If this is a closed loop, take the center of the area as its coordinates.
      const isArea = refs[0] === refs[refs.length - 1];
      const path = refs.map(nodeId => this.nodes[nodeId]);

      if (isArea) {
        const lineString = geoLineString(path);
        coordinates = geoCenterOfMass(lineString).geometry.coordinates;
      } else {
        coordinates = getCenterCoordsOfPath(path);
      }

      this.pois.push({
        name,
        alternativeNames,
        localizedNames,
        coordinates,
        address,
        type,
      });
    }
  }

  processRelation(relation) {
    // Grab relations defining municipalities (cities)
    if (
      relation.tags &&
      relation.tags.type === 'boundary' &&
      relation.tags.boundary === 'administrative' &&
      relation.tags.admin_level === '8'
    ) {
      const name = relation.tags.name;
      const points = relation.members
        .filter(member => member.type === 'way' && member.role === 'outer')
        .map(member => this.ways[member.ref])
        .filter(way => way != null)
        .flatMap(way => way.refs || way.nodes)
        .map(ref => this.nodes[ref])
        .filter(coords => coords != null)
        .map(coords => geoPoint(coords));
      const featureCollection = geoFeatureCollection(points);
      const hull = geoConcave(featureCollection);

      if (hull !== null) {
        this.cityPolygons[name] = hull;
      }
    }
  }

  hasSupportedStreetTags(tags) {
    return tags.name && this.pathTypes.indexOf(tags.highway) >= 0;
  }

  hasSupportedPoiTags(tags) {
    if (!tags.name) {
      return false;
    }

    for (let i = 0; i < this.poiTypeTags.length; i++) {
      const tagName = this.poiTypeTags[i];
      const tagValue = tags[tagName];

      if (tags[tagName]) {
        if (tagName === 'leisure') {
          return this.leisureTypes.indexOf(tagValue) >= 0;
        }

        if (tagName === 'manMade') {
          return this.manMadeTypes.indexOf(tagValue) >= 0;
        }

        if (tagName === 'public_transport') {
          return tagValue === 'stop_position';
        }

        return true;
      }
    }

    return false;
  }

  getPoiTypeFromTags(tags) {
    for (let i = 0; i < this.poiTypeTags.length; i++) {
      const tagName = this.poiTypeTags[i];
      const tagValue = tags[tagName];

      if (tagValue) {
        return `${tagName}:${tagValue}`;
      }
    }

    return null;
  }

  // Flattens collection of ways per street by first sorting ways
  // by looking at their distance to each other.
  flattenStreetNodeGroups() {
    Object.keys(this.streetToNodeGroups)
      .forEach(street => {
        const sortedGroups = this.streetToNodeGroups[street].sort((a, b) => {
          const aFirst = geoPoint(this.nodes[a[0]]);
          const aLast = geoPoint(this.nodes[a[a.length - 1]]);
          const bFirst = geoPoint(this.nodes[b[0]]);
          const bLast = geoPoint(this.nodes[b[b.length - 1]]);
          const abDistance = geoDistance(aLast, bFirst);
          const baDistance = geoDistance(bLast, aFirst);

          if (abDistance < baDistance) {
            return -1;
          }
          if (abDistance > baDistance) {
            return 1;
          }
          return 0;
        });

        this.streetToNodes[street] = sortedGroups.flat();
      });
  }

  extractStreets() {
    let i = 1;

    Object.keys(this.streetToNodes)
      .sort(intlCompare)
      .forEach(street => {
        const id = `s${i++}`;
        this.streetsToIds[street] = id;
        this.idsToStreets[id] = street;

        const alternativeNames = this.streetAlternativeNames[street] || [];
        const path = this.streetToNodes[street].map(nodeId => this.nodes[nodeId]);
        const coordinates = getCenterCoordsOfPath(path);
        const centerPoint = geoPoint(coordinates);
        const region = Object.keys(this.cityPolygons).find(name => {
          const polygon = this.cityPolygons[name];
          return geoPointInPolygon(centerPoint, polygon);
        });

        this.streets[id] = {
          name: street,
          alternativeNames,
          coordinates,
          region,
        };
      });
  }

  extractStreetJunctions() {
    Object.keys(this.nodeToStreet)
      .forEach(nodeId => {
        if (this.nodeToStreet[nodeId].length > 1) {
          this.nodeToStreet[nodeId].forEach(street => {
            const streetId = this.streetsToIds[street];

            this.streetJunctions[streetId] = this.streetJunctions[streetId] || [];

            const existingStreetNames = this.streetJunctions[streetId]
              .map(entry => this.idsToStreets[entry.streetRef]);

            const streetObjs = without(this.nodeToStreet[nodeId], street, ...existingStreetNames)
              .map(junctionStreet => ({
                streetRef: this.streetsToIds[junctionStreet],
                coordinates: this.nodes[nodeId],
              }));

            this.streetJunctions[streetId] = this.streetJunctions[streetId]
              .concat(streetObjs)
              .sort((a, b) => intlCompare(
                this.idsToStreets[a.streetRef],
                this.idsToStreets[b.streetRef]
              ));
          });
        }
      });
  }
}

module.exports = Transformation;
