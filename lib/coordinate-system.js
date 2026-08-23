const UP_AXIS_BY_GRAVITY = new Map([
  [-3, "z"],
  [3, "-z"],
  [-2, "y"],
  [2, "-y"],
  [-1, "x"],
  [1, "-x"],
]);

// SOFiSTiK's own convention is z downwards - the help states it of the plane
// systems and every general system is written the same way - so a database
// that names no gravity axis at all is still not a z-up model, which is what
// the viewer would otherwise assume. IPROB names the system, and the families
// that are somebody else's convention say so: the WCS variants are "the
// international x-y coordinate system", where y is up. Their slab twins keep z
// out of the plane, because a slab lies in x-y and is drawn seen from above.
//
// None of this is reached by a database that states its gravity, which is
// every one written by SOFiMSHA; it is only the answer for one that states
// none, where the alternative is a model drawn upside down.
const UP_AXIS_BY_PROBLEM = new Map([
  // Plane frame, plane stress, plane strain and axisymmetric, in the WCS.
  [14, "y"],
  [15, "y"],
  [16, "y"],
  [17, "y"],
  // Plane girder and prestressed plane girder, in the WCS.
  [34, "z"],
  [35, "z"],
]);
const DEFAULT_UP_AXIS = "-z";

/**
 * The coordinate system a model is read in, from its system record.
 * @param {number} gravityAxis - IACHS, the signed global axis gravity acts along
 * @param {number} [problemType] - IPROB, the kind of system the model is
 * @returns {{upAxis: string, handedness: string, gravityAxis: string}}
 */
function coordinateSystemMetadata(gravityAxis, problemType) {
  return {
    upAxis:
      UP_AXIS_BY_GRAVITY.get(gravityAxis) ||
      UP_AXIS_BY_PROBLEM.get(problemTypeOf(problemType)) ||
      DEFAULT_UP_AXIS,
    handedness: "right",
    gravityAxis: gravityAxisLabel(gravityAxis),
  };
}

// A database SOFiSTiK found something wrong with stores its problem type
// negated with a reason multiplied in - IPROB = -(IPROB + 1000*N) - so the
// reason is stripped before the type is read. The model is still the model it
// says it is; only its correctness is in doubt.
function problemTypeOf(problemType) {
  if (!Number.isInteger(problemType)) return null;
  return problemType < 0 ? -problemType % 1000 : problemType;
}

function gravityAxisLabel(gravityAxis) {
  if (!UP_AXIS_BY_GRAVITY.has(gravityAxis)) return "undefined";
  const axis = "xyz"[Math.abs(gravityAxis) - 1];
  return `${gravityAxis > 0 ? "+" : "-"}${axis}`;
}

module.exports = { coordinateSystemMetadata, gravityAxisLabel, problemTypeOf };
