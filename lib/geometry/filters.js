const { groupOf, packedName, secondaryGroupSelection } = require("@lumine-code/sofistik-reader");
const { finitePositive } = require("./values");
// CDB family codes mapped to Graviss element kinds; unmapped families have no rendered elements.
const SECONDARY_GROUP_KINDS = new Map([
  [100, "beam"],
  [150, "truss"],
  [160, "cable"],
  [170, "spring"],
  [200, "shell"],
]);

// Groups are named by whole records; per-element-type short forms carry no name.
function readGroups(read) {
  const groups = [];
  if (!read?.count) return groups;
  for (let index = 0; index < read.count; index += 1) {
    if (read.columns.typ?.[index] !== 0) continue;
    const ng = read.columns.ng[index];
    if (!Number.isFinite(ng)) continue;
    const title = read.columns.text?.[index];
    groups.push({ ng, min: read.columns.min?.[index] ?? 0, title: title || null });
  }
  groups.sort((left, right) => left.min - right.min);
  return groups;
}

// The dimensions this source divides a model along, and what each element holds
// of them. Graviss names none of these and filters by whatever it is handed, so
// everything SOFiSTiK-specific about a group stops here.
//
// Each type declares the kinds it turned out to be about, so the viewer can
// offer "Group (trusses)" only where the model can tell it apart - and numeric
// dimensions declare no value list at all: a range says what it means without
// one, and the reference axes alone would otherwise be hundreds of untitled
// value objects built purely to satisfy a validator.
function buildFilterTypes(elements, groups, divisor, secondaryGroups = null) {
  const filterTypes = [];
  const held = new Map();
  const hold = (element, key, value) => {
    held.set(element, { ...(held.get(element) || {}), [key]: value });
  };
  const kindsOf = (entries) => {
    const kinds = new Set();
    for (const [element] of entries) kinds.add(element.kind);
    return [...kinds].sort();
  };

  const grouped = [];
  for (const element of elements) {
    const group = groupOf(element.number, divisor, groups);
    if (group == null) continue;
    grouped.push([element, group]);
    hold(element, "group", group);
  }
  if (grouped.length) {
    // Titles only where the source actually named a group; most models name
    // none, and then there is no list at all.
    const named = groups.filter(({ title }) => title);
    filterTypes.push({
      id: "group",
      title: "Group",
      quickFilterCode: "G",
      numeric: true,
      kinds: kindsOf(grouped),
      hint: "11, 12, 21-29",
      ...(named.length ? { values: named.map(({ ng, title }) => ({ id: ng, title })) } : {}),
    });
  }

  // The geometric line a member was generated along - the number SOFiMSHC shows
  // for it. A quad states no such thing, so this covers line elements and says
  // so by declaring only the kinds that held one.
  const axial = [];
  for (const element of elements) {
    const axis = element.referenceAxis;
    if (!Number.isFinite(axis) || axis <= 0) continue;
    axial.push([element, axis]);
    hold(element, "line", axis);
  }
  if (axial.length) {
    filterTypes.push({
      id: "line",
      title: "Structural line",
      quickFilterCode: "L",
      numeric: true,
      kinds: kindsOf(axial),
      hint: "1030, 1040-1050",
    });
  }

  // Secondary groups, by the four-character names a user gives them. Unlike a
  // group, an element may be in several at once - the help is explicit - so the
  // dimension is many-valued and its values are names rather than numbers.
  if (secondaryGroups?.size) {
    const membership = [];
    for (const element of elements) {
      const names = secondaryGroups.get(`${element.kind}:${element.number}`);
      if (!names?.length) continue;
      membership.push([element, names]);
      hold(element, "secondaryGroup", names);
    }
    if (membership.length) {
      const names = [...new Set([...secondaryGroups.values()].flat())].sort();
      filterTypes.push({
        id: "secondaryGroup",
        title: "Secondary group",
        quickFilterCode: "SG",
        multiple: true,
        kinds: kindsOf(membership),
        values: names.map((id) => ({ id })),
      });
    }
  }

  for (const [element, values] of held) element.filterValues = values;
  // `referenceAxis` is how a member said which axis it came from, and it is not
  // part of the contract - the filter type is.
  for (const element of elements) delete element.referenceAxis;
  return filterTypes;
}

// Calculated selective lists are scoped by CDB family code before Graviss IDs
// are assigned, so overlapping element numbers never select another family.
async function readSecondaryGroups(database, elements) {
  const names = await database.keys("secondaryGroups");
  if (!names?.length) return null;
  const byKind = new Map();
  for (const element of elements) {
    if (!finitePositive(element.number)) continue;
    let rows = byKind.get(element.kind);
    if (!rows) byKind.set(element.kind, (rows = []));
    rows.push(element);
  }
  const membership = new Map();
  for (const key of names) {
    const read = await database.read("secondaryGroups", key, { decodePolicy: "variable-tail" });
    const title = packedName(key);
    const list = read.list;
    if (!title || !list?.count || !list.columns?.id || !list.columns.nr) continue;
    const width =
      list.fields?.find(({ name }) => name === "nr")?.count ?? list.columns.nr.length / list.count;
    if (!Number.isInteger(width) || width <= 0) continue;
    for (let row = 0; row < list.count; row += 1) {
      const kind = SECONDARY_GROUP_KINDS.get(list.columns.id[row]);
      if (!kind) continue;
      const numbers = list.columns.nr.slice(row * width, (row + 1) * width);
      const { ranges } = secondaryGroupSelection(numbers);
      // Inspect only actual model elements rather than allocating a member
      // for every integer in a possibly sparse range of millions of numbers.
      for (const element of byKind.get(kind) ?? []) {
        if (
          !ranges.some(
            ([from, to]) =>
              element.number >= Math.min(from, to) && element.number <= Math.max(from, to),
          )
        )
          continue;
        const id = `${kind}:${element.number}`;
        let held = membership.get(id);
        if (!held) membership.set(id, (held = []));
        if (!held.includes(title)) held.push(title);
      }
    }
  }
  return membership.size ? membership : null;
}

module.exports = { readGroups, buildFilterTypes, readSecondaryGroups };
