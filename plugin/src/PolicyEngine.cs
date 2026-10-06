using System;
using System.Collections.Generic;
using System.Linq;
using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace IntentHarness
{
    /// <summary>
    /// Block + explain policy checks (S2.3). Pure-ish: takes geometry + doc
    /// snapshot; returns ok or a structured PolicyBlock.
    /// </summary>
    public static class PolicyEngine
    {
        const double EpsFactor = 1.0;

        public static object CheckCreate(
            RhinoDoc doc,
            GeometryBase geometry,
            string name,
            string layerPath,
            string kind // mass | subd | mesh | other
        )
        {
            var intent = IntentStore.Current ?? new IntentDoc();
            var objInfo = new Dictionary<string, object>
            {
                { "name", name ?? "" },
                { "layer", layerPath ?? "" },
                { "kind", kind ?? "other" },
                { "type", geometry != null ? geometry.GetType().Name : "null" }
            };

            if (geometry == null)
                return Block("valid_geometry", "Geometry is null.", new[] { "Create real geometry." }, objInfo);

            bool isValid = geometry.IsValid;
            if (!isValid)
                return Block("valid_geometry", "Geometry.IsValid == false.", new[] { "Rebuild the solid; check input curves." }, objInfo);

            double tol = doc != null ? doc.ModelAbsoluteTolerance : 0.001;
            var bb = geometry.GetBoundingBox(true);
            if (!bb.IsValid)
                return Block("nonzero_size", "Bounding box is invalid.", new[] { "Increase size; remove degenerate edges." }, objInfo);

            double vol = 0, area = 0;
            try
            {
                var br = geometry as Brep;
                if (br != null)
                {
                    vol = br.GetVolume();
                    area = br.GetArea();
                }
                else if (geometry is Mesh m)
                {
                    area = AreaMassProperties.Compute(m)?.Area ?? 0;
                }
                else if (geometry is SubD s)
                {
                    var brep = s.ToBrep();
                    if (brep != null)
                    {
                        vol = brep.GetVolume();
                        area = brep.GetArea();
                    }
                }
            }
            catch { /* measure is best-effort */ }

            bool isSolidLike = kind == "mass" || kind == "subd" || geometry is Brep || geometry is SubD;
            if (isSolidLike && vol <= tol * EpsFactor && area <= tol * EpsFactor)
                return Block("nonzero_size",
                    string.Format("Volume/area collapsed (vol={0}, area={1}).", vol, area),
                    new[] { "Thickness/height collapsed — increase size." }, objInfo);

            // Mechanical: not_duplicate (bbox + type + name)
            if (!string.IsNullOrEmpty(name) && doc != null)
            {
                foreach (var obj in doc.Objects)
                {
                    try
                    {
                        var oname = obj.Attributes != null ? obj.Attributes.Name : null;
                        if (!string.Equals(oname, name, StringComparison.OrdinalIgnoreCase)) continue;
                        var obb = obj.Geometry.GetBoundingBox(true);
                        if (!obb.IsValid || !bb.IsValid) continue;
                        bool sameBox =
                            Math.Abs(obb.Min.X - bb.Min.X) < tol * 10 &&
                            Math.Abs(obb.Min.Y - bb.Min.Y) < tol * 10 &&
                            Math.Abs(obb.Min.Z - bb.Min.Z) < tol * 10 &&
                            Math.Abs(obb.Max.X - bb.Max.X) < tol * 10 &&
                            Math.Abs(obb.Max.Y - bb.Max.Y) < tol * 10 &&
                            Math.Abs(obb.Max.Z - bb.Max.Z) < tol * 10;
                        if (sameBox)
                            return Block("not_duplicate",
                                string.Format("Object '{0}' duplicates an existing bbox+name.", name),
                                new[] { "Delete the old one or change name/position." }, objInfo);
                    }
                    catch { }
                }
            }

            // Physics: no floating (unless allowed)
            if (!intent.allow.floating)
            {
                double minZ = bb.Min.Z;
                bool onGround = Math.Abs(minZ) <= Math.Max(tol * 10, 1.0);
                if (!onGround)
                {
                    bool onMass = SitsOnExisting(doc, bb, tol);
                    if (!onMass)
                        return Block("no_floating",
                            string.Format("Object '{0}' bbox min Z={1:0.##} does not sit on ground or another mass.", name, minZ),
                            new[] { "Move to Z=0 or attach to podium.", "If intentional, set intent.allow.floating=true" },
                            objInfo);
                }
            }

            // Physics: wall thickness
            if (IsWallLike(bb) && vol > 0)
            {
                double[] dims = { bb.Max.X - bb.Min.X, bb.Max.Y - bb.Min.Y, bb.Max.Z - bb.Min.Z };
                Array.Sort(dims);
                if (dims[0] <= tol)
                    return Block("wall_thickness",
                        "Wall-like brep thickness is at or below model tolerance.",
                        new[] { "Give the wall real thickness." }, objInfo);
            }

            // Physics: slab planar / horizontal
            if (!string.IsNullOrEmpty(name) &&
                (name.IndexOf("slab", StringComparison.OrdinalIgnoreCase) >= 0 ||
                 name.IndexOf("floor", StringComparison.OrdinalIgnoreCase) >= 0 ||
                 name.IndexOf("plate", StringComparison.OrdinalIgnoreCase) >= 0))
            {
                double dz = bb.Max.Z - bb.Min.Z;
                double dxy = Math.Max(bb.Max.X - bb.Min.X, bb.Max.Y - bb.Min.Y);
                if (dz > Math.Max(tol * 10, dxy * 0.05))
                    return Block("slab_planar",
                        "Slab-like object is not a thin horizontal plate.",
                        new[] { "Use a planar horizontal face." }, objInfo);
            }

            // Physics: stack_no_gap — if named as upper mass, gap to mass below must be small
            if (!intent.allow.floating && !string.IsNullOrEmpty(name) && bb.IsValid && doc != null)
            {
                double minZ = bb.Min.Z;
                if (Math.Abs(minZ) > Math.Max(tol * 10, 1.0))
                {
                    double lowerTop = double.MinValue;
                    foreach (var obj in doc.Objects)
                    {
                        try
                        {
                            var obb = obj.Geometry.GetBoundingBox(true);
                            if (!obb.IsValid) continue;
                            if (obb.Max.Z <= minZ + tol && obb.Max.Z > lowerTop && OverlapXY(obb, bb))
                                lowerTop = obb.Max.Z;
                        }
                        catch { }
                    }
                    if (lowerTop > -1e299)
                    {
                        double gap = minZ - lowerTop;
                        double lowerH = Math.Max(tol, lowerTop); // conservative
                        if (gap > Math.Max(tol * 20, 2.0))
                        {
                            return Block("stack_no_gap",
                                string.Format("Vertical gap {0:0.##} between '{1}' and the mass below.", gap, name),
                                new[] { "Close the gap or set intent.allow.floating=true." }, objInfo);
                        }
                    }
                }
            }

            // Style: named
            if (!intent.allow.unnamed && string.IsNullOrWhiteSpace(name))
                return Block("style_named", "Object name is empty.",
                    new[] { "Name it after intent vocabulary (tower/podium/core/…)." }, objInfo);

            // Style: layer not Default after layers exist
            if (!string.IsNullOrEmpty(layerPath) &&
                (layerPath == "Default" || layerPath.EndsWith("::Default")) &&
                doc != null && doc.Layers.Count > 1)
            {
                return Block("style_layer", "Object is on Default while other layers exist.",
                    new[] { "rhino_ensure_layer then assign a real layer." }, objInfo);
            }

            // Style: layer type match (soft mapping)
            var layerIssue = LayerMismatch(name, layerPath);
            if (layerIssue != null)
                return Block("style_layer_match", layerIssue,
                    new[] { "Use the matching AIA layer (A-GLAZ / A-WALL-* / A-FLOR-*)." }, objInfo);

            // Style: object count
            if (doc != null)
            {
                int count = doc.Objects.Count;
                if (count >= intent.limits.max_objects)
                    return Block("style_count",
                        string.Format("Object count {0} >= limit {1}.", count, intent.limits.max_objects),
                        new[] { "Delete junk or raise limits.max_objects in intent." }, objInfo);
            }

            // Style: subd / mesh gates
            if (kind == "subd" || geometry is SubD)
            {
                if (!intent.allow.subd)
                    return Block("style_subd", "SubD creation requires intent.allow.subd=true.",
                        new[] { "Prefer Brep massing (lessons.json subd-mesh-freeze).", "Set intent.allow.subd=true if needed." }, objInfo);
            }

            if (kind == "mesh" || geometry is Mesh)
            {
                if (!intent.allow.mesh)
                    return Block("style_mesh", "Mesh creation requires intent.allow.mesh=true.",
                        new[] { "Set intent.allow.mesh=true in intent." }, objInfo);
            }

            // Style: required_layers is audited in SceneAudit (not create-time —
            // EnsureLayer runs after this check and would race a hard block).

            // Intent: vocabulary + massing proportions
            if (intent.vocabulary != null && intent.vocabulary.Count > 0 && !string.IsNullOrEmpty(name)
                && kind == "mass")
            {
                bool hit = intent.vocabulary.Any(v =>
                    !string.IsNullOrEmpty(v) &&
                    name.IndexOf(v, StringComparison.OrdinalIgnoreCase) >= 0);
                bool massingHit = intent.massing != null && intent.massing.Any(r =>
                    r != null && !string.IsNullOrEmpty(r.name_contains) &&
                    name.IndexOf(r.name_contains, StringComparison.OrdinalIgnoreCase) >= 0);
                if (!hit && !massingHit)
                    return Block("intent_vocabulary",
                        string.Format("Name '{0}' does not use intent vocabulary [{1}].", name, string.Join(", ", intent.vocabulary)),
                        new[] { "Rename using a vocabulary token (e.g. tower/podium/core)." }, objInfo);
            }

            if (intent.massing != null && !string.IsNullOrEmpty(name))
            {
                foreach (var rule in intent.massing)
                {
                    if (rule == null || string.IsNullOrEmpty(rule.name_contains)) continue;
                    if (name.IndexOf(rule.name_contains, StringComparison.OrdinalIgnoreCase) < 0) continue;

                    double h = bb.Max.Z - bb.Min.Z;
                    double w = Math.Min(bb.Max.X - bb.Min.X, bb.Max.Y - bb.Min.Y);
                    double footprint = (bb.Max.X - bb.Min.X) * (bb.Max.Y - bb.Min.Y);

                    if (rule.min_height_mm.HasValue && h < rule.min_height_mm.Value)
                        return Block("intent_massing",
                            string.Format("'{0}' height {1:0.##} < min_height_mm {2:0.##}.", name, h, rule.min_height_mm.Value),
                            new[] { "Increase height or relax the massing rule." }, objInfo);
                    if (rule.max_height_mm.HasValue && h > rule.max_height_mm.Value)
                        return Block("intent_massing",
                            string.Format("'{0}' height {1:0.##} > max_height_mm {2:0.##}.", name, h, rule.max_height_mm.Value),
                            new[] { "Reduce height or relax the massing rule." }, objInfo);
                    if (rule.min_aspect_h_over_w.HasValue && w > 0 && h / w < rule.min_aspect_h_over_w.Value)
                        return Block("intent_massing",
                            string.Format("'{0}' aspect h/w={1:0.##} < {2:0.##}.", name, h / w, rule.min_aspect_h_over_w.Value),
                            new[] { "Make it taller / thinner, or relax min_aspect_h_over_w." }, objInfo);
                    if (rule.min_footprint_m2.HasValue && footprint / 1e6 < rule.min_footprint_m2.Value)
                        return Block("intent_massing",
                            string.Format("'{0}' footprint {1:0.##} m² < min_footprint_m2 {2:0.##}.", name, footprint / 1e6, rule.min_footprint_m2.Value),
                            new[] { "Widen the footprint or relax the rule." }, objInfo);
                }
            }

            return new PolicyPass();
        }

        public static PolicyBlock Block(string rule, string message, IEnumerable<string> fix, Dictionary<string, object> objInfo)
        {
            var b = new PolicyBlock
            {
                rule = rule,
                message = message,
                fix = fix != null ? fix.ToList() : new List<string>(),
                object_info = objInfo
            };
            IntentStore.RecordBlock(b);
            return b;
        }

        static bool SitsOnExisting(RhinoDoc doc, BoundingBox bb, double tol)
        {
            if (doc == null) return false;
            double minZ = bb.Min.Z;
            double slack = Math.Max(tol * 20, 2.0);
            foreach (var obj in doc.Objects)
            {
                try
                {
                    var obb = obj.Geometry.GetBoundingBox(true);
                    if (!obb.IsValid) continue;
                    // top of existing near our minZ, and horizontal overlap
                    if (Math.Abs(obb.Max.Z - minZ) <= slack && OverlapXY(obb, bb))
                        return true;
                }
                catch { }
            }
            return false;
        }

        static bool OverlapXY(BoundingBox a, BoundingBox b)
        {
            return a.Min.X <= b.Max.X && a.Max.X >= b.Min.X &&
                   a.Min.Y <= b.Max.Y && a.Max.Y >= b.Min.Y;
        }

        static bool IsWallLike(BoundingBox bb)
        {
            double dx = bb.Max.X - bb.Min.X;
            double dy = bb.Max.Y - bb.Min.Y;
            double dz = bb.Max.Z - bb.Min.Z;
            double[] dims = { dx, dy, dz };
            Array.Sort(dims);
            // tall and long but thin
            return dims[2] >= 4 * dims[0] && dims[1] >= 2 * dims[0];
        }

        static string LayerMismatch(string name, string layerPath)
        {
            if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(layerPath)) return null;
            var n = name.ToLowerInvariant();
            var l = layerPath.ToLowerInvariant();
            if ((n.Contains("glaz") || n.Contains("glass") || n.Contains("window")) && !l.Contains("glaz"))
                return "Glazing-like name should live on A-GLAZ (or A-GLAZ-*).";
            if ((n.Contains("wall")) && !l.Contains("wall"))
                return "Wall-like name should live on A-WALL-*.";
            if ((n.Contains("slab") || n.Contains("floor")) && !l.Contains("flor") && !l.Contains("slab") && !l.Contains("floor"))
                return "Slab/floor name should live on A-FLOR-*.";
            return null;
        }
    }
}
