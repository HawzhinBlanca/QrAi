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
  readRecitationSessions,
  readSessionAlignments,
  fetchTajweedFindings, 
  fetchFindingAudio,
  submitTeacherReview, 
  type RecitationSessionSummary, 
  type SessionAlignment, 
  type TajweedFindingSummary 
} from "../data/platform";

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
  // P2.6 — "the queue is empty" and "the queue could not be loaded" are DIFFERENT things and used
  // to render identically. A failed load logged to the console and left `sessions` at [], so the
  // surface told a teacher "No pending recitations." while the service was unreachable. That is a
  // state reporting success on a failure: the teacher closes the tab believing there is no work.
  const [queueError, setQueueError] = useState(false);
  const [alignmentsError, setAlignmentsError] = useState(false);
  // Audio is per FINDING, not per session — see fetchFindingAudio for why. `playing` holds the id
  // of the finding currently sounding, so one player cannot be left running behind another.
  const [audioBusy, setAudioBusy] = useState<string | null>(null);
  const [audioProblem, setAudioProblem] = useState<{ findingId: string; kind: string } | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Load the pending queue and general findings
  const loadQueue = async () => {
    setLoading(true);
    setQueueError(false);
    try {
      // `readRecitationSessions`, not `fetchRecitationSessions`: the fetch variant returns its `[]`
      // fallback on any failure, so nothing was ever thrown and this function's `catch` could not
      // fire. The queue rendered "No pending recitations." while the service was unreachable.
      const [sessionRead, allFindings] = await Promise.all([
        readRecitationSessions(tenantId, authToken),
        fetchTajweedFindings(tenantId, authToken)
      ]);
      if (sessionRead.failed) {
        setQueueError(true);
        setSessions([]);
        return;
      }
      // Filter for sessions that require teacher review
      const pending = sessionRead.data.filter(
        (s) => s.reviewStatus === "teacher-review-required"
      );
      setSessions(pending);
      setFindings(allFindings);
    } catch (err) {
      console.error("Failed to load queue:", err);
      setQueueError(true);
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
    setAlignmentsError(false);
    readSessionAlignments(tenantId, selectedSession.id, authToken)
      .then((read) => {
        setAlignments(read.data);
        setAlignmentsError(read.failed);
      })
      .catch((err) => {
        console.error("Failed to fetch alignments:", err);
        setAlignments([]);
        setAlignmentsError(true);
      })
      .finally(() => setLoadingAlignments(false));
  }, [selectedSession, tenantId, authToken]);

  // ── Listening to a recitation ────────────────────────────────────────────────────────────────
  //
  // This used to fetch `/v1/recitation-sessions/{id}/audio` on every session selection. That is the
  // realtime GATEWAY's WebSocket path (its lib.rs:682), not a platform-api route — so against the
  // platform-api base, over plain HTTP, it 404'd every time and the catch rendered "No audio
  // available for this session". A teacher could not tell that from a learner having asked for
  // their recording to be destroyed, and the reviewing was done either way.
  //
  // Audio is now fetched PER FINDING, on demand, from the route that exists. That is not a
  // workaround for a missing session route: ADR-0037 writes an audit row for every attempt before
  // any bytes move, and re-checks retention against both the consent record and the stored object.
  // A session-level route would answer "who listened to this child's recitation" with one row
  // covering the whole recitation, which is weaker than what is already built.
  //
  // On demand, not on selection, for the same reason: opening a session to read the text should not
  // record that someone listened to the child.
  useEffect(() => {
    // Changing session stops whatever was sounding. Without this the previous learner's audio keeps
    // playing over the next learner's queue.
    audioElement?.pause();
    setAudioElement(null);
    setPlaying(null);
    setAudioProblem(null);
    // audioElement is deliberately not a dependency: including it re-runs this on every change it
    // makes, which tears down the element it just created.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSession]);

  useEffect(() => () => audioElement?.pause(), [audioElement]);

  const listen = async (finding: TajweedFindingSummary) => {
    if (playing === finding.id) {
      audioElement?.pause();
      setPlaying(null);
      return;
    }
    audioElement?.pause();
    setAudioBusy(finding.id);
    setAudioProblem(null);

    const result = await fetchFindingAudio(finding.id, tenantId, authToken);
    setAudioBusy(null);
    if (result.kind !== "audio") {
      setAudioProblem({ findingId: finding.id, kind: result.kind });
      return;
    }

    // The route returns base64 rather than bytes, so the browser gets an object URL built here. The
    // MIME type is deliberately generic: ml-inference stores whatever the gateway captured and this
    // client is not the place to assert a container it has not inspected.
    const bytes = Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/webm" }));
    const audio = new Audio(url);
    const done = () => {
      setPlaying(null);
      URL.revokeObjectURL(url);
    };
    audio.addEventListener("ended", done);
    audio.addEventListener("error", () => {
      done();
      setAudioProblem({ findingId: finding.id, kind: "unavailable" });
    });
    setAudioElement(audio);
    setPlaying(finding.id);
    audio.play().catch(() => {
      done();
      setAudioProblem({ findingId: finding.id, kind: "unavailable" });
    });
  };

  /**
   * What to say about a finding's audio BEFORE anyone asks for it.
   *
   * `audioStatus` comes from the server on every finding, so the honest label is available without
   * a request — and asking is itself an audited event, so offering a button that can only fail
   * would write "a teacher tried to listen" rows for recordings that were never captured.
   */
  const audioLabel = (finding: TajweedFindingSummary): { playable: boolean; text: string } => {
    const problem = audioProblem?.findingId === finding.id ? audioProblem.kind : null;
    const status = problem ?? finding.audioStatus ?? "unknown";
    switch (status) {
      case "available":
        return { playable: true, text: t("teacherSurface.listenToFinding") };
      case "discarded":
        return { playable: false, text: t("teacherSurface.audioDiscarded") };
      case "not-captured":
        return { playable: false, text: t("teacherSurface.audioNotCaptured") };
      default:
        return { playable: false, text: t("teacherSurface.audioUnavailable") };
    }
  };

  // Findings BELONGING to this session, by session id.
  //
  // This matched on `wordId` against the session's alignments. wordId is the canonical id
  // ("1:1:2"), identical for every learner reciting that passage, and `findings` is fetched
  // tenant-wide — so a teacher reviewing one learner saw other learners' findings listed under this
  // session, and `handleReview` submitted their accept/reject against that finding's id. The
  // decision landed on the wrong recitation, which is the one thing the review gate exists to get
  // right.
  const sessionFindings = selectedSession
    ? findings.filter((finding) => finding.sessionId === selectedSession.id)
    : [];

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
        setMessage({ type: "success", text: t("teacherSurface.reviewSuccess") });
        setReviewNote("");
        // Reload queue to update status
        await loadQueue();
        // Clear selected session if it has no more pending findings
        setSelectedSession(null);
      } else {
        setMessage({ type: "error", text: t("teacherSurface.reviewFailedRetry") });
      }
    } catch {
      setMessage({ type: "error", text: t("teacherSurface.reviewFailed") });
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
          {t("teacherSurface.queueTitle")}
        </h2>
        
        {loading ? (
          <p style={{ color: "var(--text-quiet)", textAlign: "center", padding: "20px 0" }}>{t("teacherSurface.loadingQueue")}</p>
        ) : queueError ? (
          // role="alert" and a real control. A message with no way forward is the same dead end as
          // no message, and this one has to out-rank the empty state: an unreachable service must
          // never be reported as "nothing to review".
          <div role="alert" style={{ textAlign: "center", padding: "20px 0" }}>
            <p style={{ color: "var(--text-quiet)" }}>{t("teacherSurface.queueUnavailable")}</p>
            <button type="button" onClick={loadQueue} style={{ marginTop: "8px" }}>
              {t("teacherSurface.queueRetry")}
            </button>
          </div>
        ) : sessions.length === 0 ? (
          <p style={{ color: "var(--text-quiet)", textAlign: "center", padding: "20px 0" }}>{t("teacherSurface.noPending")}</p>
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
                  textAlign: "start",
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
                <span>{t("teacherSurface.learnerLabel")}: <strong>{selectedSession.learnerId}</strong></span>
                <span>•</span>
                <span>{t("teacherSurface.accuracyLabel")}: <strong>{Math.round(selectedSession.confidence * 100)}%</strong></span>
              </div>
            </header>

            {/* Audio: per finding, below. This panel says WHY, because a reviewer who expects a
                session player and finds none should not have to guess. */}
            <section style={{ background: "var(--bg-card-secondary, rgba(255, 255, 255, 0.02))", border: "1px solid var(--line)", borderRadius: "8px", padding: "16px", display: "flex", alignItems: "center", gap: "10px" }}>
              <AlertCircle size={16} style={{ flexShrink: 0, color: "var(--text-quiet)" }} />
              <span style={{ color: "var(--text-quiet)", fontSize: "0.9rem" }}>{t("teacherSurface.audioPerFindingHint")}</span>
            </section>

            {/* Alignments / Transcription words */}
            <section>
              <h3 style={{ margin: "0 0 12px 0", fontSize: "1.1rem" }}>{t("teacherSurface.alignmentsTitle")}</h3>
              {loadingAlignments ? (
                <p style={{ color: "var(--text-quiet)" }}>{t("teacherSurface.loadingWords")}</p>
              ) : alignmentsError ? (
                // Same rule as the queue: an unreadable alignment must not render as a recitation
                // with no words in it, which reads as "the learner said nothing".
                <p role="alert" style={{ color: "var(--text-quiet)" }}>
                  {t("teacherSurface.alignmentsUnavailable")}
                </p>
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
                        <div style={{ fontSize: "0.8rem", color: "var(--text-quiet)" }}>{t("teacherSurface.heardLabel")}: {align.heardText || "—"}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Tajweed Findings requiring Teacher Review */}
            <section style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "1.1rem" }}>{t("teacherSurface.findingsTitle")}</h3>
              
              {sessionFindings.length === 0 ? (
                <p style={{ color: "var(--text-quiet)" }}>{t("teacherSurface.noFindings")}</p>
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
                          <strong style={{ fontSize: "1.05rem", color: "#f59e0b" }}>{t("teacherSurface.ruleLabel", { rule: finding.rule })}</strong>
                          <span style={{ display: "block", fontSize: "0.85rem", color: "var(--text-quiet)" }}>{t("teacherSurface.wordRef", { wordId: finding.wordId })}</span>
                        </div>
                        <span style={{ fontSize: "0.8rem", padding: "4px 8px", borderRadius: "12px", background: "rgba(239, 68, 68, 0.1)", color: "#ef4444", alignSelf: "flex-start" }}>
                          {t("teacherSurface.confidence", { percent: Math.round(finding.confidence * 100) })}
                        </span>
                      </div>
                      
                      <p style={{ margin: "0 0 16px 0", color: "var(--text)" }}>{finding.explanation}</p>

                      {/* Listen — the audited per-finding route. Disabled, with the REASON, when
                          the server has already told us there is nothing to hear. */}
                      {(() => {
                        const { playable, text } = audioLabel(finding);
                        const busy = audioBusy === finding.id;
                        const sounding = playing === finding.id;
                        return (
                          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
                            <button
                              type="button"
                              disabled={!playable || busy}
                              aria-label={text}
                              onClick={() => listen(finding)}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                padding: "8px 14px",
                                background: playable ? "var(--text)" : "transparent",
                                color: playable ? "var(--bg)" : "var(--text-quiet)",
                                border: playable ? "none" : "1px solid var(--line)",
                                borderRadius: "6px",
                                cursor: playable && !busy ? "pointer" : "default",
                                fontSize: "0.9rem"
                              }}
                            >
                              {sounding ? <Pause size={16} /> : <Play size={16} />}
                              {busy ? t("teacherSurface.downloadingAudio") : text}
                            </button>
                          </div>
                        );
                      })()}

                      {/* Review input */}
                      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <textarea
                          placeholder={t("teacherSurface.notePlaceholder")}
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
                            {t("teacherSurface.accept")}
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
                            {t("teacherSurface.reject")}
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
                            {t("teacherSurface.edit")}
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
            <h3>{t("teacherSurface.emptyState")}</h3>
          </div>
        )}
      </main>
    </div>
  );
}
