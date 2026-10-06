# Style rules (intent-harness)

Discipline rules from `lessons.json` + AIA layer practice. All `severity: block`
unless noted. Encoded in `plugin/src/PolicyEngine.cs` / `SceneAudit`.

| id | severity | rule | fix guidance |
|----|----------|------|--------------|
| `style_named` | block | Every created object has a non-empty name (`allow.unnamed=true` to override) | Name it after intent vocabulary |
| `style_layer` | block | Object is not on `Default` once other layers exist | `rhino_ensure_layer` then assign |
| `style_layer_match` | block | Type → layer: glazing→`A-GLAZ`, wall→`A-WALL-*`, slab→`A-FLOR-*` | Use the matching AIA layer |
| `style_count` | block | Object count ≤ `limits.max_objects` (default 2000) | Delete junk or raise limit in intent |
| `style_subd` | block | SubD only if `intent.allow.subd` (default false). Creation uses `ConvexCornersAndInteriorCreases` (architectural sharpness; RhinoCommon has no `SubD.Sharpness`) | Prefer Brep massing; lessons.json `subd-mesh-freeze` |
| `style_mesh` | block | Mesh only if `intent.allow.mesh` (default true) | — |
| `intent_vocabulary` | block | Massing names must use intent vocabulary or a massing `name_contains` | Rename with tower/podium/core/… |
| `intent_massing` | block | Massing proportions (min/max height, aspect, footprint) | Adjust geometry or relax the rule |

Naming language: prefer intent vocabulary tokens (`tower`, `podium`, `core`,
`facade`, `slab`, `wall`, `glaz`) in object names so scene audits and the
agent share one language.
