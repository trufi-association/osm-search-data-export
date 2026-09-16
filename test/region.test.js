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

  // A residential street over existing nodes.
  streetWay(name, refs, tags = {}) {
    return this.way(refs, { name, highway: 'residential', ...tags });
  }

  // A residential street between two coordinates.
  street(name, [lon1, lat1], [lon2, lat2], tags = {}) {
    return this.streetWay(name, [this.node(lon1, lat1), this.node(lon2, lat2)], tags);
  }

  // Municipality boundary relation. `memberKey` selects the member id field:
  // 'ref' as in Overpass JSON, 'id' as emitted by osm-pbf-parser.
  municipality(name, outerWayIds, { memberKey = 'ref', innerWayIds = [], tags = {} } = {}) {
    const member = (role) => (wayId) => ({ type: 'way', role, [memberKey]: wayId });

    this.relations.push({
      type: 'relation',
      id: this.nextId(),
      tags: {
        type: 'boundary', boundary: 'administrative', admin_level: '8', name, ...tags,
      },
      members: outerWayIds.map(member('outer')).concat(innerWayIds.map(member('inner'))),
    });
  }

  // Runs the transformer and returns its result.
  run() {
    const transformer = new Transformer(createConfig({}));

    [].concat(this.nodes, this.ways, this.relations).forEach((item) => transformer.addItem(item));

    return transformer.complete();
  }

  // Runs the transformer and returns { streetName: region }.
  regions() {
    const regions = {};

    Object.values(this.run().streets).forEach((street) => {
      regions[street.name] = street.region;
    });

    return regions;
  }
}

const assertNear = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => {
    assert.ok(Math.abs(value - expected[i]) < 1e-3, `${actual} is not near ${expected}`);
  });
};

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

describe('streets split by municipality', () => {
  // Two adjacent square municipalities A and B. "Calle Abaroa" exists in A, in B
  // and outside both; the crossings with "Calle Norte" (A) and "Calle Sur" (B)
  // share a node with the respective Abaroa way.
  const build = () => {
    const ds = new Dataset();
    const [a1, a2, a3, a4] = ds.corners(square(0, 0, 1));
    const [b1, b2, b3, b4] = ds.corners(square(1, 0, 1));
    ds.municipality('A', [ds.way([a1, a2, a3, a4, a1])]);
    ds.municipality('B', [ds.way([b1, b2, b3, b4, b1])]);
    const crossA = ds.node(0.5, 0.5);
    const crossB = ds.node(1.5, 0.5);
    ds.streetWay('Calle Abaroa', [ds.node(0.2, 0.5), crossA, ds.node(0.8, 0.5)]);
    ds.streetWay('Calle Abaroa', [ds.node(1.2, 0.5), crossB, ds.node(1.8, 0.5)]);
    ds.street('Calle Abaroa', [5, 5], [6, 5]);
    ds.streetWay('Calle Norte', [ds.node(0.5, 0.2), crossA, ds.node(0.5, 0.8)]);
    ds.streetWay('Calle Sur', [ds.node(1.5, 0.2), crossB, ds.node(1.5, 0.8)]);

    return ds.run();
  };

  it('exports one street per name and municipality, sorted by name then region', () => {
    const { streets } = build();
    const rows = Object.entries(streets).map(([id, street]) => [id, street.name, street.region]);

    assert.deepEqual(rows, [
      ['s1', 'Calle Abaroa', 'A'],
      ['s2', 'Calle Abaroa', 'B'],
      ['s3', 'Calle Abaroa', undefined],
      ['s4', 'Calle Norte', 'A'],
      ['s5', 'Calle Sur', 'B'],
    ]);
  });

  it('gives each street its own centre', () => {
    const { streets } = build();

    assertNear(streets.s1.coordinates, [0.5, 0.5]);
    assertNear(streets.s2.coordinates, [1.5, 0.5]);
    assertNear(streets.s3.coordinates, [5.5, 5]);
  });

  it('attaches junctions to the street whose ways meet at the node', () => {
    const { streetJunctions } = build();
    const refs = (id) => (streetJunctions[id] || []).map((junction) => junction.streetRef);

    assert.deepEqual(refs('s4'), ['s1']);
    assert.deepEqual(refs('s5'), ['s2']);
    assert.deepEqual(refs('s1'), ['s4']);
    assert.deepEqual(refs('s2'), ['s5']);
    assert.deepEqual(refs('s3'), []);
    assertNear(streetJunctions.s4[0].coordinates, [0.5, 0.5]);
  });

  it('does not list a street continuing into the next municipality as a corner', () => {
    const ds = new Dataset();
    const [a1, a2, a3, a4] = ds.corners(square(0, 0, 1));
    const [b1, b2, b3, b4] = ds.corners(square(1, 0, 1));
    ds.municipality('A', [ds.way([a1, a2, a3, a4, a1])]);
    ds.municipality('B', [ds.way([b1, b2, b3, b4, b1])]);
    // "Calle Sucre" runs from A into B through the node on the seam.
    const seam = ds.node(1, 0.5);
    const crossA = ds.node(0.5, 0.5);
    ds.streetWay('Calle Sucre', [ds.node(0.2, 0.5), crossA, seam]);
    ds.streetWay('Calle Sucre', [seam, ds.node(1.8, 0.5)]);
    ds.streetWay('Calle Norte', [ds.node(0.5, 0.2), crossA, ds.node(0.5, 0.8)]);

    const { streets, streetJunctions } = ds.run();
    const refs = (id) => (streetJunctions[id] || []).map((junction) => junction.streetRef);

    assert.deepEqual(Object.values(streets).map((street) => [street.name, street.region]), [
      ['Calle Norte', 'A'], ['Calle Sucre', 'A'], ['Calle Sucre', 'B'],
    ]);
    assert.deepEqual(refs('s1'), ['s2']);
    assert.deepEqual(refs('s2'), ['s1']);
    assert.deepEqual(refs('s3'), []);
    assert.equal(streetJunctions.s3, undefined);
  });

  it('keeps the alternative names of each street separately', () => {
    const ds = new Dataset();
    const [a1, a2, a3, a4] = ds.corners(square(0, 0, 1));
    const [b1, b2, b3, b4] = ds.corners(square(1, 0, 1));
    ds.municipality('A', [ds.way([a1, a2, a3, a4, a1])]);
    ds.municipality('B', [ds.way([b1, b2, b3, b4, b1])]);
    ds.street('Calle Sucre', [0.2, 0.5], [0.4, 0.5], { alt_name: 'Sucre de A' });
    ds.street('Calle Sucre', [0.6, 0.5], [0.8, 0.5]);
    ds.street('Calle Sucre', [1.2, 0.5], [1.8, 0.5], { alt_name: 'Sucre de B;Sucre B' });

    const { streets } = ds.run();

    assert.deepEqual(streets.s1.alternativeNames, ['Sucre de A']);
    assert.deepEqual(streets.s2.alternativeNames, ['Sucre de B', 'Sucre B']);
  });

  it('merges the ways of one street inside one municipality', () => {
    const ds = new Dataset();
    const [c1, c2, c3, c4] = ds.corners(square(0, 0, 1));
    ds.municipality('M', [ds.way([c1, c2, c3, c4, c1])]);
    const shared = ds.node(0.5, 0.5);
    ds.streetWay('Calle Larga', [ds.node(0.1, 0.5), shared]);
    ds.streetWay('Calle Larga', [shared, ds.node(0.9, 0.5)]);

    const { streets, streetJunctions } = ds.run();

    assert.deepEqual(Object.keys(streets), ['s1']);
    assert.equal(streets.s1.region, 'M');
    assertNear(streets.s1.coordinates, [0.5, 0.5]);
    assert.deepEqual(streetJunctions, {});
  });
});

