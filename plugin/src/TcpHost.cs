using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Rhino;

namespace IntentHarness
{
    /// <summary>
    /// NDJSON TCP host on 127.0.0.1. Worker thread accepts one client; every
    /// request is dispatched on the Rhino UI thread via InvokeOnUiThread (safe
    /// from compiled C#; banned from IronPython).
    /// </summary>
    public static class TcpHost
    {
        public static int Port =
            int.Parse(Environment.GetEnvironmentVariable("RHINO_MCP_TCP_PORT") ?? "9545");

        static TcpListener _listener;
        static Thread _thread;
        static volatile bool _running;
        public static bool IsRunning => _running;

        public static void Start()
        {
            if (_running) return;
            _running = true;
            _thread = new Thread(Loop) { IsBackground = true, Name = "IntentHarness.TcpHost" };
            _thread.Start();
        }

        public static void Stop()
        {
            _running = false;
            try { _listener?.Stop(); } catch { }
            _listener = null;
        }

        static void Loop()
        {
            try
            {
                _listener = new TcpListener(IPAddress.Loopback, Port);
                _listener.Start();
                RhinoApp.WriteLine("[IntentHarness] TCP listening 127.0.0.1:" + Port);
                while (_running)
                {
                    TcpClient client;
                    try { client = _listener.AcceptTcpClient(); }
                    catch { break; }
                    using (client)
                    using (var stream = client.GetStream())
                    using (var reader = new StreamReader(stream, Encoding.UTF8))
                    using (var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true })
                    {
                        string line;
                        while (_running && (line = reader.ReadLine()) != null)
                        {
                            if (string.IsNullOrWhiteSpace(line)) continue;
                            string response = HandleLine(line);
                            writer.WriteLine(response);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                RhinoApp.WriteLine("[IntentHarness] TCP error: " + ex.Message);
            }
            finally
            {
                _running = false;
            }
        }

        static string HandleLine(string line)
        {
            string id = null;
            try
            {
                using (var doc = JsonDocument.Parse(line))
                {
                    if (doc.RootElement.TryGetProperty("id", out var idEl))
                        id = idEl.ToString();
                }
            }
            catch { }

            try
            {
                var result = new TaskCompletionSource<object>();
                RhinoApp.InvokeOnUiThread(new Action(() =>
                {
                    try { result.SetResult(Rpc.Execute(line)); }
                    catch (Exception ex) { result.SetResult(new { ok = false, error = ex.ToString() }); }
                }), null);
                if (!result.Task.Wait(TimeSpan.FromSeconds(70)))
                    return JsonSerializer.Serialize(new { id, ok = false, error = "UI dispatch timeout" });
                return JsonSerializer.Serialize(new { id, result = result.Task.Result, ok = true });
            }
            catch (Exception ex)
            {
                return JsonSerializer.Serialize(new { id, ok = false, error = ex.Message });
            }
        }
    }
}
