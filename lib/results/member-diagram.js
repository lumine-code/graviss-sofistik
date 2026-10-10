const { materialKeyOf, MATERIAL_KINDS, siFactor } = require("@lumine-code/sofistik-reader");
const { fieldsOf, MemberSeries, sampleCurve } = require("./member-series");
const {
  quantity,
  FORCE_FIELDS,
  DEFORMATION_FIELDS,
  BEDDING_FIELDS,
  ENHANCED_MODE_FIELDS,
  STRESS_FIELDS,
  SECTION_STATE_FIELDS,
} = require("./member-quantities");

const MEMBER_RECORDS = [
  "beamForces",
  "beamForcesWithoutPlate",
  "beamStresses",
  "beamHingeReactions",
  "beamStiffness",
];

async function readOptional(database, name, loadCaseId) {
  try {
    return await database.read(name, loadCaseId, {
      decodePolicy: "variable-tail",
      includeEnvelope: false,
    });
  } catch (error) {
    if (error.code === "ERR_CDB_RECORD_UNAVAILABLE") return { count: 0, columns: {} };
    throw error;
  }
}

function elementNumber(read, row) {
  // An explicit signed number identifies either bank at a discontinuity. Zero
  // continues the preceding element, resolved by the reader's element column.
  const raw = read.columns.nr?.[row];
  return raw ? Math.abs(raw) : read.columns.element?.[row];
}

function addFields(series, read, elementIdOf, definitions, group, prefix = "") {
  const descriptors = definitions.map(([field, id, title, type, plane, sign]) => ({
    field,
    descriptor: quantity(`${prefix}${id}`, `${id} · ${title}`, group, type, plane, sign),
  }));
  for (const { descriptor } of descriptors) series.declare(descriptor);
  const value = fieldsOf(read);
  for (let row = 0; row < read.count; row += 1) {
    const id = elementIdOf(elementNumber(read, row));
    if (id == null) continue;
    const x = value("x", row);
    for (const { field, descriptor } of descriptors) {
      let held;
      if (field) held = value(field, row);
      else {
        // ASE §2.3.3: total = primary + secondary + tertiary torsion.
        // A missing tertiary tail is unknown, not an assumed zero.
        const terms = ["mt", "mt2", "mt3"].map((name) => value(name, row));
        held = terms.every((term) => term != null) ? terms[0] - terms[1] - terms[2] : null;
      }
      series.add(id, x, descriptor, held);
    }
  }
}

function stressQualifier(raw) {
  const key = materialKeyOf(raw);
  const kind = MATERIAL_KINDS[key.kind];
  const labels = {
    tendon: "Tendon",
    admissible: "Admissible material",
    material: "Material",
    tendonMaximum: "Tendon material",
    reinforcement: "Reinforcement",
    stressPoint: "Stress point",
    shearCut: "Shear cut",
  };
  return {
    id: `${kind}:${key.name || key.number}`,
    title: `${labels[kind]} ${key.name || key.number}`,
    kind,
  };
}

function addStresses(series, read, elementIdOf) {
  const value = fieldsOf(read);
  for (let row = 0; row < read.count; row += 1) {
    const id = elementIdOf(elementNumber(read, row));
    if (id == null) continue;
    const qualifier = stressQualifier(read.columns.mnr[row]);
    const x = value("x", row);
    for (const [field, title, type] of STRESS_FIELDS) {
      const undefinedForMaterial =
        ["tendon", "tendonMaximum", "reinforcement"].includes(qualifier.kind) &&
        ["sigo", "sigu", "sigw"].includes(field);
      const label =
        field === "sigv" && qualifier.kind === "shearCut"
          ? "Transverse reinforcement stress"
          : title;
      const descriptor = quantity(
        `stress:${qualifier.id}:${field}`,
        label,
        `Stresses · ${qualifier.title}`,
        type,
        ["esy", "yc"].includes(field) ? "y" : "z",
      );
      series.add(id, x, descriptor, undefinedForMaterial ? null : value(field, row));
    }
  }
  const tendons = read.tendons;
  if (!tendons?.count) return;
  const tendonValue = fieldsOf(tendons);
  for (let row = 0; row < tendons.count; row += 1) {
    const id = elementIdOf(elementNumber(tendons, row));
    if (id == null) continue;
    const tendon = Math.abs(tendons.columns.nrs[row]);
    for (const [field, title] of [
      ["sig", "Tendon stress"],
      ["dsig", "Tendon stress range"],
    ]) {
      series.add(
        id,
        tendonValue("x", row),
        quantity(`tendon:${tendon}:${field}`, title, `Stresses · Tendon ${tendon}`, "stress"),
        tendonValue(field, row),
      );
    }
  }
}

