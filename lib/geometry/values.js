function finitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

module.exports = { finitePositive };
