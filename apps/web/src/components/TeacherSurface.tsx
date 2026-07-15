import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { 
  Play, 
  Pause, 
  Check, 
  X, 
  Edit3, 
  ListTodo, 
  Calendar, 
  Clock, 
  User, 
  AlertCircle 
} from "lucide-react";
import { 
  fetchRecitationSessions, 
  fetchSessionAlignments, 
  fetchTajweedFindings, 
  submitTeacherReview, 
  type RecitationSessionSummary, 
  type SessionAlignment, 
  type TajweedFindingSummary 
} from "../data/platform";
const API_BASE = import.meta.env.VITE_PLATFORM_API_URL || (import.meta.env.DEV ? "http://127.0.0.1:8080" : "");

interface TeacherSurfaceProps {
  tenantId: string;
  authToken?: string;
}

export function TeacherSurface({ tenantId, authToken }: TeacherSurfaceProps) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<RecitationSessionSummary[]>([]);
  const [findings, setFindings] = useState<TajweedFindingSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<RecitationSessionSummary | null>(null);
  const [alignments, setAlignments] = useState<SessionAlignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingAlignments, setLoadingAlignments] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Load the pending queue and general findings
  const loadQueue = async () => {
    setLoading(true);
    try {
      const [allSessions, allFindings] = await Promise.all([
        fetchRecitationSessions(tenantId, authToken),
        fetchTajweedFindings(tenantId, authToken)
      ]);
      // Filter for sessions that require teacher review
      const pending = allSessions.filter(
        (s) => s.reviewStatus === "teacher-review-required"
      );
      setSessions(pending);
      setFindings(allFindings);
    } catch (err) {
      console.error("Failed to load queue:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadQueue();
  }, [tenantId, authToken]);

  // Load alignments when selected session changes
  useEffect(() => {
    if (!selectedSession) {
      setAlignments([]);
      return;
    }

    setLoadingAlignments(true);
    fetchSessionAlignments(tenantId, selectedSession.id, authToken)
      .then(setAlignments)
      .catch((err) => console.error("Failed to fetch alignments:", err))
      .finally(() => setLoadingAlignments(false));
  }, [selectedSession, tenantId, authToken]);

  // Fetch audio blob with credentials and create object URL
  useEffect(() => {
    if (!selectedSession) {
      setAudioUrl(null);
      return;
    }

    setLoadingAudio(true);
    setAudioUrl(null);
    setIsPlaying(false);

    const headers: Record<string, string> = {
      "X-Tenant-Id": tenantId,
      "X-User-Id": "teacher-1",
      "X-User-Role": "teacher",
    };
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    let active = true;
    let localUrl: string | null = null;

    fetch(`${API_BASE}/v1/recitation-sessions/${selectedSession.id}/audio`, { headers })
      .then((res) => {
        if (!res.ok) throw new Error("Audio download failed");
        return res.blob();
      })
      .then((blob) => {
        if (!active) return;
        localUrl = URL.createObjectURL(blob);
        setAudioUrl(localUrl);
      })
      .catch((err) => {
        console.error("Failed to fetch recitation audio:", err);
      })
      .finally(() => {
        if (active) setLoadingAudio(false);
      });

    return () => {
      active = false;
      if (localUrl) {
        URL.revokeObjectURL(localUrl);
      }
    };
  }, [selectedSession, tenantId, authToken]);

  // Audio Playback helpers
  useEffect(() => {
    if (!audioUrl) {
      setAudioElement(null);
      return;
    }
    const audio = new Audio(audioUrl);
    audio.addEventListener("ended", () => setIsPlaying(false));
    setAudioElement(audio);

    return () => {
      audio.pause();
      audio.removeEventListener("ended", () => setIsPlaying(false));
    };
  }, [audioUrl]);

  const togglePlayback = () => {
    if (!audioElement) return;
    if (isPlaying) {
      audioElement.pause();
      setIsPlaying(false);
    } else {
      audioElement.play().catch(console.error);
      setIsPlaying(true);
    }
  };

  // Find findings matching word alignments of this session
  const sessionFindings = findings.filter((finding) =>
    alignments.some((align) => align.wordId === finding.wordId)
  );

  const handleReview = async (findingId: string, decision: "accepted" | "rejected" | "edited") => {
    setMessage(null);
    setSubmitting(true);
    try {
      const ok = await submitTeacherReview(
        tenantId,
        {
          findingId,
          teacherId: "teacher-1",
          decision,
          note: reviewNote.trim() || `Reviewed: ${decision}`,
        },
        authToken
      );

      if (ok) {
        setMessage({ type: "success", text: "Review submitted successfully!" });
        setReviewNote("");
        // Reload queue to update status
        await loadQueue();
        // Clear selected session if it has no more pending findings
        setSelectedSession(null);
      } else {
        setMessage({ type: "error", text: "Failed to submit review. Please try again." });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to submit review." });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="teacher-surface" style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: "24px", padding: "24px", minHeight: "calc(100vh - 120px)" }}>
      {/* Sidebar Queue */}
      <aside style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
        <h2 style={{ fontSize: "1.2rem", fontWeight: 600, display: "flex", alignItems: "center", gap: "8px", margin: 0 }}>
          <ListTodo size={20} />
          Teacher Queue
        </h2>
        
        {loading ? (
          <p style={{ color: "var(--text-quiet)", textAlign: "center", padding: "20px 0" }}>Loading queue...</p>
        ) : sessions.length === 0 ? (
          <p style={{ color: "var(--text-quiet)", textAlign: "center", padding: "20px 0" }}>No pending recitations.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", overflowY: "auto", maxHeight: "600px" }}>
            {sessions.map((session) => (
              <button
                key={session.id}
                data-session-id={session.id}
                onClick={() => setSelectedSession(session)}
                style={{
                  width: "100%",
                  padding: "12px",
                  textAlign: "left",
                  background: selectedSession?.id === session.id ? "var(--bg-accent, rgba(255, 255, 255, 0.05))" : "transparent",
                  border: "1px solid",
                  borderColor: selectedSession?.id === session.id ? "var(--border-accent, var(--text))" : "var(--line)",
                  borderRadius: "8px",
                  cursor: "pointer",
                  color: "var(--text)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px"
                }}
              >
                <strong style={{ fontSize: "0.95rem" }}>{session.quranRef.display}</strong>
                <div style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "0.8rem", color: "var(--text-quiet)" }}>
                  <User size={12} />
                  <span>{session.learnerId}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "0.8rem", color: "var(--text-quiet)" }}>
                  <Calendar size={12} />
                  <span>{new Date(session.startedAt).toLocaleDateString()}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </aside>

      {/* Main Review Area */}
      <main style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", padding: "24px" }}>
        {selectedSession ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
            <header style={{ borderBottom: "1px solid var(--line)", paddingBottom: "16px" }}>
              <h1 style={{ margin: "0 0 8px 0", fontSize: "1.6rem" }}>{selectedSession.quranRef.display}</h1>
              <div style={{ display: "flex", gap: "16px", color: "var(--text-quiet)", fontSize: "0.9rem" }}>
                <span>Learner: <strong>{selectedSession.learnerId}</strong></span>
                <span>•</span>
                <span>Accuracy Score: <strong>{Math.round(selectedSession.confidence * 100)}%</strong></span>
              </div>
            </header>

            {/* Audio Section */}
            <section style={{ background: "var(--bg-card-secondary, rgba(255, 255, 255, 0.02))", border: "1px solid var(--line)", borderRadius: "8px", padding: "16px", display: "flex", alignItems: "center", gap: "16px" }}>
              {loadingAudio ? (
                <span style={{ color: "var(--text-quiet)" }}>Downloading recitation audio...</span>
              ) : audioUrl ? (
                <>
                  <button
                    onClick={togglePlayback}
                    style={{
                      width: "48px",
                      height: "48px",
                      borderRadius: "50%",
                      background: "var(--text)",
                      color: "var(--bg)",
                      border: "none",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer"
                    }}
                  >
                    {isPlaying ? <Pause size={20} /> : <Play size={20} style={{ marginLeft: "2px" }} />}
                  </button>
                  <div>
                    <strong style={{ display: "block" }}>Listen to Recitation</strong>
                    <span style={{ fontSize: "0.85rem", color: "var(--text-quiet)" }}>Review pronunciation and flow before deciding.</span>
                  </div>
                </>
              ) : (
                <span style={{ color: "var(--text-quiet)", display: "flex", alignItems: "center", gap: "6px" }}>
                  <AlertCircle size={16} />
                  No audio available for this session.
                </span>
              )}
            </section>

            {/* Alignments / Transcription words */}
            <section>
              <h3 style={{ margin: "0 0 12px 0", fontSize: "1.1rem" }}>Learner Transcription Alignments</h3>
              {loadingAlignments ? (
                <p style={{ color: "var(--text-quiet)" }}>Loading words...</p>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", padding: "16px", border: "1px solid var(--line)", borderRadius: "8px", background: "var(--bg)" }}>
                  {alignments.map((align, index) => {
                    const hasFinding = sessionFindings.some(f => f.wordId === align.wordId);
                    return (
                      <div
                        key={index}
                        style={{
                          padding: "8px 12px",
                          borderRadius: "6px",
                          background: hasFinding ? "rgba(239, 68, 68, 0.1)" : "rgba(255, 255, 255, 0.03)",
                          border: "1px solid",
                          borderColor: hasFinding ? "#ef4444" : "var(--line)",
                          textAlign: "center"
                        }}
                      >
                        <div style={{ fontSize: "1.2rem", fontWeight: "bold" }}>{align.canonicalText}</div>
                        <div style={{ fontSize: "0.8rem", color: "var(--text-quiet)" }}>Heard: {align.heardText || "—"}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Tajweed Findings requiring Teacher Review */}
            <section style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "1.1rem" }}>Tajweed and Alignment Findings</h3>
              
              {sessionFindings.length === 0 ? (
                <p style={{ color: "var(--text-quiet)" }}>No findings require review. You can safely accept the recitation.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  {sessionFindings.map((finding) => (
                    <div
                      key={finding.id}
                      style={{
                        border: "1px solid var(--line)",
                        borderRadius: "8px",
                        padding: "16px",
                        background: "rgba(255, 255, 255, 0.01)"
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "12px" }}>
                        <div>
                          <strong style={{ fontSize: "1.05rem", color: "#f59e0b" }}>{finding.rule} Rule</strong>
                          <span style={{ display: "block", fontSize: "0.85rem", color: "var(--text-quiet)" }}>Word Ref: {finding.wordId}</span>
                        </div>
                        <span style={{ fontSize: "0.8rem", padding: "4px 8px", borderRadius: "12px", background: "rgba(239, 68, 68, 0.1)", color: "#ef4444", alignSelf: "flex-start" }}>
                          Confidence: {Math.round(finding.confidence * 100)}%
                        </span>
                      </div>
                      
                      <p style={{ margin: "0 0 16px 0", color: "var(--text)" }}>{finding.explanation}</p>

                      {/* Review input */}
                      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <textarea
                          placeholder="Write correction feedback or notes (optional)..."
                          value={reviewNote}
                          onChange={(e) => setReviewNote(e.target.value)}
                          style={{
                            width: "100%",
                            minHeight: "80px",
                            padding: "10px",
                            background: "var(--bg)",
                            border: "1px solid var(--line)",
                            borderRadius: "6px",
                            color: "var(--text)",
                            resize: "vertical"
                          }}
                        />

                        {message && (
                          <div
                            style={{
                              padding: "10px 12px",
                              borderRadius: "6px",
                              background: message.type === "success" ? "rgba(16, 185, 129, 0.1)" : "rgba(239, 68, 68, 0.1)",
                              color: message.type === "success" ? "#10b981" : "#ef4444",
                              fontSize: "0.9rem"
                            }}
                          >
                            {message.text}
                          </div>
                        )}

                        <div style={{ display: "flex", gap: "10px" }}>
                          <button
                            disabled={submitting}
                            onClick={() => handleReview(finding.id, "accepted")}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              padding: "10px 18px",
                              background: "#10b981",
                              color: "#fff",
                              border: "none",
                              borderRadius: "6px",
                              cursor: "pointer",
                              fontWeight: 600
                            }}
                          >
                            <Check size={16} />
                            Accept Finding
                          </button>
                          <button
                            disabled={submitting}
                            onClick={() => handleReview(finding.id, "rejected")}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              padding: "10px 18px",
                              background: "#ef4444",
                              color: "#fff",
                              border: "none",
                              borderRadius: "6px",
                              cursor: "pointer",
                              fontWeight: 600
                            }}
                          >
                            <X size={16} />
                            Reject Finding
                          </button>
                          <button
                            disabled={submitting}
                            onClick={() => handleReview(finding.id, "edited")}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              padding: "10px 18px",
                              background: "#f59e0b",
                              color: "#fff",
                              border: "none",
                              borderRadius: "6px",
                              cursor: "pointer",
                              fontWeight: 600
                            }}
                          >
                            <Edit3 size={16} />
                            Correct / Edit
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-quiet)", gap: "12px", minHeight: "300px" }}>
            <ListTodo size={40} />
            <h3>Select a recitation from the queue to start review.</h3>
          </div>
        )}
      </main>
    </div>
  );
}
