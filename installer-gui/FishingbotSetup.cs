// Fishingbot setup: GUI installer and uninstaller (WinForms, .NET Framework 4).
// Built with installer-gui\build-setup.bat using csc.exe from Windows' own .NET Framework,
// so no extra tools are needed. The program files are embedded as a resource.
//
// Install:   runs the wizard (no admin rights needed).
// Uninstall: "Uninstall Fishingbot" in Windows Settings, the Start Menu entry, or
//            Uninstall Fishingbot.exe /uninstall. The uninstaller copies itself to TEMP
//            first, so it can delete its own folder.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using System.Globalization;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using Loc = FishingbotDesktopV2.Loc;

namespace FishingbotSetup
{
    internal static class Product
    {
        public const string Name = "Fishingbot";
        // From the VERSION file (see ReleaseInfo.g.cs). Version stays numeric so System.Version can compare it.
        public const string Version = ReleaseInfo.Number;
        // Shown in Windows Apps & features.
        public const string DisplayVersion = ReleaseInfo.Label;
        public const string ExeName = "Fishingbot.exe";
        public const string UninstallExeName = "Uninstall Fishingbot.exe";
        public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Fishingbot";
        public const string UninstallKey32 = @"Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Fishingbot";
        public const string PayloadResource = "Payload.zip";
        public const string InstallManifestFile = ".fishingbot-install-manifest";
        public const string LegacyInnoUninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\{B7E4C1A2-3D5F-4E8B-9C1A-6F2D8E3B4A51}_is1";
        public const string LegacyInnoUninstallKey32 = @"Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{B7E4C1A2-3D5F-4E8B-9C1A-6F2D8E3B4A51}_is1";
        // Legacy website OAuth Client ID only; the Device Code public Client ID is injected into the server build.
        public const string TwitchClientId = "e4or7x7vn8ry639wuyjmi256bhfoot";

        public static string DefaultInstallDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", Name); }
        }

        public static string LogPath
        {
            get { return Path.Combine(Path.GetTempPath(), "fishingbot-setup.log"); }
        }

