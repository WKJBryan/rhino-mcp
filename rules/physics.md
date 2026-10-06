# Physics rules (intent-harness)

Stable world constraints the C# policy gate enforces. The agent should follow
these in session language and `intent.json`; the plugin blocks violations.

| id | rule | fix guidance |
|----|------|--------------|
| `valid_geometry` | Geometry must be `IsValid`; no NaN/degenerate edges | Rebuild the solid; check input curves |
| `nonzero_size` | Brep/Mesh/SubD volume or face area > ε (ε = model abs tolerance) | Thickness/height collapsed — increase size |
| `not_duplicate` | No create that matches an existing object's bbox + type + name | Delete the old one or change name/position |
| `no_floating` | Bbox min Z must sit on Z=0 or on top of another mass (`allow.floating=true` to override) | Move to ground or podium top |
| `wall_thickness` | Wall-like breps (aspect ≥ 4:1:1) need thickness > `ModelAbsoluteTolerance` | Give the wall real thickness |
| `slab_planar` | Floor slabs (name contains slab/floor/plate) must be planar and horizontal | Use a planar horizontal face |
| `stack_no_gap` | Vertical gaps between stacked masses < 20% of lower mass height (unless allowed) | Close the gap or mark intentional |

Encoding lives in `plugin/src/PhysicsRules.cs` — keep ids in sync.
