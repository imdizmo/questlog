// A minimal in-game report form (IMGUI) for JatifyReporter. F8 opens and closes it (legacy Input Manager), or call
// Open()/Close() from your own code. A screenshot is taken just before the form opens and can be attached.
// Compile-checked against Unity 6 assemblies only; never run in Unity yet: see README.md.
using System.Collections;
using UnityEngine;

namespace Jatify.Reporter
{
    [RequireComponent(typeof(JatifyReporter))]
    public class JatifyReportForm : MonoBehaviour
    {
        [Tooltip("Key that opens and closes the form (needs the legacy Input Manager; otherwise call Open()).")]
        public KeyCode toggleKey = KeyCode.F8;

        [Tooltip("Pause the game (Time.timeScale = 0) while the form is open.")]
        public bool pauseWhileOpen = true;

        static readonly string[] SeverityLabels = { "None", "Low", "High", "Critical" };

        JatifyReporter reporter;
        bool open;
        string text = "";
        string email = "";
        int severity;
        bool attachScreenshot = true;
        byte[] screenshot;
        string status = "";
        float savedTimeScale = 1f;
        Rect window = new Rect(20, 20, 420, 380);

        public bool IsOpen { get { return open; } }

        void Awake()
        {
            reporter = GetComponent<JatifyReporter>();
        }

#if ENABLE_LEGACY_INPUT_MANAGER
        void Update()
        {
            if (Input.GetKeyDown(toggleKey))
            {
                if (open) Close();
                else Open();
            }
        }
#endif

        /// <summary>Takes a screenshot of the current frame, then shows the form.</summary>
        public void Open()
        {
            if (open) return;
            StartCoroutine(CaptureThenOpen());
        }

        public void Close()
        {
            if (!open) return;
            open = false;
            screenshot = null;
            if (pauseWhileOpen) Time.timeScale = savedTimeScale;
        }

        IEnumerator CaptureThenOpen()
        {
            yield return new WaitForEndOfFrame();
            var tex = ScreenCapture.CaptureScreenshotAsTexture();
            screenshot = tex.EncodeToPNG();
            Destroy(tex);
            if (screenshot != null && screenshot.Length > JatifyReporter.MaxFileBytes) screenshot = null;
            status = "";
            open = true;
            if (pauseWhileOpen)
            {
                savedTimeScale = Time.timeScale;
                Time.timeScale = 0f;
            }
        }

        void OnGUI()
        {
            if (!open) return;
            window = GUI.Window(GetInstanceID(), window, DrawWindow, "Send a report");
        }

        void DrawWindow(int id)
        {
            GUILayout.Label("What happened? The first line is the title.");
            text = GUILayout.TextArea(text, JatifyReporter.MaxContentChars, GUILayout.Height(140));
            GUILayout.Label("How bad is it?");
            severity = GUILayout.Toolbar(severity, SeverityLabels);
            GUILayout.Label("Your email (optional, to hear when it is fixed)");
            email = GUILayout.TextField(email, 254);
            GUI.enabled = screenshot != null;
            attachScreenshot = GUILayout.Toggle(attachScreenshot && screenshot != null, "Attach a screenshot");
            GUI.enabled = !reporter.IsSending;
            GUILayout.BeginHorizontal();
            if (GUILayout.Button(reporter.IsSending ? "Sending…" : "Send") && text.Trim().Length > 0) Send();
            if (GUILayout.Button("Close")) Close();
            GUILayout.EndHorizontal();
            GUI.enabled = true;
            if (status.Length > 0) GUILayout.Label(status);
            GUI.DragWindow();
        }

        void Send()
        {
            byte[][] files = null;
            string[] names = null;
            if (attachScreenshot && screenshot != null)
            {
                files = new[] { screenshot };
                names = new[] { "screenshot.png" };
            }
            status = "Sending…";
            reporter.SendReport(text, (Severity)severity, email, files, names, result =>
            {
                if (result.Ok)
                {
                    text = "";
                    status = "Thanks! Your report was sent.";
                }
                else
                {
                    status = "Couldn't send the report. Please try again later.";
                }
            });
        }
    }
}
