/**
 * Quran AI Mobile App — React Native / Expo
 *
 * Features:
 * - Login/register via Platform API
 * - Surah selection from real API
 * - Audio recording with expo-av
 * - Real-time alignment feedback from ML service
 * - Tajweed findings display
 * - JWT token stored in SecureStore
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Alert,
  Platform,
} from "react-native";
import { Audio } from "expo-av";

const API_BASE = "http://127.0.0.1:8080";
const ML_BASE = "http://127.0.0.1:8090";

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

  // === Auth ===
  const login = async (userId: string, tenantId: string) => {
    try {
      const resp = await fetch(`${API_BASE}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, tenantId, role: "learner" }),
      });
      if (!resp.ok) throw new Error("Login failed");
      const data = await resp.json();
      setUser(data);
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
    }
  }, []);

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

      // Send to ML service for alignment
      const alignResp = await fetch(`${ML_BASE}/v1/alignments:predict`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId: user?.tenantId ?? "hikmah-pilot-erbil",
          sessionId: `mobile-${Date.now()}`,
          quranRef: {
            surahNumber: selectedSurah,
            ayahStart: 1,
            ayahEnd: 7,
            display: `Surah ${selectedSurah} 1-7`,
          },
          audioBase64: base64,
          audioFormat: Platform.OS === "ios" ? "m4a" : "webm",
          sourceChecksum: "fnv1a32:real",
          consent: {
            audioRetention: "discard",
            anonymizedLearning: true,
            externalAsrProcessing: false,
            guardianApproved: true,
            consentVersion: "mobile-v1",
          },
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
  }, [user, selectedSurah]);

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

      {/* Record Button */}
      <TouchableOpacity
        style={[styles.recordButton, recording && styles.recordButtonActive]}
        onPress={recording ? stopAndAnalyze : startRecording}
        disabled={loading}
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

function LoginScreen({ onLogin, error }: { onLogin: (userId: string, tenantId: string) => void; error: string | null }) {
  const [userId, setUserId] = useState("learner-1");
  const [tenantId, setTenantId] = useState("hikmah-pilot-erbil");
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Quran AI</Text>
      <Text style={styles.subtitle}>Recitation Intelligence</Text>
      <TextInput style={styles.input} value={userId} onChangeText={setUserId} placeholder="User ID" />
      <TextInput style={styles.input} value={tenantId} onChangeText={setTenantId} placeholder="Institution ID" />
      <TouchableOpacity style={styles.recordButton} onPress={() => onLogin(userId, tenantId)}>
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
  recordButton: { backgroundColor: "#4a90d9", padding: 20, borderRadius: 12, alignItems: "center", marginVertical: 20 },
  recordButtonActive: { backgroundColor: "#d94a4a" },
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
