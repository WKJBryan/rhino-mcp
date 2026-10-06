using System;
using Rhino;

namespace IntentHarness
{
    public class IntentHarnessPlugin : Rhino.PlugIns.PlugIn
    {
        public override Rhino.PlugIns.PlugInLoadTime LoadTime => Rhino.PlugIns.PlugInLoadTime.AtStartup;

        public IntentHarnessPlugin()
        {
        }

        protected override Rhino.PlugIns.LoadReturnCode OnLoad(ref string errorMessage)
        {
            try
            {
                IntentStore.Load();
                TcpHost.Start();
                RhinoApp.WriteLine("[IntentHarness] loaded — policy gate + TCP");
                return Rhino.PlugIns.LoadReturnCode.Success;
            }
            catch (Exception ex)
            {
                errorMessage = ex.ToString();
                return Rhino.PlugIns.LoadReturnCode.ErrorShowDialog;
            }
        }

        protected override void OnShutdown()
        {
            try { TcpHost.Stop(); } catch { }
            base.OnShutdown();
        }
    }

    public class McpStartCommand : Rhino.Commands.Command
    {
        public override string EnglishName => "McpStart";
        protected override Rhino.Commands.Result RunCommand(RhinoDoc doc, Rhino.Commands.RunMode mode)
        {
            IntentStore.Load();
            TcpHost.Start();
            RhinoApp.WriteLine($"[IntentHarness] TCP {TcpHost.Port} running={TcpHost.IsRunning}");
            return Rhino.Commands.Result.Success;
        }
    }

    public class McpStopCommand : Rhino.Commands.Command
    {
        public override string EnglishName => "McpStop";
        protected override Rhino.Commands.Result RunCommand(RhinoDoc doc, Rhino.Commands.RunMode mode)
        {
            TcpHost.Stop();
            RhinoApp.WriteLine("[IntentHarness] TCP stopped");
            return Rhino.Commands.Result.Success;
        }
    }

    public class McpPolicyCommand : Rhino.Commands.Command
    {
        public override string EnglishName => "McpPolicy";
        protected override Rhino.Commands.Result RunCommand(RhinoDoc doc, Rhino.Commands.RunMode mode)
        {
            var snap = IntentStore.PolicySnapshot();
            RhinoApp.WriteLine("[IntentHarness] policy: " + System.Text.Json.JsonSerializer.Serialize(snap));
            return Rhino.Commands.Result.Success;
        }
    }
}
