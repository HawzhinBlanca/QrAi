use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use serde::Serialize;
use sqlx::Row;

use crate::AppState;
use crate::types::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurahInfo {
    pub surah_number: i32,
    pub ayah_count: i32,
    pub name: String,
}

pub async fn list_surahs(
    State(state): State<AppState>,
    _headers: HeaderMap,
) -> Result<Json<Vec<SurahInfo>>, ApiError> {
    let rows = sqlx::query(
        "SELECT surah_number, COUNT(*) as ayah_count
         FROM canonical_ayahs
         GROUP BY surah_number
         ORDER BY surah_number",
    )
    .fetch_all(&state.pool)
    .await?;

    let surahs = rows
        .into_iter()
        .map(|r| SurahInfo {
            surah_number: r.try_get::<i32, _>("surah_number").unwrap_or(0),
            ayah_count: r
                .try_get::<i64, _>("ayah_count")
                .map(|c| c as i32)
                .unwrap_or(0),
            name: format!("Surah {}", r.try_get::<i32, _>("surah_number").unwrap_or(0)),
        })
        .collect();

    Ok(Json(surahs))
}

pub async fn get_surah(
    State(state): State<AppState>,
    _headers: HeaderMap,
    Path(surah_number): Path<i32>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, surah_number, ayah_number, text_uthmani, source_checksum
         FROM canonical_ayahs WHERE surah_number = $1 ORDER BY ayah_number",
    )
    .bind(surah_number)
    .fetch_all(&state.pool)
    .await?;

    if rows.is_empty() {
        return Err(ApiError::NotFound);
    }

    let ayahs: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "surahNumber": r.try_get::<i32, _>("surah_number").unwrap_or(0),
                "ayahNumber": r.try_get::<i32, _>("ayah_number").unwrap_or(0),
                "text": r.try_get::<String, _>("text_uthmani").unwrap_or_default(),
                "sourceChecksum": r.try_get::<String, _>("source_checksum").unwrap_or_default(),
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "surahNumber": surah_number,
        "ayahs": ayahs,
    })))
}

pub async fn get_ayah(
    State(state): State<AppState>,
    _headers: HeaderMap,
    Path((surah_number, ayah_number)): Path<(i32, i32)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let row = sqlx::query(
        "SELECT id, surah_number, ayah_number, text_uthmani, source_checksum
         FROM canonical_ayahs
         WHERE surah_number = $1 AND ayah_number = $2",
    )
    .bind(surah_number)
    .bind(ayah_number)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::NotFound)?;

    let ayah_id: String = row.try_get("id")?;

    let words = sqlx::query(
        "SELECT id, word_index, text_uthmani, source_checksum
         FROM canonical_words WHERE ayah_id = $1 ORDER BY word_index",
    )
    .bind(&ayah_id)
    .fetch_all(&state.pool)
    .await?;

    let words_json: Vec<serde_json::Value> = words
        .into_iter()
        .map(|w| {
            serde_json::json!({
                "id": w.try_get::<String, _>("id").unwrap_or_default(),
                "wordIndex": w.try_get::<i32, _>("word_index").unwrap_or(0),
                "text": w.try_get::<String, _>("text_uthmani").unwrap_or_default(),
                "sourceChecksum": w.try_get::<String, _>("source_checksum").unwrap_or_default(),
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "id": ayah_id,
        "surahNumber": row.try_get::<i32, _>("surah_number").unwrap_or(0),
        "ayahNumber": row.try_get::<i32, _>("ayah_number").unwrap_or(0),
        "text": row.try_get::<String, _>("text_uthmani").unwrap_or_default(),
        "sourceChecksum": row.try_get::<String, _>("source_checksum").unwrap_or_default(),
        "words": words_json,
    })))
}
