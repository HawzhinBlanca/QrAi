/**
 * Quran AI Mobile App — React Native / Expo
 *
 * Features:
 * - Login via Platform API (userId + institution + password)
 * - Surah selection from the real API
 * - Audio recording with expo-av, gated on explicit recording consent
 * - Recitation feedback via the platform API's authenticated ASR + ML proxies
 *   (the mobile client never talks to the ML/ASR services directly, so their keys stay server-side)
 * - Tajweed/alignment findings display
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Switch,
  Alert,
  Platform,
} from "react-native";
import { Audio } from "expo-av";

import {
  authHeaders as buildAuthHeaders,
  buildConsentPayload,
  canStartRecording,
  parseRecognizedText,
} from "./lib/session";

// The mobile client talks ONLY to the platform API. ML inference and ASR are reached server-side
// through the platform API's proxies, so their API keys never ship in the app.
//
// EXPO_PUBLIC_-prefixed vars are inlined by the Expo/Metro bundler at build time (no extra config
// needed, unlike react-native's own env story) — mirrors apps/web's VITE_PLATFORM_API_URL pattern.
// Without this override a physical device or a staging/prod build could only ever reach its own
// loopback interface, never the actual API host.
const API_BASE = process.env.EXPO_PUBLIC_PLATFORM_API_URL || "http://127.0.0.1:8080";

interface User {
  userId: string;
  tenantId: string;
  role: string;
  displayName: string;
  token: string;
}

interface Surah {
  surahNumber: number;
  name: string;
  ayahCount: number;
}

interface AlignmentResult {
  wordId: string;
  canonicalText: string;
  heardText: string;
  status: string;
  confidence: number;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [surahs, setSurahs] = useState<Surah[]>([]);
  const [selectedSurah, setSelectedSurah] = useState<number>(1);
  const [alignments, setAlignments] = useState<AlignmentResult[]>([]);
  const [recording, setRecording] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Explicit, affirmative consent — never assumed. Recording is blocked until recordingConsent is on,
  // and the consent sent to the backend reflects the learner's actual choices (no fabricated approval).
  const [recordingConsent, setRecordingConsent] = useState(false);
  const [guardianApproved, setGuardianApproved] = useState(false);
  // Guards startRecording against a double-tap: `recording` only flips true after several awaited
  // calls (a real mic permission prompt among them, which can take real wall-clock time), so a
  // second tap before that resolves would otherwise pass the `recording` check too, create a
  // second Audio.Recording, and overwrite globalThis.__recording — orphaning the first recording
  // (never stopped) and requesting mic permission twice. Set synchronously, before any await.
  const startingRecordingRef = useRef(false);

  // Actor auth headers for the platform API (Bearer once logged in). Pure logic in ./lib/session.
  const authHeaders = useCallback((): Record<string, string> => buildAuthHeaders(user), [user]);

  // === Auth ===
  const login = async (userId: string, tenantId: string, password: string) => {
    try {
      const resp = await fetch(`${API_BASE}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, tenantId, password }),
      });
      if (!resp.ok) throw new Error("Login failed");
      const data = await resp.json();
      setUser(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
    }
  };

  // === Load Surahs ===
  useEffect(() => {
    if (!user) return;
    fetch(`${API_BASE}/v1/quran/surahs`)
      .then((r) => r.json())
      .then(setSurahs)
      .catch(() => setError("Failed to load surahs"));
  }, [user]);

  // === Audio Recording ===
  const startRecording = useCallback(async () => {
    if (!canStartRecording(recordingConsent)) {
      Alert.alert(
        "Consent required",
        "Please consent to recording and analyzing your recitation before you begin.",
      );
      return;
    }
    // See startingRecordingRef's declaration comment: block re-entry synchronously, before the
    // mic-permission await, so a double-tap can't create a second Audio.Recording.
    if (startingRecordingRef.current) {
      return;
    }
    startingRecordingRef.current = true;
    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission denied", "Microphone access is required for recitation feedback.");
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      setRecording(true);
      // Store recording ref for stop
      (globalThis as any).__recording = rec;
    } catch (e) {
      setError("Recording failed to start");
    } finally {
      startingRecordingRef.current = false;
    }
  }, [recordingConsent]);

  const stopAndAnalyze = useCallback(async () => {
    const rec = (globalThis as any).__recording as Audio.Recording;
    if (!rec) return;
    setRecording(false);
    setLoading(true);
    setError(null);

    try {
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      if (!uri) throw new Error("No recording URI");

      // Read audio file as base64
      const response = await fetch(uri);
      const blob = await response.blob();
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve) => {
        reader.onloadend = () => {
          const result = reader.result as string;
          resolve(result.split(",")[1]);
        };
        reader.readAsDataURL(blob);
      });

      const audioFormat = Platform.OS === "ios" ? "m4a" : "webm";
      const headers = { "content-type": "application/json", ...authHeaders() };

      // 1) Transcribe via the platform API's ASR proxy (server-side ASR key; audio never hits ASR directly).
      const asrResp = await fetch(`${API_BASE}/v1/asr/transcribe`, {
        method: "POST",
        headers,
        body: JSON.stringify({ audioBase64: base64, audioFormat, language: "ar", wordTimestamps: true }),
      });
      if (!asrResp.ok) throw new Error(`ASR error: ${asrResp.status}`);
      const asr = await asrResp.json();
      const recognizedText = parseRecognizedText(asr.text);

      // 2) Align via the platform API's ML proxy (server-side ML key; tenant taken from the actor).
      const alignResp = await fetch(`${API_BASE}/v1/ml/alignments:predict`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          tenantId: user?.tenantId ?? "hikmah-pilot-erbil",
          sessionId: `mobile-${Date.now()}`,
          quranRef: {
            surahNumber: selectedSurah,
            ayahStart: 1,
            ayahEnd: 7,
            display: `Surah ${selectedSurah} 1-7`,
          },
          recognizedText,
          sourceChecksum: "fnv1a32:real",
          // Real consent — reflects the learner's toggles, not a hardcoded approval.
          consent: buildConsentPayload(recordingConsent, guardianApproved),
        }),
      });

      if (!alignResp.ok) throw new Error(`ML service error: ${alignResp.status}`);
      const result = await alignResp.json();
      setAlignments(result.alignments ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setLoading(false);
    }
  }, [user, selectedSurah, recordingConsent, guardianApproved, authHeaders]);

  // === Login Screen ===
  if (!user) {
    return <LoginScreen onLogin={login} error={error} />;
  }

  // === Main App ===
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Quran AI</Text>
      <Text style={styles.subtitle}>Recitation Intelligence</Text>

      {/* Surah Selector */}
      <View style={styles.section}>
        <Text style={styles.label}>Surah:</Text>
        <FlatList
          horizontal
          data={surahs.slice(0, 10)}
          keyExtractor={(item) => String(item.surahNumber)}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.surahChip, selectedSurah === item.surahNumber && styles.surahChipActive]}
              onPress={() => setSelectedSurah(item.surahNumber)}
            >
              <Text style={styles.surahChipText}>{item.name}</Text>
            </TouchableOpacity>
          )}
        />
      </View>

      {/* Consent — recording is blocked until the first toggle is on */}
      <View style={styles.section}>
        <View style={styles.consentRow}>
          <Switch value={recordingConsent} onValueChange={setRecordingConsent} />
          <Text style={styles.consentText}>I consent to recording and analyzing my recitation.</Text>
        </View>
        <View style={styles.consentRow}>
          <Switch value={guardianApproved} onValueChange={setGuardianApproved} />
          <Text style={styles.consentText}>A parent/guardian approves (required for learners under 13).</Text>
        </View>
      </View>

      {/* Record Button */}
      <TouchableOpacity
        style={[
          styles.recordButton,
          recording && styles.recordButtonActive,
          !recordingConsent && !recording && styles.recordButtonDisabled,
        ]}
        onPress={recording ? stopAndAnalyze : startRecording}
        disabled={loading || (!recording && !recordingConsent)}
      >
        <Text style={styles.recordButtonText}>
          {loading ? "Analyzing..." : recording ? "Stop & Analyze" : "Start Recitation"}
        </Text>
      </TouchableOpacity>

      {/* Error */}
      {error && <Text style={styles.error}>{error}</Text>}

      {/* Alignment Results */}
      {alignments.length > 0 && (
        <View style={styles.resultsSection}>
          <Text style={styles.resultsTitle}>Word-by-Word Feedback</Text>
          <FlatList
            data={alignments}
            keyExtractor={(item, i) => String(i)}
            renderItem={({ item }) => (
              <View style={[styles.wordCard, item.status !== "matched" && styles.wordCardError]}>
                <Text style={styles.wordArabic}>{item.canonicalText}</Text>
                <Text style={styles.wordStatus}>{item.status}</Text>
                <Text style={styles.wordConfidence}>{Math.round(item.confidence * 100)}%</Text>
              </View>
            )}
          />
        </View>
      )}
    </View>
  );
}

