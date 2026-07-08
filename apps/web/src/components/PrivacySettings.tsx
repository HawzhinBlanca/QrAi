import { useState } from "react";
import { Download, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { exportMyData, deleteMyData, type PrivacyJobResult } from "../lib/api";

/**
 * Learner-facing privacy self-service (P2.8): export or delete your own data and recordings from
 * the UI, without crafting an authenticated HTTP request by hand. Delete is gated behind an
 * explicit confirmation because it is irreversible.
 */
export function PrivacySettings({
  tenantId,
  userId,
  authToken,
}: {
  tenantId: string;
  userId: string;
  authToken?: string;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<"export" | "delete" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [exportResult, setExportResult] = useState<PrivacyJobResult | null>(null);
  const [deleteResult, setDeleteResult] = useState<PrivacyJobResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setBusy("export");
    setError(null);
    setExportResult(null);
    try {
      setExportResult(await exportMyData({ tenantId, userId, authToken }));
    } catch {
      setError(t("privacySettings.exportError"));
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    setBusy("delete");
    setError(null);
    setDeleteResult(null);
    try {
      const result = await deleteMyData({ tenantId, userId, authToken });
      setDeleteResult(result);
      setExportResult(null); // any prior holdings snapshot is now stale
    } catch {
      setError(t("privacySettings.deleteError"));
    } finally {
      setBusy(null);
      setConfirmingDelete(false);
    }
  }

  return (
    <section className="privacy-settings" aria-label={t("privacySettings.ariaLabel")}>
      <header className="privacy-settings-header">
        <ShieldCheck size={22} />
        <div>
          <h1>{t("privacySettings.title")}</h1>
          <p>{t("privacySettings.intro")}</p>
        </div>
      </header>

      {error && (
        <div className="state-banner warning" role="alert">
          {error}
        </div>
      )}

      <article className="privacy-card">
        <h2>{t("privacySettings.exportTitle")}</h2>
        <p>{t("privacySettings.exportBody")}</p>
        <button className="secondary-action" type="button" onClick={handleExport} disabled={busy !== null}>
          <Download size={16} />
          {busy === "export" ? t("privacySettings.exportBusy") : t("privacySettings.exportAction")}
        </button>
        {exportResult && (
          <p className="privacy-result" role="status">
            {t("privacySettings.exportResult", { count: exportResult.includedRecords.length })}
          </p>
        )}
      </article>

      <article className="privacy-card privacy-card-danger">
        <h2>{t("privacySettings.deleteTitle")}</h2>
        <p>{t("privacySettings.deleteBody")}</p>
        {!confirmingDelete ? (
          <button className="danger-action" type="button" onClick={() => setConfirmingDelete(true)} disabled={busy !== null}>
            <Trash2 size={16} />
            {t("privacySettings.deleteAction")}
          </button>
        ) : (
          <div className="privacy-confirm" role="group" aria-label={t("privacySettings.confirmAriaLabel")}>
            <p className="privacy-confirm-question">{t("privacySettings.confirmQuestion")}</p>
            <div className="privacy-confirm-actions">
              <button className="danger-action" type="button" onClick={handleDelete} disabled={busy !== null}>
                {busy === "delete" ? t("privacySettings.deleteBusy") : t("privacySettings.confirmDelete")}
              </button>
              <button className="secondary-action" type="button" onClick={() => setConfirmingDelete(false)} disabled={busy !== null}>
                {t("privacySettings.confirmCancel")}
              </button>
            </div>
          </div>
        )}
        {deleteResult && (
          <p className="privacy-result" role="status">
            {t("privacySettings.deleteResult", {
              records: deleteResult.deletedRecords.length,
              audio: deleteResult.audioObjectKeysDeleted.length,
            })}
          </p>
        )}
      </article>
    </section>
  );
}
