function multiOutput(...targets) {
  return function (data) {
    targets.forEach(target => target(data));
  };
}

module.exports = multiOutput;
