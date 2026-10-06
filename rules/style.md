# Style rules (intent-harness)

Discipline rules from `lessons.json` + AIA layer practice. Enforced as
`style_*` policy codes.

| id | rule | fix guidance |
|----|------|--------------|
| `style_named` | Every created object has a non-empty name (`allow.unnamed=true` to override) | Name it after intent vocabulary |
| `style_layer` | Object is not on `Default` once other layers exist | `rhino_ensure_layer` then assign |
| `style_layer_match` | Type → layer: glazing→`A-GLAZ`, wall→`A-WALL-*`, slab→`A-FLOR-*`, core→`S-*` or name `Core` | Use the matching AIA layer |
| `style_count` | Object count ≤ `limits.max_objects` (default 2000) | Delete junk or raise limit in intent |
| `style_subd` | SubD only if `intent.allow.subd` (default false); sharpness ≥ 3 | Prefer Brep massing; lessons.json `subd-mesh-freeze` |
| `style_mesh` | Mesh only if `intent.allow.mesh` (default true) | — |

Naming language: prefer intent vocabulary tokens (`tower`, `podium`, `core`,
`facade`, `slab`, `wall`, `glaz`) in object names so scene audits and the
agent share one language.
