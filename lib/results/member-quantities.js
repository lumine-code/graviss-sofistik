const UNITS = {
  force: ["N", "kN", 0.001],
  moment: ["N·m", "kN·m", 0.001],
  bimoment: ["N·m²", "kN·m²", 0.001],
  rigidity: ["N·m²", "kN·m²", 0.001],
  displacement: ["m", "mm", 1000],
  length: ["m", "m", 1],
  rotation: ["rad", "mrad", 1000],
  curvature: ["1/m", "1/km", 1000],
  lineForce: ["N/m", "kN/m", 0.001],
  stress: ["Pa", "MPa", 0.000001],
  ratio: ["1", "1", 1],
  strain: ["1", "‰", 1000],
};

function quantity(id, title, group, type, plane = "z", directionSign = 1, interpolation) {
  const [unit, displayUnit, displayFactor] = UNITS[type];
  return {
    id,
    title,
    group,
    unit,
    displayUnit,
    displayFactor,
    plane,
    directionSign,
    ...(interpolation ? { interpolation } : {}),
  };
}

const FORCE_FIELDS = [
  ["n", "N", "Axial force", "force", "z", 1],
  ["vy", "Vy", "Shear force in local y", "force", "y", 1],
  ["vz", "Vz", "Shear force in local z", "force", "z", 1],
  ["mt", "Mt", "Total torsional moment", "moment", "z", 1],
  ["my", "My", "Bending moment about local y", "moment", "z", 1],
  ["mz", "Mz", "Bending moment about local z", "moment", "y", -1],
  ["mb", "Mb", "Warping bimoment", "bimoment", "z", 1],
  [null, "Mt1", "Primary torsional moment", "moment", "z", 1],
  ["mt2", "Mt2", "Secondary torsional moment", "moment", "z", 1],
  ["mt3", "Mt3", "Tertiary torsional moment", "moment", "z", 1],
];

const DEFORMATION_FIELDS = [
  ["ux", "ux", "Displacement in local x", "displacement", "z"],
  ["uy", "uy", "Displacement in local y", "displacement", "y"],
  ["uz", "uz", "Displacement in local z", "displacement", "z"],
  ["phix", "phix", "Rotation about local x", "rotation", "z"],
  ["phiy", "phiy", "Rotation about local y", "rotation", "z"],
  ["phiz", "phiz", "Rotation about local z", "rotation", "y"],
  ["phiw", "phiw", "Twisting", "curvature", "z"],
];

const BEDDING_FIELDS = [
  ["pa", "pa", "Axial bedding force", "lineForce", "z"],
  ["pt", "pt", "Transverse bedding force", "lineForce", "z"],
  ["pty", "pty", "Bedding force in local y", "lineForce", "y"],
  ["ptz", "ptz", "Bedding force in local z", "lineForce", "z"],
];

const ENHANCED_MODE_FIELDS = [
  ["alph_x", "alph_x", "Additional axial displacement mode", "displacement", "z"],
  ["beta_x", "beta_x", "Additional torsional rotation mode", "rotation", "z"],
  ["beta_y", "beta_y", "Additional rotation mode about local y", "rotation", "z"],
  ["beta_z", "beta_z", "Additional rotation mode about local z", "rotation", "y"],
  ["beta_w", "beta_w", "Additional twisting mode", "curvature", "z"],
  ["alph2_x", "alph2_x", "Second additional axial displacement mode", "displacement", "z"],
  ["beta2_x", "beta2_x", "Second additional torsional rotation mode", "rotation", "z"],
  ["beta2_y", "beta2_y", "Second additional rotation mode about local y", "rotation", "z"],
  ["beta2_z", "beta2_z", "Second additional rotation mode about local z", "rotation", "y"],
  ["beta2_w", "beta2_w", "Second additional twisting mode", "curvature", "z"],
];