function addThrustLines(series) {
  const definitions = [
    ["thrust:y", "Thrust-line distance in local y", "y"],
    ["thrust:z", "Thrust-line distance in local z", "z"],
    ["thrust:total", "Resultant thrust-line distance", "z"],
  ].map(([id, title, plane]) =>
    quantity(id, title, "Thrust line · elastic centre", "length", plane),
  );
  for (const descriptor of definitions) series.declare(descriptor);
  for (const [id, curves] of series.members) {
    const axial = curves.get("N");
    const my = curves.get("My");
    const mz = curves.get("Mz");
    if (!axial || !my || !mz) continue;
    // Force components share one source grid, including both banks of a jump.
    const order = axial.map((_value, index) => index).sort((a, b) => axial[a].x - axial[b].x);
    for (let index = 0; index < order.length; index += 1) {
      const row = order[index];
      const { x, value: n } = axial[row];
      const ratio = (moment) =>
        n && moment != null && Number.isFinite(moment / n) ? moment / n : null;
      const yRatio = ratio(mz[row].value);
      const y = yRatio == null ? null : -yRatio;
      const z = ratio(my[row].value);
      const values = [y, z, y != null && z != null ? Math.hypot(y, z) : null];
      definitions.forEach((descriptor, part) => series.add(id, x, descriptor, values[part]));
      const previous = axial[order[index - 1]];
      // An axial-force zero inside a segment is an asymptote of M/N, not a
      // straight connection between two finite offsets on opposite sides.
      if (previous && previous.x < x && previous.value * n < 0) {
        const zero = previous.x + (x - previous.x) * (-previous.value / (n - previous.value));
        for (const descriptor of definitions) series.add(id, zero, descriptor, null);
      }
    }
  }
}

function addAxisThrustLines(series) {
  const definitions = [
    ["thrustAxis:y", "Thrust-line distance in local y", "y"],
    ["thrustAxis:z", "Thrust-line distance in local z", "z"],
    ["thrustAxis:total", "Resultant thrust-line distance", "z"],
  ].map(([id, title, plane]) =>
    quantity(id, title, "Thrust line · reference axis", "length", plane),
  );
  for (const [id, curves] of series.members) {
    const sourceIds = ["thrust:y", "thrust:z", "section:ys", "section:zs"];
    const sources = sourceIds.map((name) => curves.get(name));
    if (sources.some((source) => !source)) continue;
    const grid = new Map();
    for (const curve of sources) {
      curve.sort((a, b) => a.x - b.x);
      for (let index = 0; index < curve.length; index += 1) {
        const { x } = curve[index];
        grid.set(x, Math.max(grid.get(x) || 1, curve[index + 1]?.x === x ? 2 : 1));
      }
    }
    for (const [x, count] of grid) {
      for (let side = 0; side < count; side += 1) {
        const [ty, tz, ys, zs] = sources.map((source) => sampleCurve(source, x, side));
        const y = ty != null && ys != null ? ty + ys : null;
        const z = tz != null && zs != null ? tz + zs : null;
        const values = [y, z, y != null && z != null ? Math.hypot(y, z) : null];
        definitions.forEach((descriptor, part) => series.add(id, x, descriptor, values[part]));
      }
    }
  }
}

