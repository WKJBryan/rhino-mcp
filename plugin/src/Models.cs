using System.Collections.Generic;

namespace IntentHarness
{
    /// <summary>Structured intent written by the agent from session language.</summary>
    public class IntentDoc
    {
        public string project { get; set; } = "";
        public string units { get; set; } = "mm";
        public List<string> vocabulary { get; set; } = new List<string>();
        public List<string> required_layers { get; set; } = new List<string>();
        public List<MassingRule> massing { get; set; } = new List<MassingRule>();
        public Limits limits { get; set; } = new Limits();
        public Allow allow { get; set; } = new Allow();
    }

    public class MassingRule
    {
        public string name_contains { get; set; } = "";
        public double? min_height_mm { get; set; }
        public double? max_height_mm { get; set; }
        public double? min_aspect_h_over_w { get; set; }
        public double? min_footprint_m2 { get; set; }
    }

    public class Limits
    {
        public int max_objects { get; set; } = 2000;
        public int max_unnamed { get; set; } = 0;
    }

    public class Allow
    {
        public bool subd { get; set; } = false;
        public bool mesh { get; set; } = true;
        public bool points { get; set; } = true;
        public bool floating { get; set; } = false;
        public bool unnamed { get; set; } = false;
    }

    public class PolicyBlock
    {
        public bool ok { get; set; } = false;
        public string code { get; set; } = "POLICY_BLOCKED";
        public string rule { get; set; }
        public string message { get; set; }
        public List<string> fix { get; set; } = new List<string>();
        public Dictionary<string, object> object_info { get; set; }
    }

    public class PolicyPass
    {
        public bool ok { get; set; } = true;
        public string rule { get; set; } = "ok";
    }
}
