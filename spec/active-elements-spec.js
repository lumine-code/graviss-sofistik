const { activeElementIds, readActiveGroups } = require("../lib/results/active-elements");

describe("load-case group participation", () => {
  it("reads participation from INF, including short family records and non-active stage flags", async () => {
    const database = {
      read: jasmine.createSpy("read").and.resolveTo({
        count: 5,
        columns: {
          ng: Int32Array.of(11, 11, 51, 60, 99),
          typ: Int32Array.of(100, 0, 0, 21, 21),
          inf: Int32Array.of(7, 7, 10237953, 11269, 7),
          faks: Float32Array.of(0, 1, 1, 0, 0),
        },
      }),
    };
    expect(await readActiveGroups(database, 4011)).toEqual(
      new Map([
        [11, true],
        [51, false],
        [60, false],
        [99, true],
      ]),
    );
    expect(database.read).toHaveBeenCalledWith("loadCaseGroups", 4011, {
      decodePolicy: "variable-tail",
    });
  });

  it("leaves participation unspecified when case-specific group data is absent or unavailable", async () => {
    expect(
      await readActiveGroups({ read: async () => ({ count: 0, columns: {} }) }, 302),
    ).toBeNull();
    const unavailable = Object.assign(new Error("No record in this release"), {
      code: "ERR_CDB_RECORD_UNAVAILABLE",
    });
    expect(
      await readActiveGroups(
        {
          read: async () => {
            throw unavailable;
          },
        },
        302,
      ),
    ).toBeNull();
  });

  it("does not hide a failure to decode the case's participation", async () => {
    const failure = Object.assign(new Error("Truncated group status"), {
      code: "ERR_CDB_LAYOUT_MISMATCH",
    });
    await expectAsync(
      readActiveGroups(
        {
          read: async () => {
            throw failure;
          },
        },
        4011,
      ),
    ).toBeRejectedWith(failure);
  });

  it("masks explicitly excluded groups across element kinds, retaining unclassified elements", () => {
    const geometry = {
      elements: [
        { id: "beam-110001", filterValues: { group: 11 } },
        { id: "quad-510001", filterValues: { group: 51 } },
        { id: "spring-610001", filterValues: { group: 61 } },
        { id: "coupling-12-13", filterValues: { group: 60 } },
        { id: "coupling-14-15", filterValues: { group: 99 } },
        { id: "ungrouped" },
        { id: "unspecified", filterValues: { group: 42 } },
      ],
    };
    expect(
      activeElementIds(
        geometry,
        new Map([
          [11, true],
          [51, false],
          [61, false],
          [60, false],
          [99, true],
        ]),
      ),
    ).toEqual(["beam-110001", "coupling-14-15", "ungrouped", "unspecified"]);
  });
});
