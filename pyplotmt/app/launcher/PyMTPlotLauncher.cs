using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace PyPlotMTLauncher
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            string cfgPath = Path.Combine(exeDir, "pymtplot_python_path.txt");
            string defaultPy = @"C:\mql\Python3.12\venv\Scripts\python.exe";

            string pyExe = defaultPy;
            if (File.Exists(cfgPath))
            {
                try
                {
                    string line = File.ReadAllText(cfgPath).Trim();
                    if (!string.IsNullOrEmpty(line))
                        pyExe = line;
                }
                catch { }
            }

            string pyDir = Path.GetDirectoryName(pyExe) ?? string.Empty;
            string pyw = Path.Combine(pyDir, "pythonw.exe");
            string pye = Path.Combine(pyDir, "python.exe");

            if (!File.Exists(pyExe) && File.Exists(pye))
                pyExe = pye;

            if (!File.Exists(pyExe))
            {
                MessageBox.Show(
                    "Python not found:\n" + pyExe + "\n\n" +
                    "Edit pymtplot_python_path.txt and set the full path to python.exe.",
                    "PyPlot-MT",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return 1;
            }

            // Check PySide6 availability using python.exe (console) for proper exit code.
            string checkExe = File.Exists(pye) ? pye : pyExe;
            try
            {
                var check = new ProcessStartInfo
                {
                    FileName = checkExe,
                    Arguments = "-c \"import PySide6\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardError = true,
                    RedirectStandardOutput = true
                };
                using (var p = Process.Start(check))
                {
                    p.WaitForExit();
                    if (p.ExitCode != 0)
                    {
                        string err = (p.StandardError.ReadToEnd() + p.StandardOutput.ReadToEnd()).Trim();
                        MessageBox.Show(
                            "PySide6 not found in this Python.\n\n" +
                            "Run:\n" + checkExe + " -m pip install PySide6\n\n" +
                            (err.Length > 0 ? ("Error:\n" + err) : ""),
                            "PyPlot-MT",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Error
                        );
                        return 1;
                    }
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Failed to verify PySide6:\n" + ex.Message,
                    "PyPlot-MT",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return 1;
            }

            // Prefer pythonw.exe to avoid console window.
            if (File.Exists(pyw))
                pyExe = pyw;

            string pyz = Path.Combine(exeDir, "PyPlot-MT.pyz");
            if (!File.Exists(pyz))
            {
                MessageBox.Show(
                    "PyPlot-MT.pyz not found in:\n" + pyz,
                    "PyPlot-MT",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return 1;
            }

            var psi = new ProcessStartInfo
            {
                FileName = pyExe,
                Arguments = "\"" + pyz + "\"",
                WorkingDirectory = exeDir,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            try
            {
                Process.Start(psi);
                return 0;
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Failed to start PyPlot-MT:\n" + ex.Message,
                    "PyPlot-MT",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return 1;
            }
        }
    }
}
