// Turning what a CDB stores into what the Graviss contract asks for.
//
// The contract is SI - metres, newtons, radians - and a CDB is not. SOFiSTiK's
// help carries the table that says so, one row per quantity, and the column it
// calls CDBASE is the unit a value is *stored* in as opposed to the one it is
// printed in. Lengths and deformations are stored in metres and rotations in
// radians, so those pass through; forces are stored in kilonewtons and stresses
// in kN/m2, so those do not.
//
// The quantity is not guessable from a field's name - `x` is a length on one
// record and a station on another, `n` is a normal force - so it is read from
// the code the headers state beside each field, which `sofistik-reader` keeps
// as `field.unit`. That is the whole point of driving conversion off the code:
// a factor applied to the wrong column is invisible, because a displacement in
// millimetres and a displacement in metres are both a plausible picture.
//
// Only the quantities this package reads are listed. A code that is not here is
// not converted, and `isKnownUnit` is how a caller finds out before trusting a
// number rather than after.

const KILO = 1000;

// code -> what a CDB stores it in, and what it takes to make that SI.
const UNITS = new Map([
  [1000, { stored: "km", factor: KILO }],
  [1001, { stored: "m", factor: 1 }],
  [1002, { stored: "m2", factor: 1 }],
  [1003, { stored: "m", factor: 1 }],
  [1004, { stored: "rad", factor: 1 }],
  [1005, { stored: "1/m", factor: 1 }],
  [1006, { stored: "m", factor: 1 }],
  [1007, { stored: "m2", factor: 1 }],
  [1008, { stored: "m3", factor: 1 }],
  [1009, { stored: "1/m", factor: 1 }],
  [1010, { stored: "m", factor: 1 }],
  [1011, { stored: "m", factor: 1 }],
  [1012, { stored: "m2", factor: 1 }],
  [1013, { stored: "m3", factor: 1 }],
  [1014, { stored: "m4", factor: 1 }],
  [1025, { stored: "m", factor: 1 }],
  [1081, { stored: "-", factor: 1 }],
  [1090, { stored: "kN/m2", factor: KILO }],
  [1092, { stored: "kN/m2", factor: KILO }],
  [1093, { stored: "kN/m2", factor: KILO }],
  [1101, { stored: "kN", factor: KILO }],
  [1102, { stored: "kN", factor: KILO }],
  [1103, { stored: "kNm", factor: KILO }],
  [1104, { stored: "kNm", factor: KILO }],
  [1105, { stored: "kNm2", factor: KILO }],
  [1151, { stored: "kN", factor: KILO }],
  [1152, { stored: "kNm", factor: KILO }],
]);

function isKnownUnit(code) {
  return UNITS.has(code);
}

// The factor a stored value is multiplied by to make it SI. A field that names
// no quantity, or names one this table does not carry, is left alone - and a
// caller that cannot afford to guess asks `isKnownUnit` first.
function siFactor(code) {
  return UNITS.get(code)?.factor ?? 1;
}

function storedUnit(code) {
  return UNITS.get(code)?.stored ?? null;
}

// The factor for a named field of a read, from the code its own layout states.
// A read carries its fields, so nothing here has to know which record it came
// from - which is what keeps this table a table rather than a list of special
// cases.
function fieldFactor(read, name) {
  const field = read?.fields?.find((entry) => entry.name === name);
  return field?.unit == null ? 1 : siFactor(field.unit);
}

module.exports = { UNITS, fieldFactor, isKnownUnit, siFactor, storedUnit };
