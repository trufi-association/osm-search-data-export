const debug = require('debug')('osm-search-data-export');
const without = require('lodash.without');
const geoPoint = require('@turf/helpers').point;
const geoFeatureCollection = require('@turf/helpers').featureCollection;
const geoLineString = require('@turf/helpers').lineString;
const geoPolygon = require('@turf/helpers').polygon;
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

// Planar shoelace area of a ring. It is only used to order polygons by size,
// so computing it on raw lon/lat values is good enough.
function getRingArea(ring) {
  let sum = 0;

  for (let i = 0; i < ring.length - 1; i++) {
    sum += (ring[i][0] * ring[i + 1][1]) - (ring[i + 1][0] * ring[i][1]);
  }

  return Math.abs(sum) / 2;
}

function getPolygonArea(feature) {
  const { type, coordinates } = feature.geometry;
  const outerRings = type === 'MultiPolygon'
    ? coordinates.map((polygonCoords) => polygonCoords[0])
    : [coordinates[0]];

  return outerRings.reduce((sum, ring) => sum + getRingArea(ring), 0);
}

// Appends a way (list of node ids) to whichever end of the chain it touches,
// reversing it when needed. Returns null when the way does not connect.
function joinWayToChain(chain, wayRefs) {
  const chainStart = chain[0];
  const chainEnd = chain[chain.length - 1];
  const wayStart = wayRefs[0];
  const wayEnd = wayRefs[wayRefs.length - 1];

  if (wayStart === chainEnd) {
    return chain.concat(wayRefs.slice(1));
  }
  if (wayEnd === chainEnd) {
    return chain.concat(wayRefs.slice(0, -1).reverse());
  }
  if (wayEnd === chainStart) {
    return wayRefs.slice(0, -1).concat(chain);
  }
  if (wayStart === chainStart) {
    return wayRefs.slice(1).reverse().concat(chain);
  }

  return null;
}