function LoginScreen({
  onLogin,
  error,
}: {
  onLogin: (userId: string, tenantId: string, password: string) => void;
  error: string | null;
}) {
  const [userId, setUserId] = useState("learner-1");
  const [tenantId, setTenantId] = useState("hikmah-pilot-erbil");
  const [password, setPassword] = useState("");
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Quran AI</Text>
      <Text style={styles.subtitle}>Recitation Intelligence</Text>
      <TextInput style={styles.input} value={userId} onChangeText={setUserId} placeholder="User ID" autoCapitalize="none" />
      <TextInput style={styles.input} value={tenantId} onChangeText={setTenantId} placeholder="Institution ID" autoCapitalize="none" />
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        secureTextEntry
        autoCapitalize="none"
      />
      <TouchableOpacity style={styles.recordButton} onPress={() => onLogin(userId, tenantId, password)}>
        <Text style={styles.recordButtonText}>Sign In</Text>
      </TouchableOpacity>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#1a1a2e", padding: 20, paddingTop: 60 },
  title: { fontSize: 32, fontWeight: "bold", color: "#e0e0e0", textAlign: "center" },
  subtitle: { fontSize: 16, color: "#888", textAlign: "center", marginBottom: 30 },
  section: { marginBottom: 20 },
  label: { color: "#aaa", fontSize: 14, marginBottom: 8 },
  surahChip: { padding: 10, backgroundColor: "#2a2a4e", borderRadius: 8, marginRight: 8 },
  surahChipActive: { backgroundColor: "#4a90d9" },
  surahChipText: { color: "#e0e0e0", fontSize: 14 },
  consentRow: { flexDirection: "row", alignItems: "center", marginBottom: 10 },
  consentText: { color: "#cfcfe0", fontSize: 13, flex: 1, marginLeft: 10 },
  recordButton: { backgroundColor: "#4a90d9", padding: 20, borderRadius: 12, alignItems: "center", marginVertical: 20 },
  recordButtonActive: { backgroundColor: "#d94a4a" },
  recordButtonDisabled: { backgroundColor: "#3a3a52", opacity: 0.6 },
  recordButtonText: { color: "#fff", fontSize: 18, fontWeight: "bold" },
  error: { color: "#ff6b6b", textAlign: "center", marginVertical: 10 },
  resultsSection: { flex: 1, marginTop: 10 },
  resultsTitle: { color: "#e0e0e0", fontSize: 18, fontWeight: "bold", marginBottom: 10 },
  wordCard: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "#2a2a4e", padding: 15, borderRadius: 8, marginBottom: 8 },
  wordCardError: { backgroundColor: "#4a2a2a" },
  wordArabic: { color: "#e0e0e0", fontSize: 20, flex: 1 },
  wordStatus: { color: "#aaa", fontSize: 12, textTransform: "capitalize" },
  wordConfidence: { color: "#4a90d9", fontSize: 14, fontWeight: "bold" },
  input: { backgroundColor: "#2a2a4e", color: "#e0e0e0", padding: 15, borderRadius: 8, marginBottom: 12, fontSize: 16 },
});