        public static void Log(string line)
        {
            try { File.AppendAllText(LogPath, DateTime.Now.ToString("s") + "  " + line + Environment.NewLine); }
            catch (Exception) { /* logging must never break setup */ }
        }
    }

    internal sealed class InstallOptions
    {
        public string InstallDir;
        public string ClientId = Product.TwitchClientId;
        public string ClientSecret = "";
        public int Port = 3000;
        public bool DesktopShortcut = true;
        public bool StartMenu = true;
        public bool LaunchAfter = true;
        public string BackupPath = "";
        public string Language = "en";

        public InstallOptions()
        {
            // Prefer the exact folder registered by the previous installation.
            // This avoids accidentally creating a second, empty installation.
            InstallDir = Engine.FindExistingInstallDir() ?? Product.DefaultInstallDir;
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                bool asUninstaller = args.Any(a => a.Equals("/uninstall", StringComparison.OrdinalIgnoreCase))
                    || Path.GetFileName(Application.ExecutablePath).StartsWith("Uninstall ", StringComparison.OrdinalIgnoreCase);
                if (asUninstaller) RunUninstall(args);
                else if (ChooseLanguage(Engine.InitialLanguage(Engine.FindExistingInstallDir())))
                {
                    var wizard = new InstallWizard();
                    Application.Run(wizard);
                    // Start the app only after setup has closed, so its window is not hidden behind setup.
                    wizard.StartIfRequested();
                }
            }
            catch (Exception ex)
            {
                Product.Log("Fatal: " + ex);
                MessageBox.Show("Setup could not start: " + ex.Message + Environment.NewLine + Environment.NewLine +
                                "Details were written to " + Product.LogPath, Product.Name + " Setup",
                                MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        // The language step comes first. Returns false when the user closes it instead of continuing.
        private static bool ChooseLanguage(string initial)
        {
            using (var gate = new LanguageGate(initial))
            {
                return gate.ShowDialog() == DialogResult.OK;
            }
        }

        private static void RunUninstall(string[] args)
        {
            // A process whose working directory is inside the install folder keeps that folder
            // locked, so Windows cannot delete it. Always work from TEMP.
            Environment.CurrentDirectory = Path.GetTempPath();
            string self = Path.GetFullPath(Application.ExecutablePath);
            bool copied = args.Any(a => a.Equals("/copied", StringComparison.OrdinalIgnoreCase));
            if (!copied)
            {
                // Do not accept a caller-supplied /dir on the installed executable: it may
                // only uninstall the directory that physically contains this verified app.
                string installDir = Path.GetDirectoryName(self);
                Engine.ValidateUninstallTarget(installDir, self, false);
                string temp = Path.Combine(Path.GetTempPath(),
                    "Fishingbot-Uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
                File.Copy(self, temp, true);
                // Keep a retry-capable executable outside the folder being removed.
                // Windows Apps & Features continues to point here if locked files make
                // the first uninstall incomplete.
                Engine.SetUninstallRetryPath(temp, installDir);
                Process.Start(new ProcessStartInfo(temp, "/uninstall /copied /dir:\"" + installDir + "\"")
                {
                    UseShellExecute = true,
                    WorkingDirectory = Path.GetTempPath()
                });
                return;
            }

            string dirArg = args.FirstOrDefault(a => a.StartsWith("/dir:", StringComparison.OrdinalIgnoreCase));
            if (dirArg == null) throw new InvalidOperationException("The uninstaller could not identify the installed Fishingbot folder.");
            string dir = Path.GetFullPath(dirArg.Substring(5).Trim('"'));
            Engine.ValidateUninstallTarget(dir, self, true);
            if (!ChooseLanguage(Engine.InitialLanguage(dir))) return;
            Application.Run(new UninstallForm(dir, self));
        }
    }

    internal static class Shortcut
    {
        // Creates a .lnk file through the Windows Script Host shell object (no extra references).
        public static void Create(string path, string target, string arguments, string workDir, string description, string iconLocation)
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            try
            {
                object link = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
                try
                {
                    Type linkType = link.GetType();
                    linkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { target });
                    linkType.InvokeMember("Arguments", BindingFlags.SetProperty, null, link, new object[] { arguments ?? "" });
                    linkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { workDir });
                    linkType.InvokeMember("Description", BindingFlags.SetProperty, null, link, new object[] { description });
                    linkType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, link, new object[] { iconLocation ?? (target + ",0") });
                    linkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
                }
                finally
                {
                    Marshal.ReleaseComObject(link);
                }
            }
            finally
            {
                Marshal.ReleaseComObject(shell);
            }
        }
    }

    internal static class Engine
    {
        private static long _payloadBytes = -1;

        private static ZipArchive OpenPayload()
        {
            Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(Product.PayloadResource);
            if (s == null) throw new InvalidOperationException("The setup payload is missing. Rebuild the setup program.");
            return new ZipArchive(s, ZipArchiveMode.Read);
        }

        // Uncompressed size of the program files.
        public static long PayloadBytes
        {
            get
            {
                if (_payloadBytes < 0)
                {
                    using (ZipArchive zip = OpenPayload()) _payloadBytes = zip.Entries.Sum(e => e.Length);
                }
                return _payloadBytes;
            }
        }

        // Program files plus a safety margin for the database and logs.
        public static long RequiredBytes { get { return PayloadBytes + 60L * 1024 * 1024; } }

        public static bool IsExistingInstall(string dir)
        {
            if (String.IsNullOrWhiteSpace(dir)) return false;
            string data = Path.Combine(dir, "data");
            return File.Exists(Path.Combine(dir, Product.ExeName))
                || File.Exists(Path.Combine(dir, "FishingbotServer.exe"))
                || File.Exists(Path.Combine(dir, ".env"))
                || File.Exists(Path.Combine(dir, Product.InstallManifestFile))
                || File.Exists(Path.Combine(data, "fishing.sqlite"))
                || File.Exists(Path.Combine(data, "loot-table.json"))
                || File.Exists(Path.Combine(data, "local-admin.json"))
                || File.Exists(Path.Combine(data, "extension-master-admin.json"));
        }

        public static void ValidateUninstallTarget(string dir, string executablePath, bool copied)
        {
            if (String.IsNullOrWhiteSpace(dir)) throw new InvalidOperationException("The installation folder is missing.");
            string full = Path.GetFullPath(dir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string root = Path.GetPathRoot(full);
            if (String.IsNullOrWhiteSpace(full) || String.Equals(full, root, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("For safety, the uninstaller cannot remove a drive or filesystem root.");
            if (!Directory.Exists(full) || !IsExistingInstall(full))
                throw new InvalidOperationException("This folder is not a recognized Fishingbot installation. No files were removed.");

            string manifest = Path.Combine(full, Product.InstallManifestFile);
            string installedExe = Path.Combine(full, Product.ExeName);
            bool manifestInstall = File.Exists(manifest) && File.Exists(installedExe);
            string registered = FindExistingInstallDir();
            bool registryInstall = !String.IsNullOrWhiteSpace(registered)
                && String.Equals(Path.GetFullPath(registered).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), full, StringComparison.OrdinalIgnoreCase);
            bool executableInside = !String.IsNullOrWhiteSpace(executablePath)
                && String.Equals(Path.GetDirectoryName(Path.GetFullPath(executablePath)).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), full, StringComparison.OrdinalIgnoreCase);

            if (copied)
            {
                string tempRoot = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
                string selfFull = Path.GetFullPath(executablePath);
                if (!selfFull.StartsWith(tempRoot, StringComparison.OrdinalIgnoreCase)
                    || !Path.GetFileName(selfFull).StartsWith("Fishingbot-Uninstall-", StringComparison.OrdinalIgnoreCase)
                    || (!manifestInstall && !registryInstall))
                    throw new InvalidOperationException("The temporary uninstaller could not verify this installation. No files were removed.");
            }
            else if (!executableInside || (!manifestInstall && !registryInstall))
            {
                throw new InvalidOperationException("Run the uninstaller from the registered Fishingbot installation. No files were removed.");
            }
        }

        private static string ReadInstallLocation(RegistryKey hive, string subKey)
        {
            try
            {
                using (RegistryKey key = hive.OpenSubKey(subKey))
                {
                    if (key == null) return null;
                    string[] names = { "InstallLocation", "Inno Setup: App Path" };
                    foreach (string name in names)
                    {
                        object value = key.GetValue(name);
                        string path = value == null ? "" : Convert.ToString(value).Trim();
                        if (!String.IsNullOrWhiteSpace(path) && IsExistingInstall(path)) return Path.GetFullPath(path);
                    }
                }
            }
            catch (Exception ex) { Product.Log("Could not read install location from " + subKey + ": " + ex.Message); }
            return null;
        }

        public static string FindExistingInstallDir()
        {
            string path = ReadInstallLocation(Registry.CurrentUser, Product.UninstallKey);
            if (!String.IsNullOrWhiteSpace(path)) return path;
            path = ReadInstallLocation(Registry.CurrentUser, Product.UninstallKey32);
            if (!String.IsNullOrWhiteSpace(path)) return path;
            path = ReadInstallLocation(Registry.CurrentUser, Product.LegacyInnoUninstallKey);
            if (!String.IsNullOrWhiteSpace(path)) return path;
            path = ReadInstallLocation(Registry.CurrentUser, Product.LegacyInnoUninstallKey32);
            if (!String.IsNullOrWhiteSpace(path)) return path;
            path = ReadInstallLocation(Registry.LocalMachine, Product.UninstallKey);
            if (!String.IsNullOrWhiteSpace(path)) return path;
            path = ReadInstallLocation(Registry.LocalMachine, Product.UninstallKey32);
            if (!String.IsNullOrWhiteSpace(path)) return path;
            path = ReadInstallLocation(Registry.LocalMachine, Product.LegacyInnoUninstallKey);
            if (!String.IsNullOrWhiteSpace(path)) return path;
            path = ReadInstallLocation(Registry.LocalMachine, Product.LegacyInnoUninstallKey32);
            if (!String.IsNullOrWhiteSpace(path)) return path;

            // Registry entries can be removed manually. Still recognize the documented default path.
            return IsExistingInstall(Product.DefaultInstallDir) ? Product.DefaultInstallDir : null;
        }

        public static string GetInstalledVersion(string dir)
        {
            // Only a folder that is really a Fishingbot installation can have an installed version.
            // Without this check, a stale registry entry could make an empty folder look "newer".
            if (String.IsNullOrWhiteSpace(dir) || !IsExistingInstall(dir)) return "";
            try
            {
                string manifest = Path.Combine(dir, Product.InstallManifestFile);
                if (File.Exists(manifest))
                {
                    foreach (string line in File.ReadAllLines(manifest))
                        if (line.StartsWith("version=", StringComparison.OrdinalIgnoreCase))
                            return line.Substring("version=".Length).Trim();
                }
            }
            catch (Exception ex) { Product.Log("Could not read install manifest version: " + ex.Message); }

            string[] keys = { Product.UninstallKey, Product.UninstallKey32, Product.LegacyInnoUninstallKey, Product.LegacyInnoUninstallKey32 };
            RegistryKey[] hives = { Registry.CurrentUser, Registry.LocalMachine };
            foreach (RegistryKey hive in hives)
            {
                foreach (string subKey in keys)
                {
                    try
                    {
                        using (RegistryKey key = hive.OpenSubKey(subKey))
                        {
                            if (key == null) continue;
                            // The registry entry must name this exact folder. Entries without a location,
                            // or pointing elsewhere (old installs, dev builds), are ignored.
                            string location = Convert.ToString(key.GetValue("InstallLocation") ?? key.GetValue("Inno Setup: App Path") ?? "").Trim();
                            if (String.IsNullOrWhiteSpace(location)) continue;
                            if (!String.Equals(Path.GetFullPath(location).TrimEnd('\\'), Path.GetFullPath(dir).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) continue;
                            object value = key.GetValue("DisplayVersion");
                            // "1.0.0 Beta" -> "1.0.0": the label after the number is for display only; comparisons use the number.
                            if (value != null && !String.IsNullOrWhiteSpace(Convert.ToString(value))) return Convert.ToString(value).Trim().Split(' ')[0];
                        }
                    }
                    catch (Exception ex) { Product.Log("Could not read installed version: " + ex.Message); }
                }
            }
            return "";
        }

        public static string ExistingInstallDescription(string dir)
        {
            if (!IsExistingInstall(dir)) return "";
            string version = GetInstalledVersion(dir);
            string mode = "UPDATE";
            Version installed, current;
            if (Version.TryParse(version, out installed) && Version.TryParse(Product.Version, out current))
                mode = installed.CompareTo(current) == 0 ? "REPAIR" : (installed.CompareTo(current) < 0 ? "UPDATE" : "REPLACE");
            else if (String.IsNullOrWhiteSpace(version)) mode = "SAFE MIGRATION / REPAIR";
            return mode + (String.IsNullOrWhiteSpace(version) ? "" : " FROM VERSION " + version)
                + ". Program files will be updated in place; .env and data\\ are preserved and backed up.";
        }

        public static bool IsNewerVersionInstalled(string dir)
        {
            string value = GetInstalledVersion(dir);
            Version installed, current;
            return Version.TryParse(value, out installed) && Version.TryParse(Product.Version, out current)
                && installed.CompareTo(current) > 0;
        }

        private static string BackupRoot
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Fishingbot", "UpdateBackups"); }
        }

        // Reads KEY=VALUE lines from an existing .env (used to prefill the Twitch page).
        public static Dictionary<string, string> ReadSettings(string dir)
        {
            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            string env = Path.Combine(dir, ".env");
            if (!File.Exists(env)) return values;
            foreach (string raw in File.ReadAllLines(env))
            {
                string line = raw.Trim();
                int eq = line.IndexOf('=');
                if (line.StartsWith("#") || eq <= 0) continue;
                values[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
            }
            return values;
        }

        // The language is stored as interface.language in data\app-settings.json, the file the desktop app and the
        // Control Centre read. Other settings in that file are kept.
        public static string SystemLanguage()
        {
            switch (CultureInfo.CurrentUICulture.TwoLetterISOLanguageName)
            {
                case "de": return "de";
                case "es": return "es";
                case "fr": return "fr";
                case "zh": return "zh";
                default: return "en";
            }
        }

        public static string InitialLanguage(string installDir)
        {
            return (installDir != null ? ReadInterfaceLanguage(installDir) : null) ?? SystemLanguage();
        }

        public static string ReadInterfaceLanguage(string dir)
        {
            try
            {
                string file = Path.Combine(dir, "data", "app-settings.json");
                if (!File.Exists(file)) return null;
                var root = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 }
                    .Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8));
                object section;
                if (root == null || !root.TryGetValue("interface", out section)) return null;
                var values = section as Dictionary<string, object>;
                object code;
                if (values == null || !values.TryGetValue("language", out code) || code == null) return null;
                return code.ToString();
            }
            catch (Exception ex)
            {
                Product.Log("Could not read the stored language: " + ex.Message);
                return null;
            }
        }

        public static void WriteInterfaceLanguage(string installDir, string code)
        {
            try
            {
                string file = Path.Combine(installDir, "data", "app-settings.json");
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                var serializer = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
                var root = new Dictionary<string, object>();
                if (File.Exists(file))
                {
                    var parsed = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8));
                    if (parsed != null) root = parsed;
                }
                object section;
                var values = root.TryGetValue("interface", out section) ? section as Dictionary<string, object> : null;
                if (values == null) values = new Dictionary<string, object>();
                values["language"] = code;
                root["interface"] = values;
                File.WriteAllText(file, serializer.Serialize(root), new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                // The language is a convenience: a failure here must not undo a successful install.
                Product.Log("Could not store the language: " + ex.Message);
            }
        }

        public static void Install(InstallOptions o, Action<int, string> report)
        {
            Product.Log("Install start: " + o.InstallDir);
            bool existingInstall = IsExistingInstall(o.InstallDir);
            // No downgrade block: this release replaces whatever Fishingbot is installed in the folder.

            report(3, "Stopping Fishingbot safely...");
            StopRunning();

            string backupPath = null;
            List<string> newPayloadFiles = new List<string>();
            HashSet<string> existedBefore = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            List<string> previousManifestFiles = ReadInstallManifest(o.InstallDir);
            bool hadManifest = File.Exists(Path.Combine(o.InstallDir, Product.InstallManifestFile));

            try
            {
                using (ZipArchive zip = OpenPayload())
                {
                    foreach (ZipArchiveEntry entry in zip.Entries)
                    {
                        string name = NormalizeRelativePath(entry.FullName);
                        if (IsProtectedUserPath(name))
                            throw new InvalidDataException("The setup payload contains a protected user-data path and cannot be installed: " + entry.FullName);
                        SafeTarget(o.InstallDir, name);
                        if (name.Length > 0 && !entry.FullName.EndsWith("/", StringComparison.Ordinal) && !entry.FullName.EndsWith("\\", StringComparison.Ordinal))
                        {
                            if (!newPayloadFiles.Contains(name, StringComparer.OrdinalIgnoreCase)) newPayloadFiles.Add(name);
                            if (File.Exists(SafeTarget(o.InstallDir, name))) existedBefore.Add(name);
                        }
                    }
                }

                // The uninstaller is always installed by setup, so it must be treated as an
                // owned file from the start. Otherwise the obsolete-file cleanup (which reads the
                // previous manifest, where the uninstaller is listed) would delete it before it is
                // written again.
                if (!newPayloadFiles.Contains(Product.UninstallExeName, StringComparer.OrdinalIgnoreCase))
                    newPayloadFiles.Add(Product.UninstallExeName);
                if (File.Exists(SafeTarget(o.InstallDir, Product.UninstallExeName)))
                    existedBefore.Add(Product.UninstallExeName);

                report(8, existingInstall ? "Creating a private pre-update backup..." : "Preparing a fresh installation...");
                if (existingInstall)
                {
                    backupPath = CreateSafetyBackup(o.InstallDir, newPayloadFiles, previousManifestFiles);
                    o.BackupPath = backupPath ?? "";
                }

                Directory.CreateDirectory(o.InstallDir);
                report(15, existingInstall ? "Updating and repairing program files..." : "Installing program files...");
                using (ZipArchive zip = OpenPayload())
                {
                    int total = Math.Max(1, zip.Entries.Count);
                    int done = 0;
                    foreach (ZipArchiveEntry entry in zip.Entries)
                    {
                        string name = NormalizeRelativePath(entry.FullName);
                        if (IsProtectedUserPath(name))
                            throw new InvalidDataException("The setup payload contains a protected user-data path and cannot be installed: " + entry.FullName);
                        string target = SafeTarget(o.InstallDir, name);
                        bool isDirectory = entry.FullName.EndsWith("/", StringComparison.Ordinal) || entry.FullName.EndsWith("\\", StringComparison.Ordinal);
                        if (isDirectory)
                        {
                            Directory.CreateDirectory(target);
                        }
                        else
                        {
                            string parent = Path.GetDirectoryName(target);
                            Directory.CreateDirectory(parent);
                            string temp = target + ".fishingbot-update-" + Guid.NewGuid().ToString("N") + ".tmp";
                            try
                            {
                                entry.ExtractToFile(temp, false);
                                if (File.Exists(target)) File.SetAttributes(target, FileAttributes.Normal);
                                File.Copy(temp, target, true);
                            }
                            finally { try { if (File.Exists(temp)) File.Delete(temp); } catch (Exception) { } }
                        }
                        done++;
                        if (done % 25 == 0 || done == total)
                            report(15 + (int)(55.0 * done / total), "Updating program files...");
                    }
                }

                report(73, "Installing the uninstaller...");
                InstallUninstaller(o.InstallDir);

                report(76, "Removing obsolete files from previous Fishingbot releases...");
                RemoveObsoleteOwnedFiles(o.InstallDir, previousManifestFiles, newPayloadFiles);

                report(80, "Preserving your settings and database...");
                WriteSettings(o);
                WriteInterfaceLanguage(o.InstallDir, o.Language);
                RemoveLegacyHostingFiles(o.InstallDir);

                report(88, "Writing the install manifest...");
                WriteInstallManifest(o.InstallDir, newPayloadFiles);

                report(93, "Refreshing shortcuts...");
                CreateShortcuts(o);
                report(97, "Registering the installed version...");
                RegisterUninstall(o);
                // Migrate the old Inno Setup registration only after the new files,
                // shortcuts, manifest and uninstall record are successfully installed.
                RemoveLegacyInnoArtifacts(o.InstallDir);
                if (!String.IsNullOrWhiteSpace(backupPath)) TrimSafetyBackups();
                // Last check, after every cleanup step: the uninstaller must be present.
                VerifyInstallation(o.InstallDir);

                Product.Log("Install finished. Mode=" + (existingInstall ? "update/repair" : "fresh") + (String.IsNullOrEmpty(backupPath) ? "" : "; backup=" + backupPath));
                report(100, existingInstall ? "Update complete. Your data is preserved." : "Installation complete.");
            }
            catch (Exception installError)
            {
                Product.Log("Install failed; attempting rollback: " + installError);
                try
                {
                    // Remove only files introduced by this payload; never recurse through user data.
                    foreach (string relative in newPayloadFiles)
                    {
                        if (existedBefore.Contains(relative)) continue;
                        string target = SafeTarget(o.InstallDir, relative);
                        if (File.Exists(target)) File.Delete(target);
                    }
                    string manifestTarget = Path.Combine(o.InstallDir, Product.InstallManifestFile);
                    if (!hadManifest && File.Exists(manifestTarget)) File.Delete(manifestTarget);
                    if (!String.IsNullOrWhiteSpace(backupPath) && File.Exists(backupPath))
                        RestoreSafetyBackup(o.InstallDir, backupPath);
                    Product.Log("Rollback finished. Safety backup=" + (backupPath ?? "not needed"));
                }
                catch (Exception rollbackError)
                {
                    Product.Log("Rollback also failed: " + rollbackError);
                    throw new InvalidOperationException(installError.Message + " Rollback also failed: " + rollbackError.Message
                        + (String.IsNullOrWhiteSpace(backupPath) ? "" : " Your pre-update backup is at: " + backupPath), installError);
                }
                throw new InvalidOperationException(installError.Message
                    + (String.IsNullOrWhiteSpace(backupPath) ? "" : " Previous settings and data were backed up to: " + backupPath), installError);
            }
        }

        // Writes "Uninstall Fishingbot.exe" into the install folder. The uninstaller is this same
        // setup program: it contains the payload and switches to uninstall mode when it is started
        // as "Uninstall ...", with /uninstall, or from the Start Menu entry.
        private static void InstallUninstaller(string installDir)
        {
            string self = Path.GetFullPath(Application.ExecutablePath);
            string target = SafeTarget(installDir, Product.UninstallExeName);
            if (String.Equals(self, target, StringComparison.OrdinalIgnoreCase)) return;

            if (File.Exists(target)) File.SetAttributes(target, FileAttributes.Normal);
            File.Copy(self, target, true);
            if (!File.Exists(target))
                throw new IOException("The uninstaller could not be written to " + target);
            Product.Log("Uninstaller installed: " + target);
        }

        // Final check: a successful install must contain the program, the server runtime,
        // the uninstaller and the manifest. Anything missing triggers the rollback.
        private static void VerifyInstallation(string installDir)
        {
            string[] required = { Product.ExeName, "FishingbotServer.exe", Product.UninstallExeName, Product.InstallManifestFile };
            List<string> missing = new List<string>();
            foreach (string file in required)
                if (!File.Exists(Path.Combine(installDir, file))) missing.Add(file);
            if (missing.Count > 0)
                throw new IOException("Installation is incomplete. Missing: " + String.Join(", ", missing));
        }

        private static string NormalizeRelativePath(string path)
        {
            return (path ?? "").Replace('/', '\\');
        }

        private static bool IsProtectedUserPath(string relative)
        {
            string value = NormalizeRelativePath(relative);
            return value.Equals(".env", StringComparison.OrdinalIgnoreCase)
                || value.StartsWith("data\\", StringComparison.OrdinalIgnoreCase)
                || value.Equals("data", StringComparison.OrdinalIgnoreCase)
                || value.Equals("logs", StringComparison.OrdinalIgnoreCase)
                || value.StartsWith("logs\\", StringComparison.OrdinalIgnoreCase)
                || value.Equals("backups", StringComparison.OrdinalIgnoreCase)
                || value.StartsWith("backups\\", StringComparison.OrdinalIgnoreCase)
                || value.Equals(Product.InstallManifestFile, StringComparison.OrdinalIgnoreCase);
        }

        private static List<string> ReadInstallManifest(string installDir)
        {
            var files = new List<string>();
            string path = Path.Combine(installDir, Product.InstallManifestFile);
            if (!File.Exists(path)) return files;
            bool header = false;
            try
            {
                foreach (string raw in File.ReadAllLines(path))
                {
                    string line = raw.Trim();
                    if (line == "FISHINGBOT-INSTALL-MANIFEST-V1") { header = true; continue; }
                    if (!header || line.Length == 0 || line.StartsWith("version=", StringComparison.OrdinalIgnoreCase)
                        || line.StartsWith("installedAt=", StringComparison.OrdinalIgnoreCase)) continue;
                    string normalized = NormalizeRelativePath(line);
                    if (normalized.Length == 0 || IsProtectedUserPath(normalized)) continue;
                    SafeTarget(installDir, normalized);
                    if (!files.Contains(normalized, StringComparer.OrdinalIgnoreCase)) files.Add(normalized);
                }
            }
            catch (Exception ex) { Product.Log("Install manifest could not be read safely; no untracked files will be removed: " + ex.Message); return new List<string>(); }
            return files;
        }

        private static void WriteInstallManifest(string installDir, IEnumerable<string> files)
        {
            var lines = new List<string>();
            lines.Add("FISHINGBOT-INSTALL-MANIFEST-V1");
            lines.Add("version=" + Product.Version);
            lines.Add("installedAt=" + DateTime.UtcNow.ToString("o"));
            lines.Add("");
            foreach (string raw in files.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                string value = NormalizeRelativePath(raw);
                if (value.Length == 0 || IsProtectedUserPath(value)) continue;
                SafeTarget(installDir, value);
                if (!lines.Contains(value, StringComparer.OrdinalIgnoreCase)) lines.Add(value);
            }
            string target = Path.Combine(installDir, Product.InstallManifestFile);
            string temp = target + ".tmp";
            File.WriteAllLines(temp, lines, new UTF8Encoding(false));
            if (File.Exists(target))
            {
                File.SetAttributes(target, FileAttributes.Normal);
                File.Delete(target);
            }
            File.Move(temp, target);
        }

        private static string CreateSafetyBackup(string installDir, IList<string> payloadFiles, IList<string> oldManifestFiles)
        {
            var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            AddExistingFile(installDir, ".env", files);
            AddExistingFile(installDir, Product.InstallManifestFile, files);
            AddExistingFile(installDir, Product.UninstallExeName, files);

            foreach (string relative in payloadFiles) AddExistingFile(installDir, relative, files);
            foreach (string relative in oldManifestFiles) AddExistingFile(installDir, relative, files);
            foreach (string relative in GetLegacyHostingFiles()) AddExistingFile(installDir, relative, files);
            foreach (string relative in DirectoryFilesSafe(installDir, "data")) files.Add(relative);
            foreach (string relative in LegacyInnoFiles(installDir)) files.Add(relative);

            if (files.Count == 0) return null;
            Directory.CreateDirectory(BackupRoot);
            string backup = Path.Combine(BackupRoot, "Fishingbot-preupdate-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 6) + ".zip");
            try
            {
                using (FileStream output = new FileStream(backup, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
                using (ZipArchive archive = new ZipArchive(output, ZipArchiveMode.Create))
                {
                    foreach (string relative in files.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
                    {
                        string source = SafeTarget(installDir, relative);
                        if (!File.Exists(source)) continue;
                        ZipArchiveEntry entry = archive.CreateEntry(NormalizeRelativePath(relative).Replace('\\', '/'), CompressionLevel.Optimal);
                        using (Stream input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
                        using (Stream destination = entry.Open()) input.CopyTo(destination);
                    }
                }
                Product.Log("Created pre-update safety backup: " + backup + " (" + files.Count + " candidate files)");
                return backup;
            }
            catch
            {
                try { if (File.Exists(backup)) File.Delete(backup); } catch (Exception) { }
                throw;
            }
        }

        private static void AddExistingFile(string installDir, string relative, HashSet<string> files)
        {
            if (String.IsNullOrWhiteSpace(relative)) return;
            string safe = NormalizeRelativePath(relative);
            if (IsProtectedUserPath(safe)
                && !safe.Equals(".env", StringComparison.OrdinalIgnoreCase)
                && !safe.Equals(Product.InstallManifestFile, StringComparison.OrdinalIgnoreCase)
                && !safe.StartsWith("data\\", StringComparison.OrdinalIgnoreCase)) return;
            string path = SafeTarget(installDir, safe);
            if (File.Exists(path)) files.Add(safe);
        }

        private static List<string> DirectoryFilesSafe(string root, string relativeDirectory)
        {
            var result = new List<string>();
            string start = Path.Combine(root, relativeDirectory);
            if (!Directory.Exists(start)) return result;
            if ((File.GetAttributes(start) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("The data folder is a junction or symbolic link. Setup will not guess how to back it up: " + start);
            AddDirectoryFilesSafe(root, start, result);
            return result;
        }

        private static void AddDirectoryFilesSafe(string root, string current, List<string> result)
        {
            foreach (string file in Directory.GetFiles(current))
            {
                if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("A data file is a junction or symbolic link. Setup stopped so its backup is not incomplete: " + file);
                result.Add(file.Substring(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar).Length + 1));
            }
            foreach (string directory in Directory.GetDirectories(current))
            {
                if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("A data subfolder is a junction or symbolic link. Setup stopped so its backup is not incomplete: " + directory);
                AddDirectoryFilesSafe(root, directory, result);
            }
        }

        private static List<string> LegacyInnoFiles(string installDir)
        {
            var result = new List<string>();
            // Inno Setup names its files unins000.exe / .dat / .msg. The pattern "unins*" must not be
            // used: on Windows it also matches "Uninstall Fishingbot.exe", which is the current uninstaller.
            foreach (string file in Directory.GetFiles(installDir, "unins*.*", SearchOption.TopDirectoryOnly))
            {
                string name = Path.GetFileName(file);
                if (name.Equals(Product.UninstallExeName, StringComparison.OrdinalIgnoreCase)) continue;
                if (!Regex.IsMatch(name, @"^unins\d{3}\.(exe|dat|msg)$", RegexOptions.IgnoreCase)) continue;
                result.Add(file.Substring(Path.GetFullPath(installDir).TrimEnd(Path.DirectorySeparatorChar).Length + 1));
            }
            return result;
        }

        private static List<string> GetLegacyHostingFiles()
        {
            return new List<string> {
                Path.Combine("tools", "caddy.exe"), Path.Combine("tools", "cloudflared.exe"),
                Path.Combine("tools", "tailscale-setup.exe"), "cloudflared.exe", "caddy.exe",
                Path.Combine("local", "tailscale-funnel.js"), Path.Combine("local", "viewer-gateway.js"),
                Path.Combine("local", "tunnel.js"), Path.Combine("local", "public-access.js"),
                Path.Combine("scripts", "tailscale-funnel-elevated.ps1"), Path.Combine("scripts", "fetch-tailscale-installer.ps1"),
                Path.Combine("scripts", "diagnose-public-hosting.ps1")
            };
        }

        private static void RemoveObsoleteOwnedFiles(string installDir, IList<string> oldFiles, IList<string> newFiles)
        {
            var current = new HashSet<string>(newFiles.Select(NormalizeRelativePath), StringComparer.OrdinalIgnoreCase);
            foreach (string raw in oldFiles)
            {
                string relative = NormalizeRelativePath(raw);
                if (relative.Length == 0 || IsProtectedUserPath(relative) || current.Contains(relative)) continue;
                string target = SafeTarget(installDir, relative);
                if (File.Exists(target))
                {
                    File.SetAttributes(target, FileAttributes.Normal);
                    File.Delete(target);
                    Product.Log("Removed obsolete app-owned file: " + relative);
                }
                RemoveEmptyParents(Path.GetDirectoryName(target), installDir);
            }
        }

        private static void RemoveEmptyParents(string directory, string root)
        {
            string rootFull = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            while (!String.IsNullOrWhiteSpace(directory))
            {
                string full = Path.GetFullPath(directory);
                if (!full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase)) break;
                if (!Directory.Exists(full) || Directory.EnumerateFileSystemEntries(full).Any()) break;
                Directory.Delete(full);
                directory = Path.GetDirectoryName(full);
            }
        }

        private static void RestoreSafetyBackup(string installDir, string backupPath)
        {
            using (FileStream input = new FileStream(backupPath, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (ZipArchive archive = new ZipArchive(input, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string relative = NormalizeRelativePath(entry.FullName);
                    string target = SafeTarget(installDir, relative);
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    if (File.Exists(target)) File.SetAttributes(target, FileAttributes.Normal);
                    entry.ExtractToFile(target, true);
                }
            }
        }

        private static void TrimSafetyBackups()
        {
            try
            {
                if (!Directory.Exists(BackupRoot)) return;
                string[] files = Directory.GetFiles(BackupRoot, "Fishingbot-preupdate-*.zip")
                    .OrderByDescending(File.GetCreationTimeUtc).ToArray();
                for (int i = 3; i < files.Length; i++) File.Delete(files[i]);
            }
            catch (Exception ex) { Product.Log("Could not trim old update backups: " + ex.Message); }
        }

        private static void RemoveLegacyInnoArtifacts(string installDir)
        {
            foreach (string relative in LegacyInnoFiles(installDir))
            {
                try { TryDeleteFile(Path.Combine(installDir, relative)); }
                catch (Exception ex) { Product.Log("Could not remove old Inno Setup file " + relative + ": " + ex.Message); }
            }
            try { Registry.CurrentUser.DeleteSubKeyTree(Product.LegacyInnoUninstallKey, false); }
            catch (Exception ex) { Product.Log("Could not remove legacy per-user uninstall registration: " + ex.Message); }
            try { Registry.CurrentUser.DeleteSubKeyTree(Product.LegacyInnoUninstallKey32, false); }
            catch (Exception ex) { Product.Log("Could not remove legacy 32-bit per-user uninstall registration: " + ex.Message); }
            try { Registry.LocalMachine.DeleteSubKeyTree(Product.LegacyInnoUninstallKey, false); }
            catch (Exception ex) { Product.Log("Could not remove legacy machine uninstall registration (may require admin): " + ex.Message); }
            try { Registry.LocalMachine.DeleteSubKeyTree(Product.LegacyInnoUninstallKey32, false); }
            catch (Exception ex) { Product.Log("Could not remove legacy 32-bit machine uninstall registration: " + ex.Message); }
        }

        private static string SafeTarget(string root, string entryName)
        {
            string normalized = NormalizeRelativePath(entryName);
            if (String.IsNullOrWhiteSpace(normalized) || Path.IsPathRooted(normalized)
                || Regex.IsMatch(normalized, "^[A-Za-z]:")
                || normalized.Split(Path.DirectorySeparatorChar).Any(part => part == ".." || part == "."))
                throw new InvalidDataException("Unsafe path in setup payload: " + entryName);
            string rootFull = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string full = Path.GetFullPath(Path.Combine(rootFull, normalized));
            if (!full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Unsafe path in setup payload: " + entryName);

            // Do not follow junctions/symlinks inside the install root while writing or
            // restoring. This prevents an archive entry from escaping through a reparse point.
            string cursor = rootFull.TrimEnd(Path.DirectorySeparatorChar);
            string relativeParent = Path.GetDirectoryName(normalized);
            if (!String.IsNullOrWhiteSpace(relativeParent))
            {
                foreach (string part in relativeParent.Split(Path.DirectorySeparatorChar))
                {
                    cursor = Path.Combine(cursor, part);
                    if (Directory.Exists(cursor) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
                        throw new InvalidDataException("Install path contains a directory junction or symbolic link: " + cursor);
                }
            }
            if (File.Exists(full) && (File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Install target is a symbolic link: " + full);
            return full;
        }

        // Fresh install: write a complete .env. Upgrade: preserve saved credentials and relay settings,
        // while keeping the selected local port and loopback-only origin in sync.
        public static void WriteSettings(InstallOptions o)
        {
            string env = Path.Combine(o.InstallDir, ".env");
            var utf8 = new UTF8Encoding(false);
            if (!File.Exists(env))
            {
                string text = string.Join(Environment.NewLine, new[]
                {
                    "# Fishingbot settings (written by the setup program)",
                    "TWITCH_CLIENT_ID=" + o.ClientId,
                    "TWITCH_CLIENT_SECRET=" + (o.ClientSecret ?? ""),
                    "FISHINGBOT_EXTENSION_RELAY_URL=",
                    "",
                    "PORT=" + o.Port,
                    "PUBLIC_BASE_URL=http://localhost:" + o.Port,
                    "LOCAL_DB_PATH=data/fishing.sqlite",
                    "",
                    "# Generated automatically on first start when left empty.",
                    "SESSION_SECRET=",
                    "BOT_SECRET=",
                    "",
                    "# Optional: MasterAdmin login.",
                    "ADMIN_USERNAME=",
                    "ADMIN_PASSWORD=",
                    "ADMIN_SESSION_SECRET="
                }) + Environment.NewLine;
                File.WriteAllText(env, text, utf8);
                return;
            }
            var lines = File.ReadAllLines(env).ToList();
            string savedClientId = GetLastSetting(lines, "TWITCH_CLIENT_ID");
            SetKey(lines, "TWITCH_CLIENT_ID", String.IsNullOrWhiteSpace(savedClientId) ? Product.TwitchClientId : savedClientId);
            // Keep saved OAuth credentials and the user's existing relay URL. Blank setup
            // fields must never erase a custom Client ID, Client Secret or relay endpoint.
            if (!String.IsNullOrWhiteSpace(o.ClientSecret)) SetKey(lines, "TWITCH_CLIENT_SECRET", o.ClientSecret);
            SetKey(lines, "PORT", o.Port.ToString());
            SetKey(lines, "PUBLIC_BASE_URL", "http://localhost:" + o.Port);
            // Remove obsolete direct-hosting credentials from an existing install.
            lines.RemoveAll(l => Regex.IsMatch(l, "^\\s*(DUCKDNS_DOMAIN|DUCKDNS_TOKEN|TLS_EMAIL)\\s*="));
            File.WriteAllLines(env, lines, utf8);
        }

        private static string GetLastSetting(IList<string> lines, string key)
        {
            var pattern = new Regex("^\\s*" + Regex.Escape(key) + "\\s*=");
            for (int i = lines.Count - 1; i >= 0; i--)
            {
                if (!pattern.IsMatch(lines[i])) continue;
                int equals = lines[i].IndexOf('=');
                return equals >= 0 ? lines[i].Substring(equals + 1).Trim().Trim('\"', '\'') : "";
            }
            return "";
        }

        private static void SetKey(List<string> lines, string key, string value)
        {
            var pattern = new Regex("^\\s*" + Regex.Escape(key) + "\\s*=");
            int index = lines.FindIndex(l => pattern.IsMatch(l));
            string line = key + "=" + value;
            if (index < 0) { lines.Add(line); return; }
            lines[index] = line;
            for (int i = lines.Count - 1; i > index; i--)
                if (pattern.IsMatch(lines[i])) lines.RemoveAt(i);
        }

        // Remove retired public-hosting and Tailscale Funnel files/settings from upgrades.
        // This does not uninstall the Tailscale client or touch SQLite/player/admin data.
        private static void RemoveLegacyHostingFiles(string installDir)
        {
            foreach (string relative in new[] {
                Path.Combine("tools", "caddy.exe"),
                Path.Combine("tools", "cloudflared.exe"),
                Path.Combine("tools", "tailscale-setup.exe"),
                "cloudflared.exe",
                "caddy.exe",
                Path.Combine("local", "tailscale-funnel.js"),
                Path.Combine("local", "viewer-gateway.js"),
                Path.Combine("local", "tunnel.js"),
                Path.Combine("local", "public-access.js"),
                Path.Combine("scripts", "tailscale-funnel-elevated.ps1"),
                Path.Combine("scripts", "fetch-tailscale-installer.ps1"),
                Path.Combine("scripts", "diagnose-public-hosting.ps1")
            })
            {
                string retired = Path.Combine(installDir, relative);
                try { if (File.Exists(retired)) File.Delete(retired); }
                catch (Exception ex) { Product.Log("Could not remove retired sharing file " + relative + ": " + ex.Message); }
            }
            string env = Path.Combine(installDir, ".env");
            try
            {
                if (File.Exists(env))
                {
                    var lines = File.ReadAllLines(env).Where(l =>
                        !Regex.IsMatch(l, "^\\s*(DUCKDNS_DOMAIN|DUCKDNS_TOKEN|TLS_EMAIL|TAILSCALE_FUNNEL_[A-Z0-9_]*|FISHINGBOT_TAILSCALE_[A-Z0-9_]*|PUBLIC_VIEWER_GATEWAY_[A-Z0-9_]*)\\s*="));
                    File.WriteAllLines(env, lines, new UTF8Encoding(false));
                }
            }
            catch (Exception ex) { Product.Log("Could not remove retired hosting settings from .env: " + ex.Message); }
            string tools = Path.Combine(installDir, "tools");
            try { if (Directory.Exists(tools) && !Directory.EnumerateFileSystemEntries(tools).Any()) Directory.Delete(tools); }
            catch (Exception) { }
            // Deliberately retain data\public-hosting and every other data folder. Old
            // feature state is user data; upgrades must not recursively delete it.
        }

        public static void StopRunning()
        {
            // Electron runs several processes named Fishingbot: the window and its GPU and renderer helpers.
            // Only the process that owns a window is asked to close; the helpers end with it.
            foreach (Process p in Process.GetProcessesByName("Fishingbot"))
            {
                try
                {
                    if (p.HasExited || p.MainWindowHandle == IntPtr.Zero) continue;
                    p.CloseMainWindow();
                    if (!p.WaitForExit(15000))
                        throw new InvalidOperationException("Fishingbot is still running. Close it normally before updating so its database can shut down safely.");
                }
                catch (InvalidOperationException) { throw; }
                catch (Exception ex)
                {
                    Product.Log("Could not close Fishingbot desktop app: " + ex.Message);
                    throw new InvalidOperationException("Fishingbot could not be closed safely. Close it manually, then run setup again.", ex);
                }
                finally { p.Dispose(); }
            }

            // Give the helper processes a moment to end with the window. They hold no database.
            foreach (Process p in Process.GetProcessesByName("Fishingbot"))
            {
                try { if (!p.HasExited) p.WaitForExit(5000); }
                catch (Exception) { }
                finally { p.Dispose(); }
            }

            // Never kill the SQLite-owning server as an installer shortcut. The desktop
            // shell has already requested graceful shutdown; if it is still running,
            // abort the update and let the user close it rather than risk DB corruption.
            foreach (Process p in Process.GetProcessesByName("FishingbotServer"))
            {
                try
                {
                    if (!p.HasExited && !p.WaitForExit(15000))
                        throw new InvalidOperationException("Fishingbot's local server is still closing. Wait for it to stop, then run setup again. Your database has not been touched.");
                }
                catch (InvalidOperationException) { throw; }
                catch (Exception ex)
                {
                    Product.Log("Could not confirm FishingbotServer shutdown: " + ex.Message);
                    throw new InvalidOperationException("Fishingbot's local server could not be confirmed stopped. Setup has stopped to protect your database.", ex);
                }
                finally { p.Dispose(); }
            }
        }

        public static void CreateShortcuts(InstallOptions o)
        {
            string exe = Path.Combine(o.InstallDir, Product.ExeName);
            string uninstall = Path.Combine(o.InstallDir, Product.UninstallExeName);
            string startMenuFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Product.Name);
            string desktopShortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Product.Name + ".lnk");
            // The plain icon file ships next to the app; shortcuts use it when it is there.
            string appIcon = Path.Combine(o.InstallDir, "app.ico");
            if (!File.Exists(appIcon)) appIcon = null;
            if (o.StartMenu)
            {
                Directory.CreateDirectory(startMenuFolder);
                Shortcut.Create(Path.Combine(startMenuFolder, Product.Name + ".lnk"), exe, "", o.InstallDir, "Start Fishingbot", appIcon);
                Shortcut.Create(Path.Combine(startMenuFolder, "Uninstall " + Product.Name + ".lnk"), uninstall, "/uninstall", o.InstallDir, "Uninstall Fishingbot", null);
            }
            else
            {
                TryDeleteDir(startMenuFolder);
            }
            if (o.DesktopShortcut)
            {
                Shortcut.Create(desktopShortcut, exe, "", o.InstallDir, "Start Fishingbot", appIcon);
            }
            else
            {
                TryDeleteFile(desktopShortcut);
            }
        }

        public static void RemoveShortcuts()
        {
            TryDeleteDir(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Product.Name));
            TryDeleteFile(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Product.Name + ".lnk"));
        }

        public static void RegisterUninstall(InstallOptions o)
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(Product.UninstallKey))
            {
                key.SetValue("DisplayName", Product.Name);
                key.SetValue("DisplayVersion", Product.DisplayVersion);
                key.SetValue("Publisher", Product.Name);
                key.SetValue("InstallLocation", o.InstallDir);
                key.SetValue("DisplayIcon", Path.Combine(o.InstallDir, Product.ExeName));
                key.SetValue("UninstallString", "\"" + Path.Combine(o.InstallDir, Product.UninstallExeName) + "\" /uninstall");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                key.SetValue("EstimatedSize", (int)(PayloadBytes / 1024), RegistryValueKind.DWord);
                key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            }
        }

        public static void SetUninstallRetryPath(string executable, string installDir)
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(Product.UninstallKey))
            {
                key.SetValue("DisplayName", Product.Name);
                key.SetValue("DisplayVersion", Product.DisplayVersion);
                key.SetValue("Publisher", Product.Name);
                key.SetValue("InstallLocation", installDir);
                key.SetValue("DisplayIcon", executable);
                key.SetValue("UninstallString", "\"" + executable + "\" /uninstall /copied /dir:\"" + installDir + "\"");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        // deleteData = false keeps .env, data, logs and backups for a later reinstall.
        public static void Uninstall(string dir, bool deleteData, Action<int, string> report)
        {
            string full = Path.GetFullPath(dir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string root = Path.GetPathRoot(full);
            if (String.IsNullOrWhiteSpace(full) || String.Equals(full, root, StringComparison.OrdinalIgnoreCase)
                || !Directory.Exists(full) || !IsExistingInstall(full))
                throw new InvalidOperationException("The selected folder is no longer a recognized Fishingbot installation. No files were removed.");
            Environment.CurrentDirectory = Path.GetTempPath();
            Product.Log("Uninstall start: " + full + " deleteData=" + deleteData);
            report(5, "Stopping Fishingbot...");
            StopRunning();

            report(20, "Removing shortcuts...");
            RemoveShortcuts();

            if (!Directory.Exists(full))
            {
                RemoveUninstallRegistration();
                report(100, "Done.");
                return;
            }

            var failures = new List<string>();
            report(45, "Removing program files...");
            foreach (string file in Directory.GetFiles(full))
            {
                string name = Path.GetFileName(file);
                if (!deleteData && name.Equals(".env", StringComparison.OrdinalIgnoreCase)) continue;
                // The uninstaller is removed last, so a failed run can still be retried from it.
                if (name.Equals(Product.UninstallExeName, StringComparison.OrdinalIgnoreCase)) continue;
                DeleteFileChecked(file, failures);
            }
            foreach (string sub in Directory.GetDirectories(full))
            {
                string name = Path.GetFileName(sub);
                if (!deleteData && (name.Equals("data", StringComparison.OrdinalIgnoreCase)
                    || name.Equals("logs", StringComparison.OrdinalIgnoreCase)
                    || name.Equals("backups", StringComparison.OrdinalIgnoreCase))) continue;
                DeleteDirectoryChecked(sub, failures);
            }
            DeleteFileChecked(Path.Combine(full, Product.UninstallExeName), failures);

            report(85, "Checking remaining files...");
            string[] remaining = Directory.Exists(full) ? Directory.GetFileSystemEntries(full) : new string[0];
            if (deleteData && remaining.Length > 0)
                foreach (string item in remaining)
                {
                    if (Directory.Exists(item)) DeleteDirectoryChecked(item, failures);
                    else DeleteFileChecked(item, failures);
                }
            remaining = Directory.Exists(full) ? Directory.GetFileSystemEntries(full) : new string[0];
            if (remaining.Length == 0 && Directory.Exists(full))
            {
                // Antivirus or indexing can hold the folder for a moment after its last file is gone.
                for (int attempt = 1; ; attempt++)
                {
                    try { Directory.Delete(full, false); break; }
                    catch (Exception ex)
                    {
                        if (attempt >= 6) { failures.Add(full + " (" + ex.Message + ")"); break; }
                        System.Threading.Thread.Sleep(500);
                    }
                }
            }

            if (failures.Count > 0 || (Directory.Exists(full) && deleteData && Directory.GetFileSystemEntries(full).Length > 0))
            {
                string detail = String.Join(Environment.NewLine, failures.Take(12).ToArray());
                Product.Log("Uninstall incomplete; Windows registration retained for retry. " + detail);
                throw new IOException("Some Fishingbot files could not be removed. Close any process using them and run Uninstall Fishingbot again. The uninstaller entry has been retained. Details: " + Product.LogPath
                    + (String.IsNullOrWhiteSpace(detail) ? "" : Environment.NewLine + detail));
            }

            if (deleteData) DeleteDirectoryChecked(BackupRoot, failures);
            if (failures.Count > 0)
            {
                string detail = String.Join(Environment.NewLine, failures.Take(12).ToArray());
                Product.Log("Uninstall incomplete; Windows registration retained for retry. " + detail);
                throw new IOException("Some Fishingbot files or backups could not be removed. Close any process using them and run Uninstall Fishingbot again. The uninstaller entry has been retained. Details: " + Product.LogPath
                    + (String.IsNullOrWhiteSpace(detail) ? "" : Environment.NewLine + detail));
            }
            report(95, "Removing Windows registration...");
            RemoveUninstallRegistration();
            report(100, "Uninstall complete.");
            Product.Log("Uninstall finished. User data " + (deleteData ? "removed" : "preserved" ) + ".");
            ScheduleTemporaryUninstallerCleanup(Application.ExecutablePath);
        }

        private static void ScheduleTemporaryUninstallerCleanup(string executablePath)
        {
            try
            {
                string full = Path.GetFullPath(executablePath);
                string tempRoot = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
                if (!full.StartsWith(tempRoot, StringComparison.OrdinalIgnoreCase)
                    || !Path.GetFileName(full).StartsWith("Fishingbot-Uninstall-", StringComparison.OrdinalIgnoreCase)) return;
                string command = "/c ping 127.0.0.1 -n 3 > nul & del /f /q \"" + full + "\"";
                Process.Start(new ProcessStartInfo("cmd.exe", command) { CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden });
            }
            catch (Exception ex) { Product.Log("Could not schedule temporary uninstaller cleanup: " + ex.Message); }
        }

        private static void RemoveUninstallRegistration()
        {
            foreach (string keyPath in new[] { Product.UninstallKey, Product.UninstallKey32 })
            {
                try
                {
                    Registry.CurrentUser.DeleteSubKeyTree(keyPath, false);
                    using (RegistryKey check = Registry.CurrentUser.OpenSubKey(keyPath))
                    {
                        if (check != null) throw new IOException("Windows uninstall registration still exists: " + keyPath);
                    }
                }
                catch (Exception ex)
                {
                    Product.Log("Could not remove uninstall registration " + keyPath + ": " + ex.Message);
                    throw new IOException("Fishingbot files were removed, but Windows could not remove the uninstall registration. Run the retained uninstaller again after checking registry permissions. Details: " + Product.LogPath, ex);
                }
            }
        }

        private static void DeleteFileChecked(string path, IList<string> failures)
        {
            try
            {
                if (!File.Exists(path)) return;
                for (int attempt = 1; ; attempt++)
                {
                    try
                    {
                        File.SetAttributes(path, FileAttributes.Normal);
                        File.Delete(path);
                        break;
                    }
                    catch (IOException) { if (attempt >= 6) throw; System.Threading.Thread.Sleep(500); }
                    catch (UnauthorizedAccessException) { if (attempt >= 6) throw; System.Threading.Thread.Sleep(500); }
                }
                if (File.Exists(path)) throw new IOException("File still exists after delete.");
            }
            catch (Exception ex)
            {
                failures.Add(path + " (" + ex.Message + ")");
                Product.Log("Could not delete " + path + ": " + ex.Message);
            }
        }

        // Recursion stops at reparse points: remove the link itself, never its target.
        private static void DeleteDirectoryChecked(string path, IList<string> failures)
        {
            try
            {
                if (!Directory.Exists(path)) return;
                FileAttributes attributes = File.GetAttributes(path);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                {
                    Directory.Delete(path, false);
                    return;
                }
                foreach (string file in Directory.GetFiles(path)) DeleteFileChecked(file, failures);
                foreach (string child in Directory.GetDirectories(path)) DeleteDirectoryChecked(child, failures);
                if (Directory.Exists(path)) Directory.Delete(path, false);
            }
            catch (Exception ex)
            {
                failures.Add(path + " (" + ex.Message + ")");
                Product.Log("Could not delete folder " + path + ": " + ex.Message);
            }
        }

        private static void TryDeleteFile(string path)
        {
            DeleteFileChecked(path, new List<string>());
        }

        private static void TryDeleteDir(string path)
        {
            DeleteDirectoryChecked(path, new List<string>());
        }
    }

    // ==================================================================================
    // Visual layer (v2.6.0 redesign). Text-first and flat: ink surfaces, one signal accent,
    // no gradients, no decorative illustrations. Palette follows the website (styles/index.css).
    // Contrast: captions >= 4.5:1, field and checkbox edges >= 3:1 (WCAG 2.1 AA).
    // Every control is reachable with Tab, shows a focus ring, and Enter/Escape work.
    // ==================================================================================

    internal static class Theme
    {
        // The desktop app's palette (renderer/desktop.css), so the setup looks like the app it installs.
        public static readonly Color Ink = Color.FromArgb(16, 18, 20);          // --bg, the window
        public static readonly Color InkDeep = Color.FromArgb(28, 31, 35);      // fields and control fills
        public static readonly Color InkPanel = Color.FromArgb(25, 28, 32);     // --panel, the footer
        public static readonly Color InkLine = Color.FromArgb(54, 60, 68);      // --line, progress tracks
        public static readonly Color Bone = Color.FromArgb(241, 242, 244);      // --ink, headings and labels
        public static readonly Color Text2 = Color.FromArgb(206, 210, 216);     // body copy
        public static readonly Color BoneDim = Color.FromArgb(163, 170, 180);   // --muted, captions
        public static readonly Color BoneFaint = Color.FromArgb(96, 103, 112);  // disabled only
        public static readonly Color Rule = Color.FromArgb(35, 39, 45);         // hairlines only
        public static readonly Color FieldEdge = Color.FromArgb(74, 82, 92);    // --line2, field edges
        public static readonly Color Signal = Color.FromArgb(242, 112, 63);     // --orange, 6.7:1 on the window
        public static readonly Color SignalHi = Color.FromArgb(246, 136, 96);   // hover
        public static readonly Color SignalDeep = Color.FromArgb(206, 92, 48);  // pressed
        public static readonly Color SignalOff = Color.FromArgb(74, 42, 30);    // disabled primary
        public static readonly Color Brass = Color.FromArgb(255, 186, 150);     // focus ring
        public static readonly Color Ok = Color.FromArgb(94, 196, 150);
        public static readonly Color Danger = Color.FromArgb(221, 112, 95);     // --red
        public static readonly Color Warn = Color.FromArgb(214, 170, 75);       // --yellow

        // The desktop uses Segoe UI for everything and Consolas for numbers. The same fonts are used here.
        public static readonly Font FontDisplay = new Font(Pick("Segoe UI Semibold", "Segoe UI"), 19f, FontStyle.Regular);
        public static readonly Font FontHeading = new Font(Pick("Segoe UI Semibold", "Segoe UI"), 11f, FontStyle.Regular);
        public static readonly Font FontBody = new Font(Pick("Segoe UI", "Tahoma"), 10f);
        public static readonly Font FontButton = new Font(Pick("Segoe UI Semibold", "Segoe UI"), 10f, FontStyle.Regular);
        public static readonly Font FontMono = new Font(Pick("Consolas", "Courier New"), 8.5f, FontStyle.Bold);
        public static readonly Font FontMonoSmall = new Font(Pick("Consolas", "Courier New"), 9f);

        // Corner radii: the desktop's --r-md for controls and --r-xl for the window.
        public const int Radius = 9;
        public const int WindowRadius = 16;

        // A rounded rectangle. The corner radius is kept inside the box, so a small box stays a clean shape.
        public static GraphicsPath RoundRect(Rectangle r, int radius)
        {
            var path = new GraphicsPath();
            int d = Math.Max(1, Math.Min(radius * 2, Math.Min(r.Width, r.Height)));
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        // Paints a panel into a back buffer, so motion does not flicker. Panel hides this property, so it is set by name.
        public static void Buffer(Control c)
        {
            try
            {
                PropertyInfo p = typeof(Control).GetProperty("DoubleBuffered", BindingFlags.Instance | BindingFlags.NonPublic);
                if (p != null) p.SetValue(c, true, null);
            }
            catch (Exception) { /* the panel still works without buffering */ }
        }

        // Blends two colours. t = 0 gives a, t = 1 gives b.
        public static Color Mix(Color a, Color b, float t)
        {
            t = Math.Max(0f, Math.Min(1f, t));
            return Color.FromArgb(
                (int)Math.Round(a.R + (b.R - a.R) * t),
                (int)Math.Round(a.G + (b.G - a.G) * t),
                (int)Math.Round(a.B + (b.B - a.B) * t));
        }

        public const int Margin = 40;          // left and right page margin
        public const int ContentWidth = 640;   // 720 - 2 * Margin

        private static string Pick(params string[] names)
        {
            foreach (string name in names)
                foreach (FontFamily family in FontFamily.Families)
                    if (string.Equals(family.Name, name, StringComparison.OrdinalIgnoreCase)) return name;
            return names[names.Length - 1];
        }

        public static Label Lbl(string text, Font font, Color color, int maxWidth)
        {
            var label = new Label();
            label.Text = text;
            label.Font = font;
            label.ForeColor = color;
            label.BackColor = Color.Transparent;
            label.AutoSize = true;
            if (maxWidth > 0) label.MaximumSize = new Size(maxWidth, 0);
            return label;
        }

        // A horizontal row (input + button, or number + text).
        public static FlowLayoutPanel Row()
        {
            var row = new FlowLayoutPanel();
            row.AutoSize = true;
            row.FlowDirection = FlowDirection.LeftToRight;
            row.WrapContents = false;
            row.BackColor = Ink;
            row.Margin = new Padding(0, 4, 0, 0);
            return row;
        }
    }

    internal static class NativeMethods
    {
        [DllImport("user32.dll")] public static extern bool ReleaseCapture();
        [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        public const int WM_NCLBUTTONDOWN = 0xA1;
        public const int HTCAPTION = 0x2;
    }

    // Shared focus handling for controls that are not native buttons: Space activates,
    // and a Brass ring is drawn while the control has keyboard focus.
    internal static class Focusable
    {
        public static void DrawRing(Graphics g, Rectangle bounds)
        {
            using (var ring = new Pen(Theme.Brass, 2f))
                g.DrawRectangle(ring, bounds.X + 1, bounds.Y + 1, bounds.Width - 3, bounds.Height - 3);
        }

        // The same ring with rounded corners, for the rounded controls.
        public static void DrawRing(Graphics g, Rectangle bounds, int radius)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var ring = new Pen(Theme.Brass, 2f))
            using (GraphicsPath path = Theme.RoundRect(new Rectangle(bounds.X + 1, bounds.Y + 1, bounds.Width - 3, bounds.Height - 3), radius))
                g.DrawPath(ring, path);
            g.SmoothingMode = SmoothingMode.None;
        }
    }

    // Eases a value towards a target, one step per frame, and asks its control to repaint. The timer stops as
    // soon as the value settles, so an idle installer does no work. Used for hover, press and progress motion.
    internal sealed class Smooth
    {
        private readonly Control _owner;
        private readonly Timer _timer = new Timer();
        private float _target;
        private float _value;

        public Smooth(Control owner, float start)
        {
            _owner = owner;
            _value = start;
            _target = start;
            _timer.Interval = 16;
            _timer.Tick += Step;
            owner.Disposed += delegate { _timer.Stop(); _timer.Dispose(); };
        }

        public float Value { get { return _value; } }

        public void To(float target)
        {
            _target = target;
            if (!_timer.Enabled && Math.Abs(_target - _value) > 0.001f) _timer.Start();
        }

        private void Step(object sender, EventArgs e)
        {
            if (_owner.IsDisposed) { _timer.Stop(); return; }
            _value += (_target - _value) * 0.3f;
            if (Math.Abs(_target - _value) < 0.005f)
            {
                _value = _target;
                _timer.Stop();
            }
            _owner.Invalidate();
        }
    }

    // Rounded button. Primary = accent fill with dark text. Otherwise a ghost button with a hairline edge.
    // Hover and press ease in and out instead of switching at once.
    internal sealed class RoundButton : Control
    {
        private bool _down;
        private readonly bool _primary;
        private readonly Smooth _hover;

        // A selected choice (for example the chosen language) is painted like a primary button.
        public bool Selected { get; set; }

        public RoundButton(string text, bool primary, int width)
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                     ControlStyles.SupportsTransparentBackColor | ControlStyles.Selectable, true);
            _primary = primary;
            _hover = new Smooth(this, 0f);
            Text = text;
            Font = Theme.FontButton;
            Width = width;
            Height = 42;
            Cursor = Cursors.Hand;
            TabStop = true;
            BackColor = Color.Transparent;
        }

        protected override void OnMouseEnter(EventArgs e) { _hover.To(1f); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover.To(0f); _down = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { if (e.Button == MouseButtons.Left) { _down = true; Focus(); Invalidate(); } base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { _down = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
        protected override void OnTextChanged(EventArgs e) { Invalidate(); base.OnTextChanged(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { _down = false; Invalidate(); base.OnLostFocus(e); }

        protected override bool IsInputKey(Keys key)
        {
            return key == Keys.Space || base.IsInputKey(key);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Space) { _down = true; Invalidate(); }
            base.OnKeyDown(e);
        }

        protected override void OnKeyUp(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Space && _down)
            {
                _down = false;
                Invalidate();
                OnClick(EventArgs.Empty);
            }
            base.OnKeyUp(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            float h = _hover.Value;
            bool pressed = _down && Enabled;
            Rectangle box = new Rectangle(0, 0, Width - 1, Height - 1);
            Color fill, edge, fore;
            if (!Enabled)
            {
                fill = (_primary || Selected) ? Theme.SignalOff : Theme.InkDeep;
                edge = Theme.Rule;
                fore = Theme.BoneFaint;
            }
            else if (_primary || Selected)
            {
                fill = pressed ? Theme.SignalDeep : Theme.Mix(Theme.Signal, Theme.SignalHi, h);
                edge = fill;
                fore = Theme.Ink;
            }
            else
            {
                fill = pressed ? Theme.InkLine : Theme.Mix(Theme.InkDeep, Theme.InkLine, h);
                edge = Theme.Mix(Theme.FieldEdge, Theme.Signal, h);
                fore = Theme.Bone;
            }
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = Theme.RoundRect(box, Theme.Radius))
            {
                using (var brush = new SolidBrush(fill)) g.FillPath(brush, path);
                using (var pen = new Pen(edge)) g.DrawPath(pen, path);
            }
            g.SmoothingMode = SmoothingMode.None;
            if (Focused && Enabled) Focusable.DrawRing(g, new Rectangle(0, 0, Width, Height), Theme.Radius);
            // A press sinks the label by a pixel, like a key.
            Rectangle label = new Rectangle(0, pressed ? 1 : 0, Width, Height);
            TextRenderer.DrawText(g, Text, Font, label, fore,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
        }
    }

    // Text field: rounded, dark, with a hairline edge that warms to the accent while it has focus.
    internal sealed class FieldBox : Panel
    {
        public readonly TextBox Input = new TextBox();
        private readonly Smooth _glow;

        public FieldBox(int width, bool password)
        {
            Width = width;
            Height = 42;
            BackColor = Theme.Ink;
            _glow = new Smooth(this, 0f);
            Input.BorderStyle = BorderStyle.None;
            Input.BackColor = Theme.InkDeep;
            Input.ForeColor = Theme.Bone;
            Input.Font = Theme.FontBody;
            Input.UseSystemPasswordChar = password;
            Input.Location = new Point(14, 11);
            Input.Width = width - 28;
            Input.Enter += (s, e) => _glow.To(1f);
            Input.Leave += (s, e) => _glow.To(0f);
            Controls.Add(Input);
        }

        public string AccessibleLabel
        {
            get { return Input.AccessibleName; }
            set { Input.AccessibleName = value; }
        }

        public override string Text
        {
            get { return Input.Text; }
            set { Input.Text = value ?? ""; }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle box = new Rectangle(0, 0, Width - 1, Height - 1);
            Color edge = Theme.Mix(Theme.FieldEdge, Theme.Signal, _glow.Value);
            using (GraphicsPath path = Theme.RoundRect(box, Theme.Radius))
            {
                using (var fill = new SolidBrush(Theme.InkDeep)) g.FillPath(fill, path);
                using (var pen = new Pen(edge)) g.DrawPath(pen, path);
            }
            g.SmoothingMode = SmoothingMode.None;
        }
    }

    // Checkbox: rounded box that fills with the accent and draws a tick. Space toggles, accent ring on focus.
    internal sealed class Toggle : Control
    {
        public event EventHandler CheckedChanged;
        private bool _checked;
        private readonly Smooth _mark;

        public Toggle(string text, bool isChecked)
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                     ControlStyles.SupportsTransparentBackColor | ControlStyles.Selectable, true);
            _checked = isChecked;
            _mark = new Smooth(this, isChecked ? 1f : 0f);
            Text = text;
            Font = Theme.FontBody;
            ForeColor = Theme.Bone;
            BackColor = Color.Transparent;
            Cursor = Cursors.Hand;
            TabStop = true;
            Height = 30;
            Width = TextRenderer.MeasureText(text, Font).Width + 34;
        }

        public bool IsChecked
        {
            get { return _checked; }
            set
            {
                if (_checked == value) return;
                _checked = value;
                _mark.To(value ? 1f : 0f);
                Invalidate();
            }
        }

        protected override void OnClick(EventArgs e)
        {
            _checked = !_checked;
            _mark.To(_checked ? 1f : 0f);
            Invalidate();
            EventHandler handler = CheckedChanged;
            if (handler != null) handler(this, EventArgs.Empty);
            base.OnClick(e);
        }

        protected override void OnMouseDown(MouseEventArgs e) { if (e.Button == MouseButtons.Left) Focus(); base.OnMouseDown(e); }
        protected override void OnTextChanged(EventArgs e) { Invalidate(); base.OnTextChanged(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

        protected override bool IsInputKey(Keys key)
        {
            return key == Keys.Space || base.IsInputKey(key);
        }

        protected override void OnKeyUp(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Space) OnClick(EventArgs.Empty);
            base.OnKeyUp(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle box = new Rectangle(0, (Height - 16) / 2, 16, 16);
            float m = _mark.Value;
            Color fill = Theme.Mix(Theme.InkDeep, Theme.Signal, m);
            Color edge = Theme.Mix(Theme.FieldEdge, Theme.Signal, m);
            using (GraphicsPath path = Theme.RoundRect(box, 5))
            {
                using (var brush = new SolidBrush(fill)) g.FillPath(brush, path);
                using (var pen = new Pen(edge)) g.DrawPath(pen, path);
            }
            if (m > 0.5f)
            {
                using (var tick = new Pen(Theme.Ink, 2f))
                    g.DrawLines(tick, new[] { new Point(box.X + 3, box.Y + 8), new Point(box.X + 7, box.Y + 12), new Point(box.X + 13, box.Y + 4) });
            }
            g.SmoothingMode = SmoothingMode.None;
            Rectangle label = new Rectangle(26, 0, Width - 26, Height);
            TextRenderer.DrawText(g, Text, Font, label, Theme.Bone,
                TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
            if (Focused) Focusable.DrawRing(g, new Rectangle(0, 0, Width, Height), 7);
        }
    }

    // Solid signal progress bar. No gradient.
    // Progress bar: a rounded track with an accent fill that glides to each new value.
    internal sealed class SignalBar : Control
    {
        private int _target;
        private readonly Smooth _shown;

        public SignalBar()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Ink;
            Height = 8;
            _shown = new Smooth(this, 0f);
        }

        public int Value
        {
            get { return _target; }
            set
            {
                _target = Math.Max(0, Math.Min(100, value));
                _shown.To(_target / 100f);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle track = new Rectangle(0, 0, Width - 1, Height - 1);
            using (GraphicsPath path = Theme.RoundRect(track, 4))
            using (var brush = new SolidBrush(Theme.InkLine))
            {
                g.FillPath(brush, path);
            }
            int w = (int)Math.Round(Width * _shown.Value);
            if (w > 2)
            {
                Rectangle fill = new Rectangle(0, 0, Math.Min(w, Width) - 1, Height - 1);
                using (GraphicsPath path = Theme.RoundRect(fill, 4))
                using (var brush = new SolidBrush(Theme.Signal))
                {
                    g.FillPath(brush, path);
                }
            }
            g.SmoothingMode = SmoothingMode.None;
        }
    }

    // Segmented step indicator: completed and current segments in signal, the rest hairline.
    internal sealed class SegmentBar : Control
    {
        private int _total = 1;
        private int _current;

        public SegmentBar()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Ink;
            Height = 4;
        }

        public void SetProgress(int current, int total)
        {
            _total = Math.Max(1, total);
            _current = Math.Max(0, Math.Min(_total - 1, current));
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            const int gap = 6;
            int seg = (Width - gap * (_total - 1)) / _total;
            for (int i = 0; i < _total; i++)
            {
                Color color = i <= _current ? Theme.Signal : Theme.InkLine;
                using (var brush = new SolidBrush(color))
                    g.FillRectangle(brush, i * (seg + gap), 0, seg, Height);
            }
        }
    }

    // Header: the app mark and kicker, the step counter, title and subtitle, and a round close control on the
    // right margin, centred on the kicker line. The header drags the window, except over the close control.
    internal sealed class HeaderPanel : Panel
    {
        public event EventHandler CloseClicked;
        private string _kicker = "";
        private string _counter = "";
        private string _title = "";
        private string _subtitle = "";
        private readonly Smooth _closeHover;

        public HeaderPanel()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            Height = 132;
            BackColor = Theme.Ink;
            _closeHover = new Smooth(this, 0f);
        }

        public Bitmap Mark { get; set; }
        public string Kicker { get { return _kicker; } set { _kicker = value ?? ""; Invalidate(); } }
        public string Counter { get { return _counter; } set { _counter = value ?? ""; Invalidate(); } }
        public string Title { get { return _title; } set { _title = value ?? ""; Invalidate(); } }
        public string Subtitle { get { return _subtitle; } set { _subtitle = value ?? ""; Invalidate(); } }

        // The close control: 30 px square, its right edge on the right margin, its centre on the kicker's centre (y 25).
        private Rectangle CloseBounds()
        {
            return new Rectangle(Width - Theme.Margin - 30, 10, 30, 30);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            int m = Theme.Margin;
            if (Mark != null)
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.DrawImage(Mark, new Rectangle(m, 13, 22, 22));
            }
            int kickX = m + (Mark != null ? 30 : 0);
            TextRenderer.DrawText(g, _kicker, Theme.FontMonoSmall, new Rectangle(kickX, 16, 400, 18), Theme.BoneDim,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);

            Rectangle close = CloseBounds();
            TextRenderer.DrawText(g, _counter, Theme.FontMonoSmall, new Rectangle(close.Left - 12 - 260, 16, 260, 18), Theme.BoneDim,
                TextFormatFlags.Right | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
            PaintClose(g, close);

            TextRenderer.DrawText(g, _title, Theme.FontDisplay, new Rectangle(m, 44, Width - 2 * m, 34), Theme.Bone,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
            TextRenderer.DrawText(g, _subtitle, Theme.FontBody, new Rectangle(m, 80, Width - 2 * m, 20), Theme.BoneDim,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);

            using (var rule = new Pen(Theme.Rule)) g.DrawLine(rule, 0, Height - 1, Width, Height - 1);
        }

        // Quiet until the pointer is over it: a hairline ring fades in, the cross brightens. The cross is two
        // round-capped strokes, so it is exactly centred in the box.
        private void PaintClose(Graphics g, Rectangle r)
        {
            float h = _closeHover.Value;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle box = new Rectangle(r.X, r.Y, r.Width - 1, r.Height - 1);
            using (GraphicsPath path = Theme.RoundRect(box, Theme.Radius))
            {
                using (var fill = new SolidBrush(Theme.Mix(Theme.Ink, Theme.InkDeep, h))) g.FillPath(fill, path);
                using (var ring = new Pen(Theme.Mix(Theme.Ink, Theme.FieldEdge, h))) g.DrawPath(ring, path);
            }
            using (var cross = new Pen(Theme.Mix(Theme.BoneDim, Theme.Bone, h), 1.6f))
            {
                cross.StartCap = LineCap.Round;
                cross.EndCap = LineCap.Round;
                const int inset = 10;
                g.DrawLine(cross, r.X + inset, r.Y + inset, r.Right - inset, r.Bottom - inset);
                g.DrawLine(cross, r.Right - inset, r.Y + inset, r.X + inset, r.Bottom - inset);
            }
            g.SmoothingMode = SmoothingMode.None;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            bool over = CloseBounds().Contains(e.Location);
            _closeHover.To(over ? 1f : 0f);
            Cursor = over ? Cursors.Hand : Cursors.Default;
            base.OnMouseMove(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            _closeHover.To(0f);
            Cursor = Cursors.Default;
            base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left || CloseBounds().Contains(e.Location)) return;
            Form form = FindForm();
            if (form == null) return;
            NativeMethods.ReleaseCapture();
            NativeMethods.SendMessage(form.Handle, NativeMethods.WM_NCLBUTTONDOWN, (IntPtr)NativeMethods.HTCAPTION, IntPtr.Zero);
        }

        protected override void OnMouseClick(MouseEventArgs e)
        {
            if (CloseBounds().Contains(e.Location))
            {
                EventHandler handler = CloseClicked;
                if (handler != null) handler(this, EventArgs.Empty);
            }
            base.OnMouseClick(e);
        }
    }

    // Base for every page in the body. Left-aligned column, 40 px margins, text first.
    internal abstract class WizardPage : Panel
    {
        protected readonly FlowLayoutPanel Flow = new FlowLayoutPanel();

        protected WizardPage()
        {
            Dock = DockStyle.Fill;
            BackColor = Theme.Ink;
            Theme.Buffer(this);
            Flow.Dock = DockStyle.Fill;
            Theme.Buffer(Flow);
            Flow.FlowDirection = FlowDirection.TopDown;
            Flow.WrapContents = false;
            Flow.BackColor = Theme.Ink;
            Flow.Padding = new Padding(Theme.Margin, 22, Theme.Margin, 8);
            Controls.Add(Flow);
        }

        protected void Add(Control control) { Flow.Controls.Add(control); }


        // Mono caption in uppercase: the website's section style. Brighter than before for AA contrast.
        protected Label Caption(string text)
        {
            Label label = Theme.Lbl(text.ToUpperInvariant(), Theme.FontMono, Theme.BoneDim, Theme.ContentWidth);
            label.Margin = new Padding(0, 18, 0, 6);
            return label;
        }

        protected Label Para(string text)
        {
            Label label = Theme.Lbl(text, Theme.FontBody, Theme.Text2, Theme.ContentWidth);
            label.Margin = new Padding(0, 0, 0, 8);
            return label;
        }

        // Numbered row: mono number in signal, then the step text.
        protected static FlowLayoutPanel NumberedRow(string number, string text)
        {
            FlowLayoutPanel row = Theme.Row();
            row.Margin = new Padding(0, 6, 0, 0);
            Label n = Theme.Lbl(number, Theme.FontMono, Theme.Signal, 0);
            n.Margin = new Padding(0, 4, 14, 0);
            Label t = Theme.Lbl(text, Theme.FontBody, Theme.Bone, Theme.ContentWidth - 40);
            row.Controls.Add(n);
            row.Controls.Add(t);
            return row;
        }

        public virtual string Validate() { return null; }   // null = fine, otherwise the message to show
        public virtual void OnShow() { }
    }

    internal sealed class WelcomePage : WizardPage
    {
        public WelcomePage(long requiredBytes)
        {
            Add(Para("Fishingbot runs on this PC. The game, database and chat bot stay local. Only public channel updates pass through a secure relay to the Twitch Extension."));
            Add(Para("Upgrading? Setup finds your existing folder and updates it in place. Settings, the database and the Twitch login are backed up before anything changes."));
            Add(Caption("Three steps"));
            Add(NumberedRow("01", "Choose the install folder"));
            Add(NumberedRow("02", "Connect Twitch with a one-time code"));
            Add(NumberedRow("03", "Activate the Extension on your channel"));
            Add(Caption(Loc.T("Windows user install  \u00B7  no admin rights  \u00B7  about ") + (requiredBytes / 1048576L) + " MB"));
        }
    }

    internal sealed class LocationPage : WizardPage
    {
        private readonly InstallOptions _o;
        private readonly FieldBox _dir;
        private readonly Label _space;
        private readonly Label _existing;

        public LocationPage(InstallOptions o)
        {
            _o = o;
            Add(Caption("Install folder"));
            FlowLayoutPanel row = Theme.Row();
            _dir = new FieldBox(480, false);
            _dir.AccessibleLabel = "Install folder";
            _dir.Text = o.InstallDir;
            _dir.Input.TextChanged += (s, e) => UpdateSpace();
            row.Controls.Add(_dir);
            RoundButton browse = new RoundButton("BROWSE", false, 128);
            browse.Margin = new Padding(12, 0, 0, 0);
            browse.Click += (s, e) =>
            {
                using (var dialog = new FolderBrowserDialog())
                {
                    dialog.Description = "Choose the folder for Fishingbot";
                    dialog.ShowNewFolderButton = true;
                    if (dialog.ShowDialog(FindForm()) == DialogResult.OK)
                        _dir.Text = Path.Combine(dialog.SelectedPath, Product.Name);
                }
            };
            row.Controls.Add(browse);
            Add(row);

            _space = Theme.Lbl("", Theme.FontMonoSmall, Theme.BoneDim, Theme.ContentWidth);
            _space.Margin = new Padding(0, 14, 0, 0);
            _existing = Theme.Lbl("", Theme.FontBody, Theme.Warn, Theme.ContentWidth);
            _existing.Margin = new Padding(0, 10, 0, 0);
            Add(_space);
            Add(_existing);
            UpdateSpace();
        }

        private void UpdateSpace()
        {
            string full;
            try { full = Path.GetFullPath(_dir.Text.Trim()); }
            catch (Exception)
            {
                _space.Text = "Enter a valid folder path.";
                _space.ForeColor = Theme.Danger;
                _existing.Text = "";
                return;
            }
            DriveInfo drive = new DriveInfo(Path.GetPathRoot(full));
            long free = drive.AvailableFreeSpace;
            bool enough = free >= Engine.RequiredBytes;
            _space.ForeColor = enough ? Theme.BoneDim : Theme.Danger;
            _space.Text = Loc.T("Needs about ") + (Engine.RequiredBytes / 1048576L) + Loc.T(" MB  \u00B7  free on ") + drive.Name + " " +
                          (free / 1048576L) + " MB";
            _existing.Text = Engine.ExistingInstallDescription(full);
        }

        public override string Validate()
        {
            string full;
            try { full = Path.GetFullPath(_dir.Text.Trim()); }
            catch (Exception) { return "Enter a valid folder path."; }
            DriveInfo drive = new DriveInfo(Path.GetPathRoot(full));
            if (drive.AvailableFreeSpace < Engine.RequiredBytes)
                return Loc.T("There is not enough free space on ") + drive.Name + ".";
            if (Directory.Exists(full) && !Engine.IsExistingInstall(full) && Directory.GetFileSystemEntries(full).Length > 0)
                return "This folder is not a recognized Fishingbot installation and is not empty. Choose an empty folder so existing files cannot be overwritten.";
            _o.InstallDir = full;
            return null;
        }
    }

    // Connection setup: the official build embeds its public Twitch Client ID and uses
    // Device Code sign-in. Streamers do not create a developer app.
    internal sealed class TwitchCreatePage : WizardPage
    {
        private readonly InstallOptions _o;
        private readonly FieldBox _port;
        private bool _prefilled;

        public TwitchCreatePage(InstallOptions o)
        {
            _o = o;
            Add(Caption("Twitch connection"));
            Add(Para("This build includes Fishingbot's public Twitch application ID. After setup, press Connect account in the Control Centre and approve the one-time code Twitch shows you. No developer console or Extension secret is needed."));

            Add(Caption("Local server port"));
            _port = new FieldBox(180, false);
            _port.AccessibleLabel = "Local server port";
            _port.Text = o.Port.ToString();
            Add(_port);
            Add(Para("The server stays on this computer. Its connection to the relay is outbound HTTPS, so no router port needs to be opened."));
        }

        public override void OnShow()
        {
            if (_prefilled) return;
            _prefilled = true;
            Dictionary<string, string> existing = Engine.ReadSettings(_o.InstallDir);
            string value;
            int port;
            if (existing.TryGetValue("PORT", out value) && int.TryParse(value, out port) && port >= 1024 && port <= 65535)
                _port.Text = port.ToString();
        }

        public override string Validate()
        {
            int port;
            if (!int.TryParse(_port.Text.Trim(), out port) || port < 1024 || port > 65535)
                return "Enter a port between 1024 and 65535. The default is 3000.";
            if (!PortFree(port) &&
                StyledPrompt.Show(FindForm(), Loc.T("Port ") + port + Loc.T(" is already in use. If Fishingbot is already running, that is expected. Continue anyway?"),
                                  Product.Name + " Setup", true, "CONTINUE", "CHOOSE PORT") != DialogResult.Yes)
            {
                return Loc.T("Choose another port, or close the program that uses port ") + port + ".";
            }
            _o.Port = port;
            _o.ClientId = Product.TwitchClientId;
            return null;
        }

        internal static bool PortFree(int port)
        {
            try
            {
                var listener = new TcpListener(IPAddress.Loopback, port);
                listener.Start();
                listener.Stop();
                return true;
            }
            catch (SocketException)
            {
                return false;
            }
        }
    }

    internal sealed class OptionsPage : WizardPage
    {
        private readonly InstallOptions _o;
        private readonly Label _folder;
        private readonly Label _port;
        private readonly Label _client;

        public OptionsPage(InstallOptions o)
        {
            _o = o;
            Add(Caption("Shortcuts"));
            Toggle startMenu = new Toggle("Add Fishingbot to the Start Menu", o.StartMenu);
            startMenu.CheckedChanged += (s, e) => o.StartMenu = startMenu.IsChecked;
            startMenu.Margin = new Padding(0, 4, 0, 0);
            Add(startMenu);
            Toggle desktop = new Toggle("Create a desktop shortcut", o.DesktopShortcut);
            desktop.CheckedChanged += (s, e) => o.DesktopShortcut = desktop.IsChecked;
            desktop.Margin = new Padding(0, 4, 0, 0);
            Add(desktop);

            Add(Caption("Review"));
            _folder = Theme.Lbl("", Theme.FontBody, Theme.Bone, Theme.ContentWidth - 140);
            _port = Theme.Lbl("", Theme.FontBody, Theme.Bone, Theme.ContentWidth - 140);
            _client = Theme.Lbl("", Theme.FontBody, Theme.Bone, Theme.ContentWidth - 140);
            Add(ReviewRow("Folder", _folder));
            Add(ReviewRow("Port", _port));
            Add(ReviewRow("Twitch client", _client));
            Add(ReviewRow("Network", Theme.Lbl("Local only. Relay uses outbound HTTPS.", Theme.FontBody, Theme.Bone, 0)));
        }

        private static FlowLayoutPanel ReviewRow(string key, Label value)
        {
            FlowLayoutPanel row = Theme.Row();
            row.Margin = new Padding(0, 6, 0, 0);
            Label k = new Label();
            k.Text = key;
            k.Font = Theme.FontMonoSmall;
            k.ForeColor = Theme.BoneDim;
            k.BackColor = Color.Transparent;
            k.AutoSize = false;
            k.Width = 140;
            k.Height = 22;
            k.TextAlign = ContentAlignment.TopLeft;
            k.Margin = new Padding(0, 1, 0, 0);
            row.Controls.Add(k);
            row.Controls.Add(value);
            return row;
        }

        public override void OnShow()
        {
            _folder.Text = _o.InstallDir;
            _port.Text = _o.Port.ToString();
            _client.Text = Mask(_o.ClientId);
        }

        private static string Mask(string value)
        {
            if (string.IsNullOrEmpty(value)) return "Not set";
            return value.Length <= 4 ? "****" : value.Substring(0, 4) + new string('*', value.Length - 4);
        }
    }

    internal sealed class ProgressPage : WizardPage
    {
        private readonly Label _percent;
        private readonly SignalBar _bar;
        private readonly Label _status;

        public ProgressPage()
        {
            _percent = Theme.Lbl("0%", Theme.FontDisplay, Theme.Bone, 0);
            _percent.Margin = new Padding(0, 20, 0, 0);
            Add(_percent);
            _bar = new SignalBar();
            _bar.Width = Theme.ContentWidth;
            _bar.Margin = new Padding(0, 12, 0, 0);
            Add(_bar);
            _status = Theme.Lbl("Starting...", Theme.FontBody, Theme.Text2, Theme.ContentWidth);
            _status.Margin = new Padding(0, 14, 0, 0);
            Add(_status);
        }

        public void SetProgress(int percent, string message)
        {
            _percent.Text = percent + "%";
            _bar.Value = percent;
            _status.ForeColor = Theme.Text2;
            _status.Text = Loc.T(message ?? "");
        }

        public void SetFailed(string message)
        {
            _status.ForeColor = Theme.Danger;
            _status.Text = Loc.T(message ?? "");
        }
    }

    internal sealed class FinishPage : WizardPage
    {
        private readonly InstallOptions _o;
        private readonly Label _next;
        private readonly Label _backup;

        public FinishPage(InstallOptions o)
        {
            _o = o;
            Add(Theme.Lbl("Installed. Your data is kept.", Theme.FontHeading, Theme.Ok, Theme.ContentWidth));
            Add(Caption("Next"));
            Add(NumberedRow("01", "Press Connect account in the Control Centre"));
            Add(NumberedRow("02", "Approve Fishingbot with the one-time Twitch code"));
            Add(NumberedRow("03", "Type !fish in your chat"));
            _next = Theme.Lbl("", Theme.FontMonoSmall, Theme.BoneDim, Theme.ContentWidth);
            _next.Margin = new Padding(0, 18, 0, 0);
            Add(_next);
            _backup = Theme.Lbl("", Theme.FontMonoSmall, Theme.BoneDim, Theme.ContentWidth);
            _backup.Margin = new Padding(0, 4, 0, 0);
            Add(_backup);
            Toggle launch = new Toggle("Start Fishingbot when I press Finish", o.LaunchAfter);
            launch.Margin = new Padding(0, 18, 0, 0);
            launch.CheckedChanged += (s, e) => o.LaunchAfter = launch.IsChecked;
            Add(launch);
        }

        public override void OnShow()
        {
            _next.Text = Loc.T("Control Centre") + "  http://localhost:" + _o.Port + "/local";
            _backup.Text = String.IsNullOrWhiteSpace(_o.BackupPath) ? "" : Loc.T("Pre-update backup  ") + _o.BackupPath;
        }
    }

    // Shown by the uninstaller: a short message.
    internal sealed class MessagePage : WizardPage
    {
        private readonly Label _text;

        public MessagePage()
        {
            _text = Para("");
            _text.Margin = new Padding(0, 16, 0, 0);
            Add(_text);
        }

        public void SetText(string text) { _text.Text = text ?? ""; }
    }

    // Uninstaller step 1: folder and the "delete my data" choice.
    internal sealed class UninstallConfirmPage : WizardPage
    {
        private readonly Toggle _deleteData;

        public UninstallConfirmPage(string dir)
        {
            Add(Caption("Folder"));
            Add(Theme.Lbl(dir, Theme.FontMonoSmall, Theme.Bone, Theme.ContentWidth));
            Add(Caption("What gets removed"));
            Add(Para("Program files, shortcuts and the Windows uninstall entry."));
            _deleteData = new Toggle("Also delete my data and recovery backups", false);
            _deleteData.Margin = new Padding(0, 12, 0, 0);
            Add(_deleteData);
            Add(Para("Keep your data if you may reinstall later. Deleting also removes the pre-update recovery archives and the stored Twitch bot token."));
        }

        public bool DeleteData { get { return _deleteData.IsChecked; } }
    }

    // ----------------------------------------------------------------------------------
    // Shell: borderless window with header, body, notice line and footer buttons.
    // Keyboard: Enter runs the primary action, Escape cancels, Tab moves between controls.
    // ----------------------------------------------------------------------------------
    // Styled replacement for the wizard's MessageBox prompts: same chrome as the wizard.
    // Enter runs the primary action, Escape runs the secondary action.
    internal sealed class StyledPrompt : Form
    {
        private readonly RoundButton _primary;
        private readonly RoundButton _secondary;

        private StyledPrompt(string title, string text, bool warning, string primary, string secondary)
        {
            Text = title;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.CenterParent;
            BackColor = Theme.Ink;
            ForeColor = Theme.Bone;
            Font = Theme.FontBody;

            var titleBar = new Panel { Dock = DockStyle.Top, Height = 48, BackColor = Theme.InkDeep };
            var heading = new Label { Text = title.ToUpperInvariant(), AutoSize = true, Font = Theme.FontMono,
                                      ForeColor = warning ? Theme.Warn : Theme.BoneDim, BackColor = Color.Transparent,
                                      Location = new Point(24, 16) };
            titleBar.Controls.Add(heading);
            titleBar.MouseDown += DragWindow;
            heading.MouseDown += DragWindow;
            titleBar.Paint += (s, e) => { using (var pen = new Pen(Theme.Rule)) e.Graphics.DrawLine(pen, 0, titleBar.Height - 1, titleBar.Width, titleBar.Height - 1); };
            Controls.Add(titleBar);

            var message = new Label { Text = text, AutoSize = true, MaximumSize = new Size(472, 0), Font = Theme.FontBody,
                                      ForeColor = Theme.Text2, BackColor = Color.Transparent, Location = new Point(24, 70) };
            Controls.Add(message);

            int footerTop = message.Location.Y + message.PreferredSize.Height + 28;
            ClientSize = new Size(520, footerTop + 42 + 24);

            _primary = new RoundButton(primary, true, 196);
            _primary.Location = new Point(ClientSize.Width - 24 - _primary.Width, footerTop);
            _primary.Click += (s, e) => DialogResult = DialogResult.Yes;
            Controls.Add(_primary);

            _secondary = new RoundButton(secondary, false, 160);
            _secondary.Location = new Point(_primary.Left - 12 - _secondary.Width, footerTop);
            _secondary.Click += (s, e) => DialogResult = DialogResult.No;
            Controls.Add(_secondary);
        }

        public static DialogResult Show(IWin32Window owner, string text, string title, bool warning, string primary, string secondary)
        {
            using (var box = new StyledPrompt(title, text, warning, primary, secondary))
                { Loc.Apply(box); return box.ShowDialog(owner); }
        }

        private void DragWindow(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            NativeMethods.ReleaseCapture();
            NativeMethods.SendMessage(Handle, NativeMethods.WM_NCLBUTTONDOWN, new IntPtr(NativeMethods.HTCAPTION), IntPtr.Zero);
        }

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (keyData == Keys.Escape) { DialogResult = DialogResult.No; return true; }
            if (keyData == Keys.Enter) { DialogResult = DialogResult.Yes; return true; }
            return base.ProcessCmdKey(ref msg, keyData);
        }
    }

    internal abstract class ModalShell : Form
    {
        protected readonly HeaderPanel Header = new HeaderPanel();
        protected readonly Panel Body = new Panel();
        protected readonly Label Notice = new Label();
        protected readonly Panel Footer = new Panel();
        protected readonly RoundButton CancelActionButton;
        protected readonly RoundButton BackButton;
        protected readonly RoundButton NextButton;
        private int _segments = 1;
        private Smooth _footerProgress;
        private Timer _fade;

        protected ModalShell(string title)
        {
            // The same icon as Fishingbot.exe, from the embedded resource (build-setup.bat).
            try
            {
                using (Stream icon = Assembly.GetExecutingAssembly().GetManifestResourceStream("AppIcon.ico"))
                    if (icon != null) Icon = new System.Drawing.Icon(icon);
            }
            catch (Exception) { /* the default icon stays */ }
            // The app mark is the desktop's PNG logo (embedded by build-setup.bat). The multi-size icon is not used
            // here: converting it to a bitmap garbles the small sizes.
            try
            {
                using (Stream mark = Assembly.GetExecutingAssembly().GetManifestResourceStream("AppMark.png"))
                {
                    if (mark != null)
                    {
                        // GDI+ needs the bytes to stay alive for as long as the bitmap, so they are kept in memory.
                        byte[] bytes = new byte[mark.Length];
                        mark.Read(bytes, 0, bytes.Length);
                        Header.Mark = new Bitmap(new MemoryStream(bytes));
                    }
                }
            }
            catch (Exception) { /* the header shows no mark */ }
            Text = title;
            ClientSize = new Size(720, 620);
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Theme.Ink;
            Font = Theme.FontBody;
            KeyPreview = false;
            Opacity = 0.0;   // fades in once shown (see StartFadeIn)

            Header.Dock = DockStyle.Top;
            Theme.Buffer(Header);
            Header.CloseClicked += (s, e) => OnCancel();

            Body.Dock = DockStyle.Fill;
            Body.BackColor = Theme.Ink;
            Theme.Buffer(Body);

            // AutoSize + bottom dock: the notice grows to fit long error messages instead of clipping them.
            Notice.Dock = DockStyle.Bottom;
            Notice.AutoSize = true;
            Notice.MaximumSize = new Size(720, 0);
            Notice.BackColor = Theme.InkDeep;
            Notice.ForeColor = Theme.Danger;
            Notice.Font = Theme.FontBody;
            Notice.Padding = new Padding(Theme.Margin, 10, Theme.Margin, 10);
            Notice.Visible = false;

            Theme.Buffer(Footer);
            Footer.Dock = DockStyle.Bottom;
            Footer.Height = 72;
            Footer.BackColor = Theme.InkPanel;
            CancelActionButton = new RoundButton("CANCEL", false, 128);
            BackButton = new RoundButton("BACK", false, 128);
            NextButton = new RoundButton("NEXT", true, 196);
            _footerProgress = new Smooth(Footer, 0f);
            Footer.Controls.Add(CancelActionButton);
            Footer.Controls.Add(BackButton);
            Footer.Controls.Add(NextButton);
            Footer.Paint += (s, e) => PaintFooter(e.Graphics);
            Footer.Resize += (s, e) => LayoutFooter();
            CancelActionButton.Click += (s, e) => OnCancel();
            BackButton.Click += (s, e) => OnBack();
            NextButton.Click += (s, e) => OnNext();

            // Docking order: the fill control first, then the bottom strips, then the header.
            Controls.Add(Body);
            Controls.Add(Notice);
            Controls.Add(Footer);
            Controls.Add(Header);
            LayoutFooter();
        }

        protected abstract void OnNext();
        protected abstract void OnBack();
        protected abstract void OnCancel();

        // The next window after the language step is shown as the dialog closes. Windows gives focus back to
        // the window that was behind it, so the new window could come up behind every other window. Bring it
        // forward when it first shows: a topmost flip raises it over them, and Activate takes focus.
        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            StartFadeIn();
            TopMost = true;
            TopMost = false;
            BringToFront();
            Activate();
        }

        protected void SetSegments(int count) { _segments = Math.Max(1, count); }

        // The window fades in over a fraction of a second. Opacity starts at 0 in the constructor.
        private void StartFadeIn()
        {
            if (_fade != null) return;
            _fade = new Timer();
            _fade.Interval = 12;
            _fade.Tick += delegate
            {
                Opacity = Math.Min(1.0, Opacity + 0.12);
                if (Opacity >= 1.0) _fade.Stop();
            };
            _fade.Start();
        }

        // The window has rounded corners, as the desktop app's window does.
        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (Width > 0 && Height > 0 && WindowState == FormWindowState.Normal)
            {
                using (GraphicsPath path = Theme.RoundRect(new Rectangle(0, 0, Width, Height), Theme.WindowRadius))
                    Region = new Region(path);
            }
        }

        // segmentIndex: which segment is current (0-based). counter: the text shown top right.
        protected void ShowPage(WizardPage page, string title, string subtitle, int segmentIndex, string counter)
        {
            title = Loc.T(title);
            subtitle = Loc.T(subtitle);
            counter = Loc.T(counter);
            Body.Controls.Clear();
            Body.Controls.Add(page);
            Loc.Apply(page);
            Header.Title = title;
            Header.Subtitle = subtitle;
            Header.Counter = counter;
            Header.Kicker = Product.Name.ToUpperInvariant() + "  \u00B7  " + Loc.T("SETUP");
            Footer.Invalidate();
            page.OnShow();
            SetSegmentProgress(segmentIndex);
        }

        private int _segmentIndex;
        private void SetSegmentProgress(int index)
        {
            _segmentIndex = index;
            _footerProgress.To(index);
            Footer.Invalidate();
        }

        protected void SetButtons(string next, bool nextEnabled, bool backVisible, bool backEnabled, bool cancelEnabled)
        {
            next = Loc.T(next);
            NextButton.Text = next;
            NextButton.Enabled = nextEnabled;
            BackButton.Visible = backVisible;
            BackButton.Enabled = backEnabled;
            CancelActionButton.Enabled = cancelEnabled;
        }

        protected void Error(string text)
        {
            Notice.Text = text ?? "";
            Notice.Visible = !string.IsNullOrEmpty(text);
        }

        private void LayoutFooter()
        {
            int y = (Footer.Height - NextButton.Height) / 2 + 6;
            NextButton.Location = new Point(Footer.Width - Theme.Margin - NextButton.Width, y);
            BackButton.Location = new Point(NextButton.Left - 12 - BackButton.Width, y);
            CancelActionButton.Location = new Point(Theme.Margin, y);
        }

        // Footer: hairline on top, then the segmented progress across the full width. The current segment fills
        // smoothly from the one before it.
        private void PaintFooter(Graphics g)
        {
            using (var line = new Pen(Theme.Rule)) g.DrawLine(line, 0, 0, Footer.Width, 0);
            int total = _segments;
            const int gap = 6;
            int left = Theme.Margin;
            int width = Footer.Width - 2 * Theme.Margin;
            int seg = (width - gap * (total - 1)) / total;
            for (int i = 0; i < total; i++)
            {
                float share = Math.Max(0f, Math.Min(1f, _footerProgress.Value - i + 1f));
                int x = left + i * (seg + gap);
                using (var track = new SolidBrush(Theme.InkLine)) g.FillRectangle(track, x, 0, seg, 3);
                int fillW = (int)Math.Round(seg * share);
                if (fillW > 0)
                {
                    using (var brush = new SolidBrush(Theme.Signal)) g.FillRectangle(brush, x, 0, fillW, 3);
                }
            }
        }

        // Enter = primary action, Escape = cancel. Enter on a focused button activates that button instead.
        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (keyData == Keys.Escape)
            {
                OnCancel();
                return true;
            }
            if (keyData == Keys.Enter && NextButton.Enabled && !(ActiveControl is RoundButton))
            {
                OnNext();
                return true;
            }
            return base.ProcessCmdKey(ref msg, keyData);
        }
    }

    internal sealed class InstallWizard : ModalShell
    {
        private const int PageWelcome = 0, PageLocation = 1, PageTwitchCreate = 2,
                          PageOptions = 3, PageProgress = 4, PageFinish = 5;
        private bool _launchRequested;

        private static readonly string[] Titles =
        {
            "Set up Fishingbot", "Choose a folder", "Connect Twitch",
            "Shortcuts and review", "Installing", "Installed"
        };
        private static readonly string[] Subtitles =
        {
            "About five minutes. No admin rights needed.",
            "Program files go in this folder.",
            "The Twitch sign-in is built in. You approve it once.",
            "Choose what setup adds, then install.",
            "Keep this window open. This takes less than a minute.",
            "Fishingbot is ready on this computer."
        };
        // Which of the five progress segments is current for each page.
        private static readonly int[] Segment = { 0, 1, 2, 3, 4, 4 };

        private readonly InstallOptions _o = new InstallOptions();
        private readonly List<WizardPage> _pages = new List<WizardPage>();
        private readonly ProgressPage _progress;
        private int _current;
        private bool _installing;
        private bool _failed;
        private BackgroundWorker _worker;

        public InstallWizard() : base("Fishingbot Setup")
        {
            _o.Language = Loc.Language;
            SetSegments(5);
            _pages.Add(new WelcomePage(Engine.RequiredBytes));
            _pages.Add(new LocationPage(_o));
            _pages.Add(new TwitchCreatePage(_o));
            _pages.Add(new OptionsPage(_o));
            _progress = new ProgressPage();
            _pages.Add(_progress);
            _pages.Add(new FinishPage(_o));
            ShowCurrent(PageWelcome);
            Loc.Apply(this);
        }

        private void ShowCurrent(int index)
        {
            _current = index;
            string counter = Loc.T("STEP") + " " + (Math.Min(index, PageProgress) + 1).ToString("00") + " " + Loc.T("OF") + " 05";
            if (index == PageFinish) counter = Loc.T("DONE");
            ShowPage(_pages[index], Titles[index], Subtitles[index], Segment[index], counter);
            RefreshButtons();
        }

        private void RefreshButtons()
        {
            if (_installing) { SetButtons("INSTALLING", false, false, false, false); return; }
            if (_failed) { SetButtons("CLOSE", true, true, true, true); return; }
            string next = "NEXT";
            if (_current == PageWelcome) next = "GET STARTED";
            else if (_current == PageOptions) next = "INSTALL";
            else if (_current == PageFinish) next = "FINISH";
            bool back = _current >= PageLocation && _current <= PageOptions;
            SetButtons(next, true, back, back, true);
        }

        protected override void OnNext()
        {
            if (_installing) return;
            if (_failed) { Close(); return; }
            if (_current == PageFinish)
            {
                // The app starts after the wizard has closed (see StartIfRequested), and only when Finish was pressed.
                _launchRequested = _o.LaunchAfter;
                Close();
                return;
            }
            string problem = _pages[_current].Validate();
            if (problem != null) { Error(problem); return; }
            Error(null);
            if (_current == PageOptions) { StartInstall(); return; }
            ShowCurrent(_current + 1);
        }

        protected override void OnBack()
        {
            if (_installing) return;
            Error(null);
            if (_failed) { _failed = false; ShowCurrent(PageOptions); return; }
            if (_current >= PageLocation && _current <= PageOptions) ShowCurrent(_current - 1);
        }

        protected override void OnCancel()
        {
            if (_installing) return;
            if (_current == PageFinish) { Close(); return; }
            if (StyledPrompt.Show(this, "Cancel setup? Nothing has been installed yet.", Product.Name + " Setup",
                                  false, "CANCEL SETUP", "KEEP GOING") == DialogResult.Yes)
            {
                Close();
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (_installing) e.Cancel = true;
            base.OnFormClosing(e);
        }

        private void StartInstall()
        {
            _installing = true;
            _failed = false;
            Error(null);
            ShowCurrent(PageProgress);
            _progress.SetProgress(0, "Starting...");
            _worker = new BackgroundWorker();
            _worker.WorkerReportsProgress = true;
            _worker.DoWork += (s, e) => Engine.Install(_o, (pct, msg) => _worker.ReportProgress(pct, msg));
            _worker.ProgressChanged += (s, e) => _progress.SetProgress(e.ProgressPercentage, e.UserState as string);
            _worker.RunWorkerCompleted += (s, e) =>
            {
                _installing = false;
                if (e.Error != null)
                {
                    _failed = true;
                    Product.Log("Install failed: " + e.Error);
                    _progress.SetFailed("Setup could not finish.");
                    Error(Loc.T("Setup could not finish: ") + e.Error.Message + Loc.T("   Details: ") + Product.LogPath);
                    RefreshButtons();
                    return;
                }
                ShowCurrent(PageFinish);
            };
            _worker.RunWorkerAsync();
        }

        private void LaunchFishingbot()
        {
            string exe = Path.Combine(_o.InstallDir, Product.ExeName);
            if (!File.Exists(exe)) return;
            Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = _o.InstallDir, UseShellExecute = true });
        }

        // Called by Main after the wizard has closed. Cancelling on the Finish page does not start the app.
        public void StartIfRequested()
        {
            if (!_launchRequested) return;
            try { LaunchFishingbot(); }
            catch (Exception ex) { Product.Log("Could not start Fishingbot after setup: " + ex); }
        }
    }

    // The language step: one button per language. Picking one applies it to the whole wizard at once.
    internal sealed class LanguagePage : WizardPage
    {
        private static readonly string[] Codes = { "en", "de", "es", "fr", "zh" };
        private static readonly string[] Names = { "English", "Deutsch", "Español", "Français", "中文（简体）" };
        private readonly RoundButton[] _choices = new RoundButton[5];
        private readonly Action _picked;

        public LanguagePage(string initial, Action picked)
        {
            _picked = picked;
            for (int i = 0; i < Codes.Length; i++)
            {
                int index = i;
                _choices[i] = new RoundButton(Names[i], false, Theme.ContentWidth);
                _choices[i].Margin = new Padding(0, 6, 0, 0);
                _choices[i].Click += (s, e) => Pick(index, true);
                Add(_choices[i]);
            }
            string start = Array.IndexOf(Codes, initial) >= 0 ? initial : "en";
            Loc.SetLanguage(start);
            Mark(start);
        }

        private void Pick(int index, bool notify)
        {
            Loc.SetLanguage(Codes[index]);
            Mark(Codes[index]);
            if (notify && _picked != null) _picked();
        }

        // The selected language carries a dot; the names themselves stay in their own language.
        private void Mark(string code)
        {
            for (int i = 0; i < Codes.Length; i++)
            {
                _choices[i].Text = Names[i];
                _choices[i].Selected = Codes[i] == code;
                _choices[i].Invalidate();
            }
        }
    }

    // Setup and the uninstaller start here: the language is picked first, then every screen follows it.
    internal sealed class LanguageGate : ModalShell
    {
        private readonly LanguagePage _page;

        public LanguageGate(string initial) : base(Product.Name + " Setup")
        {
            SetSegments(1);
            _page = new LanguagePage(initial, Redraw);
            Redraw();
        }

        private void Redraw()
        {
            ShowPage(_page, "Choose a language", "Used for setup and Fishingbot. You can change it later in the Control Centre.", 0, "LANGUAGE");
            SetButtons("NEXT", true, false, false, true);
            Loc.Apply(this);
        }

        protected override void OnNext() { DialogResult = DialogResult.OK; Close(); }
        protected override void OnBack() { }
        protected override void OnCancel() { DialogResult = DialogResult.Cancel; Close(); }
    }

    internal sealed class UninstallForm : ModalShell
    {
        private readonly string _dir;
        private readonly string _self;
        private readonly UninstallConfirmPage _confirm;
        private readonly ProgressPage _progress;
        private readonly MessagePage _done;
        private bool _working;
        private int _current;
        private BackgroundWorker _worker;

        public UninstallForm(string dir, string self) : base("Uninstall Fishingbot")
        {
            _dir = dir;
            _self = self;
            SetSegments(3);
            _confirm = new UninstallConfirmPage(dir);
            _progress = new ProgressPage();
            _done = new MessagePage();
            ShowCurrent(0);
            Loc.Apply(this);
        }

        private void ShowCurrent(int index)
        {
            _current = index;
            WizardPage page = index == 0 ? (WizardPage)_confirm : (index == 1 ? (WizardPage)_progress : _done);
            string[] titles = { "Uninstall Fishingbot", "Removing", "Removed" };
            string[] subtitles = { "Removes the program from this computer.", "Please wait.", "Fishingbot was removed." };
            string[] counters = { Loc.T("STEP") + " 01 " + Loc.T("OF") + " 03", Loc.T("STEP") + " 02 " + Loc.T("OF") + " 03", Loc.T("DONE") };
            ShowPage(page, titles[index], subtitles[index], index, counters[index]);
            RefreshButtons();
        }

        private void RefreshButtons()
        {
            if (_working) SetButtons("REMOVING", false, false, false, false);
            else if (_current == 0) SetButtons("UNINSTALL", true, false, false, true);
            else SetButtons("CLOSE", true, false, false, false);
        }

        protected override void OnNext()
        {
            if (_working) return;
            if (_current == 0) StartUninstall();
            else Close();
        }

        protected override void OnBack() { }

        protected override void OnCancel()
        {
            if (!_working) Close();
        }

        private void StartUninstall()
        {
            bool deleteData = _confirm.DeleteData;
            _working = true;
            ShowCurrent(1);
            _worker = new BackgroundWorker();
            _worker.WorkerReportsProgress = true;
            _worker.DoWork += (s, e) => Engine.Uninstall(_dir, deleteData, (pct, msg) => _worker.ReportProgress(pct, msg));
            _worker.ProgressChanged += (s, e) => _progress.SetProgress(e.ProgressPercentage, e.UserState as string);
            _worker.RunWorkerCompleted += (s, e) =>
            {
                _working = false;
                if (e.Error != null)
                {
                    Product.Log("Uninstall failed: " + e.Error);
                    _done.SetText("Uninstall was incomplete. The Windows uninstall entry was kept so you can retry after closing any process that is using Fishingbot files. Details: " + Product.LogPath);
                    Error("Could not remove everything: " + e.Error.Message + "   Details: " + Product.LogPath);
                }
                else
                {
                    _done.SetText(deleteData
                        ? Product.Name + " and its data were removed."
                        : Product.Name + " was removed. Your .env, database, logs and backups were kept in: " + _dir);
                }
                ShowCurrent(2);
            };
            _worker.RunWorkerAsync();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (_worker != null && _worker.IsBusy) e.Cancel = true;
            base.OnFormClosing(e);
        }

    }
}
