// Questlog → Pull game data: downloads a campaign's wiki export into Assets/QuestlogData/ and stops there.
// Mapping the JSON into ScriptableObjects (or anything else) is the game's own code; see README.md for the format.
//
// The server URL, campaign id and token live in EditorPrefs (per user, per machine), never in an asset, so the
// token is not committed with the project.
using System.IO;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;

namespace Questlog.Data.Editor
{
    public class QuestlogPullGameData : EditorWindow
    {
        const string PrefServer = "Questlog.GameData.ServerUrl";
        const string PrefCampaign = "Questlog.GameData.CampaignId";
        const string PrefToken = "Questlog.GameData.Token";
        const string PrefPages = "Questlog.GameData.IncludePages";
        const string PrefStrict = "Questlog.GameData.Strict";
        const string TargetDir = "Assets/QuestlogData";

        string server;
        string campaign;
        string token;
        bool includePages;
        bool strict;
        string status = "";
        UnityWebRequest request;
        string tempPath;

        [MenuItem("Questlog/Pull game data")]
        static void Open()
        {
            GetWindow<QuestlogPullGameData>(true, "Questlog: Pull game data");
        }

        void OnEnable()
        {
            server = EditorPrefs.GetString(PrefServer, "http://localhost:8780");
            campaign = EditorPrefs.GetString(PrefCampaign, "");
            token = EditorPrefs.GetString(PrefToken, "");
            includePages = EditorPrefs.GetBool(PrefPages, false);
            strict = EditorPrefs.GetBool(PrefStrict, false);
        }

        void OnDisable()
        {
            Stop();
        }

        void OnGUI()
        {
            EditorGUI.BeginChangeCheck();
            server = EditorGUILayout.TextField(new GUIContent("Server URL", "The tracker's address, e.g. http://10.0.0.20:8780"), server);
            campaign = EditorGUILayout.TextField(new GUIContent("Campaign id", "From the Wiki's Export JSON link: /api/wiki/<campaign id>/export"), campaign);
            token = EditorGUILayout.PasswordField(new GUIContent("API token", "A read API token (gear menu → API tokens). Kept in EditorPrefs only."), token);
            includePages = EditorGUILayout.Toggle(new GUIContent("Include plain pages", "Also export untyped lore pages"), includePages);
            strict = EditorGUILayout.Toggle(new GUIContent("Strict", "Refuse the download while the wiki has failing checks"), strict);
            if (EditorGUI.EndChangeCheck())
            {
                EditorPrefs.SetString(PrefServer, server.Trim());
                EditorPrefs.SetString(PrefCampaign, campaign.Trim());
                EditorPrefs.SetString(PrefToken, token.Trim());
                EditorPrefs.SetBool(PrefPages, includePages);
                EditorPrefs.SetBool(PrefStrict, strict);
            }

            EditorGUILayout.Space();
            using (new EditorGUI.DisabledScope(request != null || string.IsNullOrEmpty(campaign.Trim()) || string.IsNullOrEmpty(token.Trim())))
            {
                if (GUILayout.Button(request != null ? "Downloading…" : "Pull game data")) Pull();
            }
            if (!string.IsNullOrEmpty(status)) EditorGUILayout.HelpBox(status, MessageType.None);
        }

        void Pull()
        {
            var url = server.Trim().TrimEnd('/') + "/api/wiki/" + UnityWebRequest.EscapeURL(campaign.Trim()) + "/export"
                + "?includePages=" + (includePages ? "1" : "0") + "&strict=" + (strict ? "1" : "0");
            // Streamed to the project's Temp folder, so a big export is never held in memory; moved into Assets on success.
            Directory.CreateDirectory("Temp");
            tempPath = Path.Combine("Temp", "questlog-gamedata.download");
            request = new UnityWebRequest(url, UnityWebRequest.kHttpVerbGET);
            request.downloadHandler = new DownloadHandlerFile(tempPath) { removeFileOnAbort = true };
            request.SetRequestHeader("Authorization", "Bearer " + token.Trim());
            // Never follow a redirect: it could carry the Authorization header to another host.
            request.redirectLimit = 0;
            request.SendWebRequest();
            status = "Downloading from " + server.Trim() + " …";
            EditorApplication.update += Poll;
        }

        void Poll()
        {
            if (request == null || !request.isDone) return;
            EditorApplication.update -= Poll;
            var code = request.responseCode;
            if (request.result == UnityWebRequest.Result.Success && code == 200)
            {
                var target = Path.Combine(TargetDir, FileName(request.GetResponseHeader("Content-Disposition")));
                request.Dispose();
                request = null;
                try
                {
                    Directory.CreateDirectory(TargetDir);
                    if (File.Exists(target)) File.Delete(target);
                    File.Move(tempPath, target);
                    AssetDatabase.Refresh();
                    status = "Saved " + target;
                    Debug.Log("[Questlog] " + status);
                }
                catch (IOException e) { Fail("Could not save " + target + ": " + e.Message); }
                catch (System.UnauthorizedAccessException e) { Fail("Could not save " + target + ": " + e.Message); }
            }
            else
            {
                // The error answers are small JSON bodies: {"error": "...", "checks": [...]} for a strict export.
                var body = File.Exists(tempPath) ? File.ReadAllText(tempPath) : "";
                status = code == 422 ? "Failing checks, nothing saved:\n" + body
                    : code == 401 ? "The token was refused (401)."
                    : code == 404 ? "No such campaign for this token (404)."
                    : "Download failed (" + (code > 0 ? code.ToString() : request.error) + ") " + body;
                Fail(status);
            }
            Repaint();
        }

        /// <summary>The server's file name (campaign key + "-gamedata.json"), or one from the campaign id.</summary>
        string FileName(string disposition)
        {
            var m = disposition != null ? Regex.Match(disposition, "filename=\"([^\"]+)\"") : Match.Empty;
            var name = m.Success ? Path.GetFileName(m.Groups[1].Value) : campaign.Trim() + "-gamedata.json";
            name = Regex.Replace(name, "[^A-Za-z0-9_.-]", "_");
            return name.EndsWith(".json") ? name : name + ".json";
        }

        void Fail(string message)
        {
            status = message;
            Debug.LogWarning("[Questlog] " + status);
            Stop();
        }

        void Stop()
        {
            EditorApplication.update -= Poll;
            if (request != null) { request.Dispose(); request = null; }
            if (tempPath != null && File.Exists(tempPath)) File.Delete(tempPath);
        }
    }
}