// Stitches the outer ways of a boundary relation into closed rings by matching
// their endpoint node ids. Chains that cannot be closed (ways clipped away by
// the bounding box of the extract) are returned separately.
function stitchOuterWays(outerWays) {
  const segments = outerWays.filter((refs) => refs.length > 1);
  const used = segments.map(() => false);
  const rings = [];
  const openChains = [];
  const isClosed = (chain) => chain[0] === chain[chain.length - 1];
  const isRing = (chain) => isClosed(chain) && chain.length >= 4;

  segments.forEach((segment, i) => {
    if (used[i]) {
      return;
    }

    used[i] = true;
    let chain = segment;
    let extended = true;

    // Ways closed on their own are rings of their own (exclaves) and are
    // never joined onto another chain.
    while (extended && !isClosed(chain)) {
      extended = false;

      for (let j = 0; j < segments.length && !extended; j++) {
        const joined = used[j] || isClosed(segments[j]) ? null : joinWayToChain(chain, segments[j]);

        if (joined !== null) {
          chain = joined;
          used[j] = true;
          extended = true;
        }
      }
    }

    if (isRing(chain)) {
      rings.push(chain);
    } else {
      openChains.push(chain);
    }
  });

  return { rings, openChains };
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
    this.regionPolygons = [];
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

      default:
        // Ignore unknown type
    }
  }

  complete() {
    debug('Flattening street node groups');
    this.flattenStreetNodeGroups();
    debug('Extracting streets');
    this.extractStreets();
    debug('Extracting street junctions');
    this.extractStreetJunctions();

    return {
      pois: this.pois,
      streets: this.streets,
      streetJunctions: this.streetJunctions,
    };
  }

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
        tags.short_name,
      ])
      .filter((altName) => altName != null);

    const nameLangs = Object.keys(tags)
      .filter((tag) => tag.indexOf('name:') === 0)
      .map((tag) => tag.substring(5));

    const localizedNames = {};

    nameLangs.forEach((lang) => {
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
    if (refs.find((ref) => !this.nodes[ref])) {
      return;
    }

    // We only list highway types as streets. Everything else will end up
    // a point of interest.
    if (this.hasSupportedStreetTags(tags)) {
      // Assign street name to node (a node can be linked to multiple streets)
      refs.forEach((ref) => {
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
      const path = refs.map((nodeId) => this.nodes[nodeId]);

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
      relation.tags
      && relation.tags.type === 'boundary'
      && relation.tags.boundary === 'administrative'
      && relation.tags.admin_level === '8'
    ) {
      const { name } = relation.tags;
      // Overpass JSON calls the member id "ref", osm-pbf-parser calls it "id".
      const outerWays = relation.members
        .filter((member) => member.type === 'way' && member.role === 'outer')
        .map((member) => this.ways[member.ref != null ? member.ref : member.id])
        .filter((way) => way != null)
        .map((way) => way.refs || way.nodes);
      const { rings, openChains } = stitchOuterWays(outerWays);
      // An open chain is missing ways clipped away by the bounding box of the
      // extract: closing it with a straight segment is accurate enough there.
      const polygons = rings.concat(openChains)
        .map((chain) => this.buildRingPolygon(chain))
        .filter((polygon) => polygon != null);

      if (polygons.length === 0) {
        // Nothing to stitch: fall back to a concave hull of the outer nodes.
        const hull = this.buildConcaveHull(outerWays);

        if (hull != null) {
          polygons.push(hull);
        }
      }

      debug(`Boundary ${name}: ${rings.length} ring(s), ${openChains.length} open chain(s), ${polygons.length} polygon(s)`);

      polygons.forEach((polygon) => {
        this.regionPolygons.push({
          name,
          polygon,
          area: getPolygonArea(polygon),
          order: this.regionPolygons.length,
        });
      });
    }
  }

  // Turns a chain of node ids into a polygon feature. Nodes missing from the
  // extract are skipped and the ring is closed when needed. Returns null for
  // degenerate rings with fewer than three distinct positions.
  buildRingPolygon(chain) {
    const refs = chain.filter((ref) => this.nodes[ref] != null);

    if (refs.length > 0 && refs[0] !== refs[refs.length - 1]) {
      refs.push(refs[0]);
    }

    if (refs.length < 4) {
      return null;
    }

    return geoPolygon([refs.map((ref) => this.nodes[ref])]);
  }

  buildConcaveHull(outerWays) {
    const points = outerWays
      .flat()
      .map((ref) => this.nodes[ref])
      .filter((coords) => coords != null)
      .map((coords) => geoPoint(coords));

    return geoConcave(geoFeatureCollection(points));
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
      .forEach((street) => {
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

    // Smallest polygon first, so a street inside nested boundaries gets the
    // innermost one. Ties keep relation order.
    this.regionPolygons.sort((a, b) => {
      if (a.area !== b.area) {
        return a.area - b.area;
      }

      return a.order - b.order;
    });

    Object.keys(this.streetToNodes)
      .sort(intlCompare)
      .forEach((street) => {
        const id = `s${i}`;
        i += 1;

        this.streetsToIds[street] = id;
        this.idsToStreets[id] = street;

        const alternativeNames = this.streetAlternativeNames[street] || [];
        const path = this.streetToNodes[street].map((nodeId) => this.nodes[nodeId]);
        const coordinates = getCenterCoordsOfPath(path);
        const centerPoint = geoPoint(coordinates);
        const match = this.regionPolygons
          .find((entry) => geoPointInPolygon(centerPoint, entry.polygon));
        const region = match ? match.name : undefined;

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
      .forEach((nodeId) => {
        if (this.nodeToStreet[nodeId].length > 1) {
          this.nodeToStreet[nodeId].forEach((street) => {
            const streetId = this.streetsToIds[street];

            this.streetJunctions[streetId] = this.streetJunctions[streetId] || [];

            const existingStreetNames = this.streetJunctions[streetId]
              .map((entry) => this.idsToStreets[entry.streetRef]);

            const streetObjs = without(this.nodeToStreet[nodeId], street, ...existingStreetNames)
              .map((junctionStreet) => ({
                streetRef: this.streetsToIds[junctionStreet],
                coordinates: this.nodes[nodeId],
              }));

            this.streetJunctions[streetId] = this.streetJunctions[streetId]
              .concat(streetObjs)
              .sort((a, b) => intlCompare(
                this.idsToStreets[a.streetRef],
                this.idsToStreets[b.streetRef],
              ));
          });
        }
      });
  }
}

module.exports = Transformation;
