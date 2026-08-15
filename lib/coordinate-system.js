const UP_AXIS_BY_GRAVITY = new Map([
  [-3, "z"],
  [3, "-z"],
  [-2, "y"],
  [2, "-y"],
  [-1, "x"],
  [1, "-x"],
]);

function coordinateSystemMetadata(gravityAxis) {
  return {
    upAxis: UP_AXIS_BY_GRAVITY.get(gravityAxis) || "z",
    handedness: "right",
    gravityAxis: gravityAxisLabel(gravityAxis),
  };
}

function gravityAxisLabel(gravityAxis) {
  if (!UP_AXIS_BY_GRAVITY.has(gravityAxis)) return "undefined";
  const axis = "xyz"[Math.abs(gravityAxis) - 1];
  return `${gravityAxis > 0 ? "+" : "-"}${axis}`;
}

module.exports = { coordinateSystemMetadata, gravityAxisLabel };