function addHinges(series, read, elementIdOf) {
  const value = fieldsOf(read);
  const names = ["N", "Vy", "Vz", "Mt", "My", "Mz"];
  for (let row = 0; row < read.count; row += 1) {
    const id = elementIdOf(elementNumber(read, row));
    const component = read.columns.typ[row] - 11;
    if (id == null || component < 0 || component > 5) continue;
    const name = names[component];
    const rotational = component >= 3;
    const plane = [1, 5].includes(component) ? "y" : "z";
    const sign = component === 5 ? -1 : 1;
    const group = `Hinge · ${name}`;
    const at = value("x", row);
    const add = (suffix, title, type, held) =>
      series.add(
        id,
        at,
        quantity(
          `hinge:${name}:${suffix}`,
          title,
          group,
          type,
          type === "ratio" ? "z" : plane,
          type === "ratio" ? 1 : sign,
          "point",
        ),
        held,
      );
    const reaction = value("reac", row);
    add(
      "reaction",
      `${name} reaction`,
      rotational ? "moment" : "force",
      reaction == null ? null : reaction * siFactor(rotational ? 1103 : 1101),
    );
    add(
      "total",
      "Total hinge deformation",
      rotational ? "rotation" : "displacement",
      value("stv", row, 0),
    );
    if ([1, 2, 3].includes(read.columns.mtyp[row])) {
      add(
        "plasticNegative",
        "Plastic deformation in compression",
        rotational ? "rotation" : "displacement",
        value("stv", row, 1),
      );
      add(
        "plasticPositive",
        "Plastic deformation in tension",
        rotational ? "rotation" : "displacement",
        value("stv", row, 2),
      );
    } else if ([5, 6].includes(read.columns.mtyp[row])) {
      const state = [
        [1, "maximumNegative", "Maximum deformation in compression"],
        [2, "maximumPositive", "Maximum deformation in tension"],
        [3, "forceApexNegative", "Negative inner-loop force", true],
        [4, "deformationApexNegative", "Negative inner-loop deformation"],
        [5, "forceApexPositive", "Positive inner-loop force", true],
        [6, "deformationApexPositive", "Positive inner-loop deformation"],
        [7, "unloadedNegative", "Unloaded negative-branch deformation"],
        [8, "unloadedPositive", "Unloaded positive-branch deformation"],
        [9, "targetNegative", "Target negative-branch deformation"],
        [10, "targetPositive", "Target positive-branch deformation"],
      ];
      for (const [index, suffix, title, force] of state) {
        const held = value("stv", row, index);
        add(
          suffix,
          title,
          force ? (rotational ? "moment" : "force") : rotational ? "rotation" : "displacement",
          held != null && force ? held * siFactor(rotational ? 1103 : 1101) : held,
        );
      }
    }
    for (let category = 0; category < 6; category += 1) {
      add(
        `performance${category}`,
        category ? `Performance index · category ${category}` : "Performance index",
        "ratio",
        value("pidx", row, category),
      );
    }
  }
}

async function assertPhysicalResultCase(database, loadCaseId) {
  const loadCase = await readOptional(database, "loadCase", loadCaseId);
  if (loadCase.columns.kind?.[0] === 3) {
    throw new RangeError(
      "This load case contains influence coefficients. Results require the response normalization and load direction, which this source does not yet provide.",
    );
  }
}

async function readMemberDiagram(database, loadCaseId, elementIdOf) {
  await assertPhysicalResultCase(database, loadCaseId);
  const [forces, beamOnly, stresses, hinges, sectionState] = await Promise.all(
    MEMBER_RECORDS.map((name) => readOptional(database, name, loadCaseId)),
  );
  for (const read of [forces, beamOnly]) {
    if (!read.count) continue;
    for (const name of ["x", "n", "vy", "vz", "mt", "my", "mz"]) {
      if (!read.columns[name] || read.columns[name].length !== read.count)
        throw new RangeError(`The CDB beam force result has no complete ${name} column.`);
    }
  }
  const series = new MemberSeries();
  addFields(series, forces, elementIdOf, FORCE_FIELDS, "Internal forces");
  addFields(series, forces, elementIdOf, DEFORMATION_FIELDS, "Local deformations");
  addFields(series, forces, elementIdOf, BEDDING_FIELDS, "Bedding forces");
  if (ENHANCED_MODE_FIELDS.some(([name]) => forces.columns[name])) {
    addFields(series, forces, elementIdOf, ENHANCED_MODE_FIELDS, "Enhanced local modes", "eas:");
  }
  addThrustLines(series);
  if (sectionState.count) {
    addFields(
      series,
      sectionState,
      elementIdOf,
      SECTION_STATE_FIELDS,
      "Section mechanical state",
      "section:",
    );
    addAxisThrustLines(series);
  }
  if (beamOnly.count)
    addFields(
      series,
      beamOnly,
      elementIdOf,
      FORCE_FIELDS,
      "Internal forces without plate contributions",
      "beamOnly:",
    );
  addStresses(series, stresses, elementIdOf);
  addHinges(series, hinges, elementIdOf);
  return series.result();
}

module.exports = { MEMBER_RECORDS, readMemberDiagram, assertPhysicalResultCase };
