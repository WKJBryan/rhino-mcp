using System;
using System.Collections.Generic;
using System.Text.Json;
using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace IntentHarness
{
    /// <summary>Op dispatch on the Rhino UI thread (file-queue / TCP shared).</summary>
    public static class Rpc
    {
        static readonly JsonSerializerOptions Opts = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        };

        public static object Execute(string json)
        {
            using (var doc = JsonDocument.Parse(json))
            {
                var root = doc.RootElement;
                string op = root.TryGetProperty("op", out var opEl) ? opEl.GetString() : null;
                string reqId = root.TryGetProperty("id", out var idEl) ? idEl.GetString() : null;

                switch (op)
                {
                    case "ping":
                        return Ok(reqId, new
                        {
                            pong = true,
                            transport = "tcp",
                            port = TcpHost.Port,
                            rhino_version = RhinoApp.Version.ToString(),
                            intent_loaded = System.IO.File.Exists(IntentStore.IntentPath),
                            objects = RhinoDoc.ActiveDoc != null ? RhinoDoc.ActiveDoc.Objects.Count : 0
                        });
                    case "set_intent":
                        string intentJson = root.TryGetProperty("intent", out var iEl) ? iEl.GetRawText() : root.TryGetProperty("json", out var jEl) ? jEl.GetString() : "{}";
                        IntentStore.MergeJson(intentJson);
                        return Ok(reqId, new { saved = true, path = IntentStore.IntentPath, intent = IntentStore.Current });
                    case "get_policy":
                        return Ok(reqId, IntentStore.PolicySnapshot());
                    case "check_scene":
                        return Ok(reqId, SceneAudit.Run());
                    case "create_mass":
                        {
                            var mass = GatedOps.CreateMass(root);
                            return mass is PolicyBlock pb1 ? (object)pb1 : Ok(reqId, mass);
                        }
                    case "add_subd":
                        {
                            var subd = GatedOps.AddSubD(root);
                            return subd is PolicyBlock pb2 ? (object)pb2 : Ok(reqId, subd);
                        }
                    case "add_mesh":
                        {
                            var mesh = GatedOps.AddMesh(root);
                            return mesh is PolicyBlock pb3 ? (object)pb3 : Ok(reqId, mesh);
                        }
                    case "exec":
                        // Escape hatch: still available; audit after the fact via check_scene.
                        return Ok(reqId, new { note = "raw exec is not gated in-plugin; use gated creates for policy", escape_hatch = true });
                    default:
                        return new { id = reqId, ok = false, error = "Unknown op: " + op };
                }
            }
        }

        static object Ok(string id, object result) => new { id, ok = true, result };
    }

    public static class GatedOps
    {
        public static object CreateMass(JsonElement root)
        {
            var doc = RhinoDoc.ActiveDoc;
            if (doc == null) return new { ok = false, error = "No document" };

            string name = root.TryGetProperty("name", out var n) ? n.GetString() : "Mass";
            string layer = root.TryGetProperty("layer", out var l) ? l.GetString() : null;
            string kind = root.TryGetProperty("kind", out var k) ? k.GetString() : "mass";
            double x = root.TryGetProperty("x", out var xE) ? xE.GetDouble() : 0;
            double y = root.TryGetProperty("y", out var yE) ? yE.GetDouble() : 0;
            double z = root.TryGetProperty("z", out var zE) ? zE.GetDouble() : 0;
            double dx = root.TryGetProperty("dx", out var dxE) ? dxE.GetDouble() : 1000;
            double dy = root.TryGetProperty("dy", out var dyE) ? dyE.GetDouble() : 1000;
            double dz = root.TryGetProperty("dz", out var dzE) ? dzE.GetDouble() : 1000;

            var plane = new Plane(new Point3d(x, y, z), Vector3d.ZAxis);
            var box = new Box(plane, new Interval(0, dx), new Interval(0, dy), new Interval(0, dz));
            Brep brep = box.ToBrep();

            var check = PolicyEngine.CheckCreate(doc, brep, name, layer ?? "Default", kind);
            if (check is PolicyBlock b) return b;

            int li = EnsureLayer(doc, layer ?? DefaultLayer(doc, name));
            var attrs = new ObjectAttributes { Name = name ?? "", LayerIndex = li };
            Guid id = doc.Objects.AddBrep(brep, attrs);
            doc.Views.Redraw();
            return new { ok = true, id = id.ToString(), name, layer = doc.Layers[li].FullPath, created = "brep_box" };
        }

        public static object AddSubD(JsonElement root)
        {
            var doc = RhinoDoc.ActiveDoc;
            if (doc == null) return new { ok = false, error = "No document" };
            string name = root.TryGetProperty("name", out var n) ? n.GetString() : "SubD";
            string layer = root.TryGetProperty("layer", out var l) ? l.GetString() : null;
            double x = root.TryGetProperty("x", out var xE) ? xE.GetDouble() : 0;
            double y = root.TryGetProperty("y", out var yE) ? yE.GetDouble() : 0;
            double z = root.TryGetProperty("z", out var zE) ? zE.GetDouble() : 0;
            double dx = root.TryGetProperty("dx", out var dxE) ? dxE.GetDouble() : 1000;
            double dy = root.TryGetProperty("dy", out var dyE) ? dyE.GetDouble() : 1000;
            double dz = root.TryGetProperty("dz", out var dzE) ? dzE.GetDouble() : 1000;

            // RhinoCommon has no SubD.CreateFromBox — mesh box then SubD.CreateFromMesh.
            // ConvexCornersAndInteriorCreases ≈ "sharpness>=3" architectural SubD (lessons.json).
            var box = new Box(new Plane(new Point3d(x, y, z), Vector3d.ZAxis),
                new Interval(0, dx), new Interval(0, dy), new Interval(0, dz));
            Mesh mesh = Mesh.CreateFromBox(box, 1, 1, 1);
            if (mesh == null) return new { ok = false, error = "Mesh.CreateFromBox returned null" };

            SubDCreationOptions opts = SubDCreationOptions.ConvexCornersAndInteriorCreases;
            SubD subd = SubD.CreateFromMesh(mesh, opts);
            if (subd == null) return new { ok = false, error = "SubD.CreateFromMesh returned null" };

            var check = PolicyEngine.CheckCreate(doc, subd, name, layer ?? "Default", "subd");
            if (check is PolicyBlock b) return b;

            int li = EnsureLayer(doc, layer ?? DefaultLayer(doc, name));
            var attrs = new ObjectAttributes { Name = name ?? "", LayerIndex = li };
            Guid id = doc.Objects.AddSubD(subd, attrs);
            doc.Views.Redraw();
            return new { ok = true, id = id.ToString(), name, created = "subd", sharp = "convex_corners_and_creases" };
        }

        public static object AddMesh(JsonElement root)
        {
            var doc = RhinoDoc.ActiveDoc;
            if (doc == null) return new { ok = false, error = "No document" };
            string name = root.TryGetProperty("name", out var n) ? n.GetString() : "Mesh";
            string layer = root.TryGetProperty("layer", out var l) ? l.GetString() : null;
            double x = root.TryGetProperty("x", out var xE) ? xE.GetDouble() : 0;
            double y = root.TryGetProperty("y", out var yE) ? yE.GetDouble() : 0;
            double z = root.TryGetProperty("z", out var zE) ? zE.GetDouble() : 0;
            double dx = root.TryGetProperty("dx", out var dxE) ? dxE.GetDouble() : 1000;
            double dy = root.TryGetProperty("dy", out var dyE) ? dyE.GetDouble() : 1000;
            double dz = root.TryGetProperty("dz", out var dzE) ? dzE.GetDouble() : 1000;

            var box = new Box(new Plane(new Point3d(x, y, z), Vector3d.ZAxis),
                new Interval(0, dx), new Interval(0, dy), new Interval(0, dz));
            Mesh mesh = Mesh.CreateFromBox(box, 1, 1, 1);
            if (mesh == null) return new { ok = false, error = "Mesh.CreateFromBox returned null" };

            var check = PolicyEngine.CheckCreate(doc, mesh, name, layer ?? "Default", "mesh");
            if (check is PolicyBlock b) return b;

            int li = EnsureLayer(doc, layer ?? DefaultLayer(doc, name));
            var attrs = new ObjectAttributes { Name = name ?? "", LayerIndex = li };
            Guid id = doc.Objects.AddMesh(mesh, attrs);
            doc.Views.Redraw();
            return new { ok = true, id = id.ToString(), name, created = "mesh" };
        }

        static string DefaultLayer(RhinoDoc doc, string name)
        {
            var n = (name ?? "").ToLowerInvariant();
            if (n.Contains("glaz") || n.Contains("glass")) return "A-ARCH::A-GLAZ";
            if (n.Contains("wall")) return "A-ARCH::A-WALL-EXTR";
            if (n.Contains("slab") || n.Contains("floor")) return "A-ARCH::A-FLOR-SLAB";
            if (n.Contains("core")) return "S-STRC::S-COLS";
            return "A-ARCH";
        }

        static int EnsureLayer(RhinoDoc doc, string path)
        {
            var parts = path.Replace("::", "/").Replace("\\", "/").Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
            int parent = -1;
            int found = -1;
            foreach (var p in parts)
            {
                found = -1;
                for (int i = 0; i < doc.Layers.Count; i++)
                {
                    var L = doc.Layers[i];
                    if (L.Name != p) continue;
                    if (parent < 0)
                    {
                        if (L.ParentLayerId == Guid.Empty) { found = i; break; }
                    }
                    else if (L.ParentLayerId == doc.Layers[parent].Id) { found = i; break; }
                }
                if (found < 0)
                {
                    var li = new Layer { Name = p };
                    if (parent >= 0) li.ParentLayerId = doc.Layers[parent].Id;
                    found = doc.Layers.Add(li);
                }
                parent = found;
            }
            return parent >= 0 ? parent : 0;
        }
    }

    public static class SceneAudit
    {
        public static object Run()
        {
            var doc = RhinoDoc.ActiveDoc;
            if (doc == null) return new { ok = false, error = "No document" };
            var issues = new List<object>();
            int unnamed = 0;
            foreach (var obj in doc.Objects)
            {
                var name = obj.Attributes != null ? obj.Attributes.Name : null;
                if (string.IsNullOrWhiteSpace(name)) unnamed++;
                try
                {
                    if (!obj.Geometry.IsValid)
                        issues.Add(new { rule = "valid_geometry", id = obj.Id.ToString(), message = "Invalid geometry" });
                }
                catch { }
            }
            var intent = IntentStore.Current;
            if (unnamed > intent.limits.max_unnamed && !intent.allow.unnamed)
                issues.Add(new { rule = "style_named", message = unnamed + " unnamed objects", fix = "Name objects or allow.unnamed=true" });
            if (doc.Objects.Count > intent.limits.max_objects)
                issues.Add(new { rule = "style_count", message = "count=" + doc.Objects.Count + " > max_objects=" + intent.limits.max_objects });

            return new
            {
                ok = issues.Count == 0,
                objects = doc.Objects.Count,
                unnamed,
                issues,
                recent_blocks = IntentStore.RecentBlocks()
            };
        }
    }
}
