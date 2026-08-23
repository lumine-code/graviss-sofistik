# graviss-sofistik

Read finite element models from SOFiSTiK CDB databases.

> **NOTE**: This package is not an official SOFiSTiK product and is not affiliated with or endorsed by SOFiSTiK AG.

## Features

- **Database geometry**: reads nodes, beams, trusses, cables, shells, springs and the way they act, couplings, restraints, exact section contours, per-corner thicknesses, and element-local axes from `.cdb` databases.
- **Section detail**: reads the plates a welded or rolled section is built from, so a plate girder is drawn as the girder it is rather than as the rectangle of equivalent stiffness, and the plates and polygons a NEFF rule marked, so the part of a section that is there and does not carry is drawn as such.
- **Axial member orientation**: gives a truss or a cable the local frame a beam of the same axis would have stored, since the record stores none, so an asymmetric section stands the way up the model means it to.
- **Analysis results**: lists the load cases a database was solved for, reads the node displacements and beam stations of one of them, and converts every quantity to SI, since a CDB stores metres and kilonewtons rather than the base units the contract is written in.
- **Model divisions**: registers groups, secondary groups and structural lines as filter types the viewer can narrow a model by, with the numbers SOFiMSHC shows - group membership is the element number over the divisor the system record states, and a secondary group is the calculated element list stored under its four-character name.
- **Eccentric shells**: reads a quad's eccentricity flags as the offset the element is drawn at, measured the way the viewer measures it.
- **Coordinate-system fidelity**: reads the CDB gravity axis so Graviss can orient navigation and reference graphics without changing model coordinates, and falls back to the convention the system type names where a database declares no gravity at all.
- **Source discovery**: resolves an explicit relative source or a same-basename `.cdb` database beside a `.grv` document.
- **Data only, through an isolated reader**: supplies model data to Graviss, which owns the canvas and every command, and delegates each session to `@lumine-code/sofistik-reader`, which owns its subprocess and reads every record layout from the installation that owns the interface.

## Installation

To install `graviss-sofistik` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/graviss-sofistik`.

## Services

- `graviss.source`: provided to Graviss so it can discover and read SOFiSTiK CDB databases.
- `sofistik.environment`: consumed to resolve the SOFiSTiK version, installation folder and licensed edition for the database path.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
