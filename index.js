const debug = require('debug')('osm-search-data-export');
const inputs = require('./src/input');
const outputs = require('./src/output');
const createConfig = require('./src/config');
const Transformer = require('./src/transformer');

function osmToSearchData(input, output, userConfig = {}) {
  const config = createConfig(userConfig);

  if (!(typeof input === 'function')) {
    throw new Error('Invalid input');
  }

  if (!(typeof output === 'function')) {
    throw new Error('Invalid output');
  }

  const transformer = new Transformer(config);

  input({
    onItem: (item) => transformer.addItem(item),
    onComplete: () => output(transformer.complete()),
  });

  debug("Done");
}

// Make input and output funcs available as static properties
Object.assign(osmToSearchData, inputs, outputs);

module.exports = osmToSearchData;
