function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function unit(vector) {
  const length = Math.hypot(...vector);
  // The `+ 0` turns a negative zero back into a zero. A cross product yields
  // one wherever a term cancels; it is the same number and a different value,
  // and it has no business in geometry a viewer and a saved document read.
  return length > 1e-9 ? vector.map((value) => value / length + 0) : null;
}

// IACHS names the signed global axis gravity acts along, and the model's own
// axes are the ones a frame is built in.
function gravityVector(gravityAxis) {
  const axis = Math.abs(gravityAxis);
  if (!Number.isInteger(gravityAxis) || axis < 1 || axis > 3) return null;
  const vector = [0, 0, 0];
  vector[axis - 1] = Math.sign(gravityAxis);
  return vector;
}

// The frame SOFiSTiK gives a member that nothing rotates: local y square to
// both the member and gravity, and local z completing the right-handed set —
// which is to say z is which way is down, seen in the member's own
// cross-section. Checked against the beams of the three field models, which do
// store their frame: 4870 of 5146 agree, and every one that does not carries an
// explicit roll in BETY or BETZ, a field a truss record does not have.
//
// A member running along gravity has no such y, so the limit is taken in the
// plane of gravity and the first global axis that is not gravity — for a
// gravity-down model, the global y, which is what the columns of a real
// database store.
function defaultLocalAxes(axis, gravity) {
  const other = [0, 0, 0];
  other[(gravity.findIndex((value) => value !== 0) + 1) % 3] = 1;
  const y = unit(cross(gravity, axis)) || unit(cross(gravity, other));
  const z = y && unit(cross(axis, y));
  return z ? { x: axis, y, z } : null;
}

module.exports = { cross, unit, gravityVector, defaultLocalAxes };
