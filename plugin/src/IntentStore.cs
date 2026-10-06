using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace IntentHarness
{
    /// <summary>
    /// Session language is interpreted by the agent into intent.json.
    /// This store loads/merges/saves that structured intent for the policy gate.
    /// </summary>
    public static class IntentStore
    {
        public static string Home =
            Environment.GetEnvironmentVariable("RHINO_MCP_HOME")
            ?? Path.Combine(Path.GetTempPath(), "rhino-mcp");

        public static string IntentPath => Path.Combine(Home, "intent.json");

        static readonly JsonSerializerOptions JsonOpts = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };

        static IntentDoc _intent = new IntentDoc();
        static readonly object _lock = new object();
        static readonly List<object> _blocks = new List<object>();

        public static IntentDoc Current
        {
            get { lock (_lock) { return _intent; } }
        }

        public static void Load()
        {
            lock (_lock)
            {
                try
                {
                    if (File.Exists(IntentPath))
                    {
                        _intent = Parse(File.ReadAllText(IntentPath)) ?? new IntentDoc();
                    }
                    else
                    {
                        _intent = new IntentDoc();
                    }
                }
                catch
                {
                    _intent = new IntentDoc();
                }
            }
        }

        public static IntentDoc Parse(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return new IntentDoc();
            try
            {
                return JsonSerializer.Deserialize<IntentDoc>(json, JsonOpts) ?? new IntentDoc();
            }
            catch
            {
                return new IntentDoc();
            }
        }

        public static string ToJson(IntentDoc doc)
        {
            return JsonSerializer.Serialize(doc, JsonOpts);
        }

        public static void Save(IntentDoc doc)
        {
            lock (_lock)
            {
                _intent = doc ?? new IntentDoc();
                Directory.CreateDirectory(Home);
                File.WriteAllText(IntentPath, ToJson(_intent));
            }
        }

        public static void MergeJson(string json)
        {
            lock (_lock)
            {
                var incoming = Parse(json);
                var cur = _intent ?? new IntentDoc();
                if (!string.IsNullOrEmpty(incoming.project)) cur.project = incoming.project;
                if (!string.IsNullOrEmpty(incoming.units)) cur.units = incoming.units;
                if (incoming.vocabulary != null && incoming.vocabulary.Count > 0)
                    cur.vocabulary = incoming.vocabulary;
                if (incoming.required_layers != null && incoming.required_layers.Count > 0)
                    cur.required_layers = incoming.required_layers;
                if (incoming.massing != null && incoming.massing.Count > 0)
                    cur.massing = incoming.massing;
                if (incoming.limits != null)
                {
                    if (incoming.limits.max_objects > 0) cur.limits.max_objects = incoming.limits.max_objects;
                    cur.limits.max_unnamed = incoming.limits.max_unnamed;
                }
                if (incoming.allow != null) cur.allow = incoming.allow;
                _intent = cur;
                Directory.CreateDirectory(Home);
                File.WriteAllText(IntentPath, ToJson(cur));
            }
        }

        public static void RecordBlock(object block)
        {
            lock (_lock)
            {
                _blocks.Add(block);
                if (_blocks.Count > 50) _blocks.RemoveAt(0);
            }
        }

        public static List<object> RecentBlocks()
        {
            lock (_lock) { return new List<object>(_blocks); }
        }

        public static object PolicySnapshot()
        {
            lock (_lock)
            {
                return new
                {
                    intent = _intent,
                    recent_blocks = _blocks,
                    intent_path = IntentPath,
                    rules = RulesIndex.Describe()
                };
            }
        }
    }

    /// <summary>Human-readable rule ids mirrored from rules/*.md.</summary>
    public static class RulesIndex
    {
        public static readonly string[] Physics =
        {
            "valid_geometry", "nonzero_size", "not_duplicate", "no_floating",
            "wall_thickness", "slab_planar", "stack_no_gap"
        };

        public static readonly string[] Style =
        {
            "style_named", "style_layer", "style_layer_match", "style_count",
            "style_subd", "style_mesh"
        };

        public static object Describe()
        {
            return new { physics = Physics, style = Style };
        }
    }
}
