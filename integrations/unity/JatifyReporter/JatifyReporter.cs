// Jatify Reporter: sends a user report from a game build to a Questlog workspace.
// Step 1: POST <server>/user-report/v1/create-report (token in the X-Report-Token header) with the text, severity,
// file names and email.
// Step 2: PUT each file's raw bytes to the one-time upload URL the server answered with (valid 15 minutes).
// Unity 2021.3 or newer. Compile-checked against Unity 6 assemblies only; never run in Unity yet: see README.md.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace Jatify.Reporter
{
    /// <summary>How bad the reporter thinks the problem is. The workspace may route severities to their own decks.</summary>
    public enum Severity { None, Low, High, Critical }

    /// <summary>The result of one SendReport call.</summary>
    public struct ReportResult
    {
        /// <summary>True when the report was created and every file was uploaded.</summary>
        public bool Ok;
        /// <summary>The created card's id (empty if the report was refused).</summary>
        public string CardId;
        /// <summary>What went wrong, in a form fit for a log line; empty on success.</summary>
        public string Error;
    }

    /// <summary>
    /// Put this on one object in your first scene (it survives scene loads) and fill in the server address and a report
    /// token. Call SendReport from your own UI, or add JatifyReportForm for a ready-made one.
    /// </summary>
    public class JatifyReporter : MonoBehaviour
    {
        public const int MaxContentChars = 10000;
        public const int MaxFiles = 5;
        public const int MaxFileBytes = 10 * 1024 * 1024;

        [Tooltip("Address of the tracker, e.g. http://10.0.0.20:8780 (no trailing path).")]
        public string serverUrl = "";

        [Tooltip("A report token from the workspace menu (top left) → Connections → Player reports from Unity. Its name becomes a tag on the reports.")]
        public string reportToken = "";

        [Tooltip("Seconds before a request is given up.")]
        public int timeoutSeconds = 30;

        [Tooltip("Keep this object (and its form) across scene loads.")]
        public bool keepAcrossScenes = true;

        /// <summary>True while a report is being sent.</summary>
        public bool IsSending { get; private set; }

        void Awake()
        {
            if (keepAcrossScenes) DontDestroyOnLoad(gameObject);
        }

        /// <summary>
        /// Sends a report: the first line of <paramref name="content"/> is its title. <paramref name="email"/> (optional)
        /// lets the team tell the reporter when it is done. <paramref name="files"/> and <paramref name="fileNames"/> go
        /// together (at most 5 files of 10 MB each); pass null for none. <paramref name="onDone"/> runs on the main thread.
        /// </summary>
        public Coroutine SendReport(string content, Severity severity, string email, byte[][] files, string[] fileNames, Action<ReportResult> onDone = null)
        {
            return StartCoroutine(Send(content, severity, email, files, fileNames, onDone));
        }

        IEnumerator Send(string content, Severity severity, string email, byte[][] files, string[] fileNames, Action<ReportResult> onDone)
        {
            string problem = Check(content, files, fileNames);
            if (problem != null)
            {
                Finish(onDone, false, "", problem);
                yield break;
            }

            IsSending = true;
            // The token travels in a header, not the URL, so it stays out of proxy and access logs.
            string url = Join(serverUrl, "/user-report/v1/create-report");
            string body = ReportJson(content, severity, email, fileNames);
            CreateReportResponse created = null;
            using (var req = new UnityWebRequest(url, UnityWebRequest.kHttpVerbPOST))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.SetRequestHeader("X-Report-Token", reportToken.Trim());
                req.timeout = timeoutSeconds;
                yield return req.SendWebRequest();
                if (req.result != UnityWebRequest.Result.Success)
                {
                    Finish(onDone, false, "", Describe(req));
                    yield break;
                }
                try { created = JsonUtility.FromJson<CreateReportResponse>(req.downloadHandler.text); }
                catch (Exception e) { Finish(onDone, false, "", "Unreadable answer from the server: " + e.Message); yield break; }
            }
            if (created == null || !created.ok)
            {
                Finish(onDone, false, "", "The server did not accept the report.");
                yield break;
            }

            // The server answers with one upload URL per announced file, in the same order.
            var uploads = created.uploadUrls ?? new UploadUrl[0];
            string uploadError = "";
            for (int i = 0; i < uploads.Length && files != null && i < files.Length; i++)
            {
                using (var put = UnityWebRequest.Put(Join(serverUrl, uploads[i].url), files[i]))
                {
                    put.SetRequestHeader("Content-Type", MimeOf(fileNames[i]));
                    put.timeout = timeoutSeconds;
                    yield return put.SendWebRequest();
                    if (put.result != UnityWebRequest.Result.Success)
                        uploadError += (uploadError.Length > 0 ? "; " : "") + fileNames[i] + ": " + Describe(put);
                }
            }
            Finish(onDone, uploadError.Length == 0, created.cardId ?? "", uploadError);
        }

        void Finish(Action<ReportResult> onDone, bool ok, string cardId, string error)
        {
            IsSending = false;
            if (!ok) Debug.LogWarning("[Jatify Reporter] " + error);
            if (onDone != null) onDone(new ReportResult { Ok = ok, CardId = cardId, Error = error });
        }

        string Check(string content, byte[][] files, string[] fileNames)
        {
            if (string.IsNullOrEmpty(serverUrl) || string.IsNullOrEmpty(reportToken)) return "Set the server address and report token on the Jatify Reporter component.";
            if (string.IsNullOrEmpty(content) || content.Trim().Length == 0) return "The report is empty.";
            if (content.Length > MaxContentChars) return "The report is longer than " + MaxContentChars + " characters.";
            int count = files == null ? 0 : files.Length;
            if (count != (fileNames == null ? 0 : fileNames.Length)) return "files and fileNames must have the same length.";
            if (count > MaxFiles) return "At most " + MaxFiles + " files per report.";
            for (int i = 0; i < count; i++)
                if (files[i] == null || files[i].Length == 0 || files[i].Length > MaxFileBytes) return "File " + fileNames[i] + " is empty or larger than 10 MB.";
            return null;
        }

        static string ReportJson(string content, Severity severity, string email, string[] fileNames)
        {
            var sb = new StringBuilder("{\"content\":").Append(Quote(content));
            if (severity != Severity.None) sb.Append(",\"severity\":").Append(Quote(severity.ToString().ToLowerInvariant()));
            if (!string.IsNullOrEmpty(email)) sb.Append(",\"userEmail\":").Append(Quote(email.Trim()));
            if (fileNames != null && fileNames.Length > 0)
            {
                sb.Append(",\"fileNames\":[");
                for (int i = 0; i < fileNames.Length; i++) sb.Append(i > 0 ? "," : "").Append(Quote(fileNames[i] ?? "file"));
                sb.Append(']');
            }
            return sb.Append('}').ToString();
        }

        /// <summary>A JSON string literal (JsonUtility can't leave out optional fields, so the body is written by hand).</summary>
        static string Quote(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }

        static string Join(string server, string path)
        {
            if (path.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || path.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return path;
            return server.TrimEnd('/') + path;
        }

        static readonly Dictionary<string, string> Mimes = new Dictionary<string, string>
        {
            { ".png", "image/png" }, { ".jpg", "image/jpeg" }, { ".jpeg", "image/jpeg" }, { ".gif", "image/gif" },
            { ".webp", "image/webp" }, { ".txt", "text/plain" }, { ".log", "text/plain" }, { ".json", "application/json" },
        };

        static string MimeOf(string fileName)
        {
            int dot = fileName == null ? -1 : fileName.LastIndexOf('.');
            string mime;
            return dot >= 0 && Mimes.TryGetValue(fileName.Substring(dot).ToLowerInvariant(), out mime) ? mime : "application/octet-stream";
        }

        static string Describe(UnityWebRequest req)
        {
            string text = req.downloadHandler != null ? req.downloadHandler.text : "";
            return req.responseCode > 0 ? "HTTP " + req.responseCode + " " + text : req.error;
        }

        // Filled by JsonUtility.
#pragma warning disable 0649
        [Serializable]
        class UploadUrl
        {
            public string fileName;
            public string url;
        }

        [Serializable]
        class CreateReportResponse
        {
            public bool ok;
            public string cardId;
            public UploadUrl[] uploadUrls;
        }
#pragma warning restore 0649
    }
}
