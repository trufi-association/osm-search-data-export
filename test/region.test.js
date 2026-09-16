const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const createConfig = require('../src/config');
const Transformer = require('../src/transformer');

// Minimal OSM dataset builder. Items are fed to the transformer in the order
// nodes, ways, relations, like a PBF file or an Overpass result.
class Dataset {
  constructor() {
    this.lastId = 0;
    this.nodes = [];
    this.ways = [];
    this.relations = [];
  }

  nextId() {
    this.lastId += 1;
    return this.lastId;
  }

  node(lon, lat) {
    const id = this.nextId();
    this.nodes.push({
      type: 'node', id, lon, lat,
    });
    return id;
  }

  // Node ids for the corners of a polygon given as [lon, lat] pairs.
  corners(coords) {
    return coords.map(([lon, lat]) => this.node(lon, lat));
  }

  way(refs, tags = {}) {
    const id = this.nextId();
    this.ways.push({
      type: 'way', id, tags, refs,
    });
    return id;
  }

  // A residential street between two coordinates.
  street(name, [lon1, lat1], [lon2, lat2]) {
    const refs = [this.node(lon1, lat1), this.node(lon2, lat2)];
    return this.way(refs, { name, highway: 'residential' });
  }

  // Municipality boundary relation. `memberKey` selects the member id field:
  // 'ref' as in Overpass JSON, 'id' as emitted by osm-pbf-parser.
  municipality(name, outerWayIds, { memberKey = 'ref', innerWayIds = [] } = {}) {
    const member = (role) => (wayId) => ({ type: 'way', role, [memberKey]: wayId });

    this.relations.push({
      type: 'relation',
      id: this.nextId(),
      tags: {
        type: 'boundary', boundary: 'administrative', admin_level: '8', name,
      },
      members: outerWayIds.map(member('outer')).concat(innerWayIds.map(member('inner'))),
    });
  }

  // Runs the transformer and returns { streetName: region }.
  regions() {
    const transformer = new Transformer(createConfig({}));
    const regions = {};

    [].concat(this.nodes, this.ways, this.relations).forEach((item) => transformer.addItem(item));
    Object.values(transformer.complete().streets).forEach((street) => {
      regions[street.name] = street.region;
    });

    return regions;
  }
}

const square = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];

describe('street region from admin_level=8 boundary relations', () => {
  it('assigns adjacent municipalities and leaves streets outside them undefined', () => {
    const ds = new Dataset();
    const [a1, a2, a3, a4] = ds.corners(square(0, 0, 1));
    const [b1, b2, b3, b4] = ds.corners(square(1, 0, 1));
    ds.municipality('A', [ds.way([a1, a2, a3, a4, a1])]);
    ds.municipality('B', [ds.way([b1, b2, b3, b4, b1])]);
    ds.street('Inside A', [0.2, 0.5], [0.8, 0.5]);
    ds.street('Inside B', [1.2, 0.5], [1.8, 0.5]);
    ds.street('Outside', [5, 5], [6, 5]);

    assert.deepEqual(ds.regions(), { 'Inside A': 'A', 'Inside B': 'B', Outside: undefined });
  });

  it('reads member ids from both the Overpass (ref) and the PBF (id) shapes', () => {
    ['ref', 'id'].forEach((memberKey) => {
      const ds = new Dataset();
      const [c1, c2, c3, c4] = ds.corners(square(0, 0, 1));
      ds.municipality('M', [ds.way([c1, c2, c3, c4, c1])], { memberKey });
      ds.street('Street', [0.2, 0.5], [0.8, 0.5]);

      assert.equal(ds.regions().Street, 'M', `members keyed by "${memberKey}"`);
    });
  });

  it('stitches a ring split into ways that need reversing', () => {
    const ds = new Dataset();
    const [c1, c2, c3, c4] = ds.corners(square(0, 0, 1));
    // c1 -> c2 -> c3, then c1 -> c4 -> c3: the second way runs against the ring direction.
    ds.municipality('M', [ds.way([c1, c2, c3]), ds.way([c1, c4, c3])]);
    ds.street('Street', [0.2, 0.5], [0.8, 0.5]);

    assert.equal(ds.regions().Street, 'M');
  });

  it('closes an open chain with a straight segment when a way is missing from the extract', () => {
    const ds = new Dataset();
    const [c1, c2, c3, c4] = ds.corners(square(0, 0, 1));
    const missingWayId = 9999;
    // Three of the four edges are present; the c4 -> c1 edge was clipped away.
    ds.municipality('M', [ds.way([c1, c2]), ds.way([c2, c3]), ds.way([c3, c4]), missingWayId]);
    ds.street('Inside', [0.2, 0.5], [0.8, 0.5]);
    ds.street('Outside', [1.5, 0.5], [1.8, 0.5]);

    assert.deepEqual(ds.regions(), { Inside: 'M', Outside: undefined });
  });

  it('uses the ring itself, not its hull, when a municipality sits in a concavity of another', () => {
    const ds = new Dataset();
    // L-shaped municipality: its convex hull covers the (1..3, 1..3) block, its ring does not.
    const l = ds.corners([[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]]);
    ds.municipality('L', [ds.way(l.concat(l[0]))]);
    const [s1, s2, s3, s4] = ds.corners(square(1.5, 1.5, 1));
    ds.municipality('S', [ds.way([s1, s2, s3, s4, s1])]);
    ds.street('In the square', [1.6, 2], [2.4, 2]);
    ds.street('In the arm of the L', [0.2, 2], [0.8, 2]);
    ds.street('In the hull only', [2.6, 2.6], [2.9, 2.6]);

    assert.deepEqual(ds.regions(), {
      'In the square': 'S',
      'In the arm of the L': 'L',
      'In the hull only': undefined,
    });
  });

  it('keeps every outer ring of a municipality with an exclave', () => {
    const ds = new Dataset();
    const [m1, m2, m3, m4] = ds.corners(square(0, 0, 1));
    const [x1, x2, x3, x4] = ds.corners(square(3, 3, 1));
    // An open chain of the main part comes first; the exclave is a closed way of its own.
    ds.municipality('M', [ds.way([m1, m2, m3]), ds.way([x1, x2, x3, x4, x1]), ds.way([m3, m4, m1])]);
    ds.street('Main part', [0.2, 0.5], [0.8, 0.5]);
    ds.street('Exclave', [3.2, 3.5], [3.8, 3.5]);
    ds.street('Between', [2, 2], [2.5, 2]);

    assert.deepEqual(ds.regions(), { 'Main part': 'M', Exclave: 'M', Between: undefined });
  });

  it('prefers the smallest polygon for an enclave and ignores inner members', () => {
    const ds = new Dataset();
    const [o1, o2, o3, o4] = ds.corners(square(0, 0, 4));
    const [e1, e2, e3, e4] = ds.corners(square(1, 1, 1));
    const enclaveRing = ds.way([e1, e2, e3, e4, e1]);
    ds.municipality('Outer', [ds.way([o1, o2, o3, o4, o1])], { innerWayIds: [enclaveRing] });
    ds.municipality('Enclave', [enclaveRing]);
    ds.street('In the enclave', [1.2, 1.5], [1.8, 1.5]);
    ds.street('In the outer municipality', [3, 3], [3.5, 3]);

    assert.deepEqual(ds.regions(), {
      'In the enclave': 'Enclave',
      'In the outer municipality': 'Outer',
    });
  });
});
