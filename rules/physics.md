# Physics rules (intent-harness)

Stable world constraints the C# policy gate enforces (`severity: block`).
Encoding lives in `plugin/src/PolicyEngine.cs` (see also `RulesIndex` in `IntentStore.cs`).

| id | severity | rule | fix guidance |
|----|----------|------|--------------|
| `valid_geometry` | block | Geometry must be `IsValid`; no NaN/degenerate edges | Rebuild the solid; check input curves |
| `nonzero_size` | block | Brep/Mesh/SubD volume and area both ≤ ε (ε = model abs tolerance) | Thickness/height collapsed — increase size |
| `not_duplicate` | block | No create that matches an existing object's bbox + type + name | Delete the old one or change name/position |
| `no_floating` | block | Bbox min Z must sit on Z=0 or on top of another mass (`allow.floating=true` to override) | Move to ground or podium top |
| `stack_no_gap` | block | Vertical gaps between stacked masses must be ≤ tolerance (`allow.floating=true` to override) | Close the gap or mark intentional |
| `wall_thickness` | block | Wall-like breps (aspect ≥ 4:1:1) need thickness > `ModelAbsoluteTolerance` | Give the wall real thickness |
| `slab_planar` | block | Floor slabs (name contains slab/floor/plate) must be planar and horizontal | Use a planar horizontal face |
