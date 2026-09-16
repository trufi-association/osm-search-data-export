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

function getOuterRings(feature) {
  const { type, coordinates } = feature.geometry;

  return type === 'MultiPolygon'
    ? coordinates.map((polygonCoords) => polygonCoords[0])
    : [coordinates[0]];
}

function getPolygonArea(feature) {
  return getOuterRings(feature).reduce((sum, ring) => sum + getRingArea(ring), 0);
}

// Copy of the feature with its bounding box set, which lets point-in-polygon
// tests skip polygons far away from the point.
function withBoundingBox(feature) {
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];

  getOuterRings(feature).flat().forEach(([lon, lat]) => {
    bbox[0] = Math.min(bbox[0], lon);
    bbox[1] = Math.min(bbox[1], lat);
    bbox[2] = Math.max(bbox[2], lon);
    bbox[3] = Math.max(bbox[3], lat);
  });

  return { ...feature, bbox };
}

// Orders streets by name, then by municipality; streets outside every
// municipality come last.
function compareStreetEntities(a, b) {
  const byName = intlCompare(a.name, b.name);

  if (byName !== 0) {
    return byName;
  }
  if (a.region == null || b.region == null) {
    return (a.region == null ? 1 : 0) - (b.region == null ? 1 : 0);
  }

  return intlCompare(a.region, b.region);
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
    this.streetWayGroups = [];
    this.nodeToWayGroups = {};
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
    debug('Sorting region polygons');
    this.sortRegionPolygons();
    debug('Assigning regions to street ways');
    this.assignWayGroupRegions();
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
      // Collect the way as a group of nodes under its street name. The groups
      // are split into one street per municipality in complete(), once the
      // boundary relations (last in the input) have been read.
      const group = { name, refs };
      this.streetWayGroups.push(group);

      // Link the node to the way (a node can be shared by several streets)
      refs.forEach((ref) => {
        this.nodeToWayGroups[ref] = this.nodeToWayGroups[ref] || [];

        if (this.nodeToWayGroups[ref].indexOf(group) === -1) {
          this.nodeToWayGroups[ref].push(group);
        }
      });

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
          polygon: withBoundingBox(polygon),
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

  // Smallest polygon first, so a point inside nested boundaries gets the
  // innermost one. Ties keep relation order.
  sortRegionPolygons() {
    this.regionPolygons.sort((a, b) => {
      if (a.area !== b.area) {
        return a.area - b.area;
      }

      return a.order - b.order;
    });
  }

  findRegion(coordinates) {
    const point = geoPoint(coordinates);
    const match = this.regionPolygons
      .find((entry) => geoPointInPolygon(point, entry.polygon));

    return match ? match.name : undefined;
  }

  // Each way belongs to the municipality its middle node lies in.
  assignWayGroupRegions() {
    for (let i = 0; i < this.streetWayGroups.length; i++) {
      const group = this.streetWayGroups[i];
      const middleNode = group.refs[Math.floor(group.refs.length / 2)];

      group.region = this.findRegion(this.nodes[middleNode]);
    }
  }

  // Flattens a collection of ways by first sorting them
  // by looking at their distance to each other.
  flattenNodeGroups(nodeGroups) {
    const sortedGroups = nodeGroups.slice().sort((a, b) => {
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

    return sortedGroups.flat();
  }

  // Builds one street per name and municipality: a name shared by several
  // towns of the extract yields one street per town, each with its own
  // centre and region.
  extractStreets() {
    const entities = new Map();

    for (let i = 0; i < this.streetWayGroups.length; i++) {
      const group = this.streetWayGroups[i];
      const key = JSON.stringify([group.name, group.region || null]);

      if (!entities.has(key)) {
        entities.set(key, { name: group.name, region: group.region, groups: [] });
      }
      entities.get(key).groups.push(group);
    }

    Array.from(entities.values())
      .sort(compareStreetEntities)
      .forEach((entity, index) => {
        const id = `s${index + 1}`;
        const { name, region, groups } = entity;
        const alternativeNames = this.streetAlternativeNames[name] || [];
        const nodeIds = this.flattenNodeGroups(groups.map((group) => group.refs));
        const path = nodeIds.map((nodeId) => this.nodes[nodeId]);
        const coordinates = getCenterCoordsOfPath(path);

        for (let i = 0; i < groups.length; i++) {
          groups[i].streetId = id;
        }

        this.streets[id] = {
          name,
          alternativeNames,
          coordinates,
          region,
        };
      });
  }

  // A junction is a node shared by the ways of two or more streets.
  extractStreetJunctions() {
    Object.keys(this.nodeToWayGroups)
      .forEach((nodeId) => {
        const streetIds = this.nodeToWayGroups[nodeId]
          .map((group) => group.streetId)
          .filter((streetId, index, ids) => ids.indexOf(streetId) === index);

        if (streetIds.length > 1) {
          streetIds.forEach((streetId) => {
            this.streetJunctions[streetId] = this.streetJunctions[streetId] || [];

            const existingStreetRefs = this.streetJunctions[streetId]
              .map((entry) => entry.streetRef);

            const streetObjs = without(streetIds, streetId, ...existingStreetRefs)
              .map((junctionStreetId) => ({
                streetRef: junctionStreetId,
                coordinates: this.nodes[nodeId],
              }));

            this.streetJunctions[streetId] = this.streetJunctions[streetId]
              .concat(streetObjs)
              .sort((a, b) => compareStreetEntities(
                this.streets[a.streetRef],
                this.streets[b.streetRef],
              ));
          });
        }
      });
  }
}

module.exports = Transformation;
