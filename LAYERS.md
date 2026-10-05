# Architecture layer standard (Rhino MCP)

## Systems compared

| System | Region | Name shape | Best for |
|--------|--------|------------|----------|
| **AIA CAD Layer Guidelines / NCS** | US | `A-WALL-EXTR` | Architecture practices, Rhino offices |
| **ISO 13567** | Intl | `A-P2110-E1` | Export, EU/UK, coded classification |
| **Uniclass 2015** | UK BIM | `Ss_25_10_30` | Spec/IFC-linked BIM, not layer strings |

**We use AIA/NCS as the default** (readable in Rhino, maps to room/building thinking).
ISO 13567 available via `rhino_setup_layers scheme=iso13567` if a job requires it.

## AIA/NCS tree (default)

```
00-SITE
  G-TOPO          terrain, topo surfaces
  G-SITE          site elements
  G-GRID          grids, levels, datums
A-ARCH
  A-FLOR-SLAB     structural floor plates
  A-FLOR-FNSH     finish floors
  A-WALL-EXTR     exterior walls / massing
  A-WALL-INTE     interior partitions
  A-WALL-PRHT     parapets, railings
  A-GLAZ          glass ribbons, curtain
  A-DOOR          doors, entrance
  A-ROOF          roof slab / cap
  A-STRS          stairs, cores vertical
  A-CEIL          ceilings
  A-FURN          furniture
  A-ANNO          dimensions, text (model)
S-STRC
  S-COLS  S-BEAM  S-SLAB  S-REIN
M-MECH
  M-HVAC  M-PLMB  M-ELEC
X-XREF
  X-TEMP  X-CLASH
```

Rhino nested layers: `A-ARCH` parent → `A-WALL-EXTR` child.
Color by class (walls neutral, glass blue-cyan, slabs white, accents orange).

## Tools

| Tool | Use |
|------|-----|
| `rhino_get_document` | Units, tolerances, object inventory, layer summary |
| `rhino_get_layers` | Tree + color + visible/locked + **object counts** (hygiene) |
| `rhino_ensure_layer` | Create nested layer, optional color/current |
| `rhino_setup_layers` | Idempotent template (`aia` \| `iso13567`) |

## Hygiene rules

1. One building system per layer family (no “Misc” dumping).
2. Empty layers are fine to leave; **named junk layers** are not — purge or rename.
3. Object names = type + storey (`L2_Walls`, `Glass_L1_S`); layer = class.
4. All geometry on a real layer, never Default, after the template is applied.