const STRESS_FIELDS = [
  ["sigc", "Minimum normal stress", "stress"],
  ["sigt", "Maximum normal stress", "stress"],
  ["tau", "Shear stress", "stress"],
  ["sigv", "Equivalent stress", "stress"],
  ["si", "Principal tensile stress", "stress"],
  ["sii", "Principal compressive stress", "stress"],
  ["sigo", "Uniaxial upper-fibre stress", "stress"],
  ["sigu", "Uniaxial lower-fibre stress", "stress"],
  ["dsig", "Normal stress range", "stress"],
  ["dtau", "Shear stress range", "stress"],
  ["sigw", "Weld stress", "stress"],
  ["vb", "Bond force", "lineForce"],
  ["fak_vv", "Shear reduction factor", "ratio"],
  ["n_part", "Partial-section axial force", "force"],
  ["sigct", "Decompression stress", "stress"],
  ["es0", "Strain at partial-section centre", "strain"],
  ["esy", "Strain gradient in local y", "curvature"],
  ["esz", "Strain gradient in local z", "curvature"],
  ["yc", "Partial-section centre in local y", "length"],
  ["zc", "Partial-section centre in local z", "length"],
];

// DATEN 103/LC holds stiffness and mechanical state. The explicit unit table
// defines 62 as kN, 83 as kN*m² and 17 as 1/m; implicit 1026 stores metres.
const SECTION_STATE_FIELDS = [
  ["ea", "ea", "Axial stiffness EA", "force", "z"],
  ["gay", "gay", "Shear stiffness GAy", "force", "y"],
  ["gaz", "gaz", "Shear stiffness GAz", "force", "z"],
  ["gayz", "gayz", "Coupled shear stiffness GAyz", "force", "z"],
  ["git", "git", "Torsional stiffness GIt", "rigidity", "z"],
  ["eiy", "eiy", "Bending stiffness EIy", "rigidity", "z"],
  ["eiz", "eiz", "Bending stiffness EIz", "rigidity", "y"],
  ["eiyz", "eiyz", "Coupled bending stiffness EIyz", "rigidity", "z"],
  ["eiy0", "eiy0", "Linear bending stiffness EIy", "rigidity", "z"],
  ["eiz0", "eiz0", "Linear bending stiffness EIz", "rigidity", "y"],
  ["kpy", "kpy", "Plastic curvature about local y", "curvature", "z"],
  ["kpz", "kpz", "Plastic curvature about local z", "curvature", "y"],
  ["gkpy", "gkpy", "Total curvature about local y", "curvature", "z"],
  ["gkpz", "gkpz", "Total curvature about local z", "curvature", "y"],
  ["ccw", "ccw", "Current crack opening", "displacement", "z"],
  ["ni", "ni", "Inner axial force", "force", "z"],
  ["vyi", "vyi", "Inner shear force in local y", "force", "y"],
  ["vzi", "vzi", "Inner shear force in local z", "force", "z"],
  ["mti", "mti", "Inner torsional moment", "moment", "z"],
  ["myi", "myi", "Inner bending moment about local y", "moment", "z"],
  ["mzi", "mzi", "Inner bending moment about local z", "moment", "y", -1],
  ["mbi", "mbi", "Inner warping bimoment", "bimoment", "z"],
  ["e0", "e0", "Total axial strain", "strain", "z"],
  ["emin", "emin", "Minimum fibre strain", "strain", "z"],
  ["emax", "emax", "Maximum fibre strain", "strain", "z"],
  ["erf_min", "erf_min", "Minimum reinforcement strain", "strain", "z"],
  ["erf_max", "erf_max", "Maximum reinforcement strain", "strain", "z"],
  ["ys", "ys", "Elastic-centre eccentricity in local y", "length", "y"],
  ["zs", "zs", "Elastic-centre eccentricity in local z", "length", "z"],
  ["dysm", "dysm", "Shear-centre offset in local y", "length", "y"],
  ["dzsm", "dzsm", "Shear-centre offset in local z", "length", "z"],
  ["pre", "pre", "Primary axial force", "force", "z"],
  ["kfvy", "kfvy", "Plastic shear factor in local y", "ratio", "y"],
  ["kfvz", "kfvz", "Plastic shear factor in local z", "ratio", "z"],
  ["kfmt", "kfmt", "Plastic torsion factor", "ratio", "z"],
];

module.exports = {
  quantity,
  FORCE_FIELDS,
  DEFORMATION_FIELDS,
  BEDDING_FIELDS,
  ENHANCED_MODE_FIELDS,
  STRESS_FIELDS,
  SECTION_STATE_FIELDS,
};