describe('boundary and way edge cases', () => {
  it('uses the concave hull of a chain whose straight closure crosses it', () => {
    const ds = new Dataset();
    // Hook-shaped chain: the closing segment (3,1) -> (0,0) crosses the side x=2.
    const hook = ds.corners([[0, 0], [2, 0], [2, 2], [0, 2], [0, 1], [3, 1]]);
    ds.municipality('Hook', [ds.way(hook)]);
    ds.street('Inside', [0.4, 0.5], [0.6, 0.5]);

    assert.equal(ds.regions().Inside, 'Hook');
  });

  it('keeps the straight closure of a chain when it does not cross it', () => {
    const ds = new Dataset();
    // L-shaped chain missing the edge (0,3) -> (0,0); its hull would cover the notch.
    const l = ds.corners([[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]]);
    ds.municipality('L', [ds.way(l)]);
    ds.street('In the arm', [0.2, 2], [0.8, 2]);
    ds.street('In the notch', [1.8, 2], [2.2, 2]);

    assert.deepEqual(ds.regions(), { 'In the arm': 'L', 'In the notch': undefined });
  });

  it('ignores an outer way listed twice in the relation', () => {
    const ds = new Dataset();
    const [c1, c2, c3, c4] = ds.corners(square(0, 0, 1));
    const half1 = ds.way([c1, c2, c3]);
    const half2 = ds.way([c3, c4, c1]);
    ds.municipality('M', [half1, half1, half2]);
    ds.street('Inside', [0.2, 0.5], [0.8, 0.5]);

    assert.equal(ds.regions().Inside, 'M');
  });

  it('skips a boundary relation without a name', () => {
    const ds = new Dataset();
    const [o1, o2, o3, o4] = ds.corners(square(0, 0, 4));
    const [u1, u2, u3, u4] = ds.corners(square(1, 1, 1));
    ds.municipality('Named', [ds.way([o1, o2, o3, o4, o1])]);
    ds.municipality(undefined, [ds.way([u1, u2, u3, u4, u1])]);
    ds.street('Inside the unnamed one', [1.2, 1.5], [1.8, 1.5]);

    assert.equal(ds.regions()['Inside the unnamed one'], 'Named');
  });

  it('accepts admin_level given as a number', () => {
    const ds = new Dataset();
    const [c1, c2, c3, c4] = ds.corners(square(0, 0, 1));
    ds.municipality('M', [ds.way([c1, c2, c3, c4, c1])], { tags: { admin_level: 8 } });
    ds.street('Inside', [0.2, 0.5], [0.8, 0.5]);

    assert.equal(ds.regions().Inside, 'M');
  });

  it('ignores a street way with a single node', () => {
    const ds = new Dataset();
    const [c1, c2, c3, c4] = ds.corners(square(0, 0, 1));
    ds.municipality('M', [ds.way([c1, c2, c3, c4, c1])]);
    ds.streetWay('Lonely', [ds.node(0.5, 0.5)]);
    ds.street('Street', [0.2, 0.5], [0.8, 0.5]);

    assert.deepEqual(ds.regions(), { Street: 'M' });
  });
});
