'use client';

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import styles from "./page.module.css";

type SubmissionResult = {
  logs: string[];
  videoBase64?: string;
  mimeType?: string;
  googleDriveFileId?: string;
  googleDriveWebLink?: string;
  facebook?: ApiCallResult;
  instagram?: ApiCallResult;
  tiktok?: ApiCallResult;
  error?: string;
};

type ApiCallResult = {
  success: boolean;
  statusCode: number;
  body: unknown;
  message?: string;
};

type PlatformState = {
  enabled: boolean;
  accessToken: string;
  identifier: string;
  extraField?: string;
};

const defaultPlatformState = (): Record<string, PlatformState> => ({
  facebook: { enabled: false, accessToken: "", identifier: "", extraField: "" },
  instagram: { enabled: false, accessToken: "", identifier: "", extraField: "" },
  tiktok: { enabled: false, accessToken: "", identifier: "" },
});

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [videoTitle, setVideoTitle] = useState("");
  const [frameDuration, setFrameDuration] = useState(2);
  const [images, setImages] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [googleDriveToken, setGoogleDriveToken] = useState("");
  const [googleDriveFolderId, setGoogleDriveFolderId] = useState("");
  const [platforms, setPlatforms] = useState<Record<string, PlatformState>>(defaultPlatformState());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<SubmissionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [caption, setCaption] = useState("");

  useEffect(() => {
    const urls = images.map((image) => URL.createObjectURL(image));
    setPreviews(urls);
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [images]);

  const totalDuration = useMemo(() => images.length * frameDuration, [images.length, frameDuration]);

  const handleFileSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const fileList = event.currentTarget.files;
    if (!fileList) return;
    const nextFiles = Array.from(fileList);
    setImages((prev) => [...prev, ...nextFiles]);
    event.currentTarget.value = "";
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const clearAll = () => {
    setImages([]);
    setVideoUrl(null);
    setResult(null);
    setLogs([]);
  };

  const togglePlatform = (key: keyof ReturnType<typeof defaultPlatformState>) => {
    setPlatforms((prev) => ({
      ...prev,
      [key]: { ...prev[key], enabled: !prev[key].enabled },
    }));
  };

  const updatePlatformField = (
    key: keyof ReturnType<typeof defaultPlatformState>,
    field: keyof PlatformState,
    value: string | boolean,
  ) => {
    setPlatforms((prev) => ({
      ...prev,
      [key]: { ...prev[key], [field]: value },
    }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!prompt.trim()) {
      setError("Provide a workflow prompt so automation steps are contextualised.");
      return;
    }
    if (images.length === 0) {
      setError("Attach at least one image to build a video.");
      return;
    }

    setIsSubmitting(true);
    setLogs(["Preparing assets…"]);
    setError(null);
    setResult(null);
    setVideoUrl(null);

    try {
      const formData = new FormData();
      formData.append("prompt", prompt);
      formData.append("title", videoTitle || prompt.slice(0, 60));
      formData.append("caption", caption);
      formData.append("frameDuration", String(frameDuration));
      formData.append("googleDriveToken", googleDriveToken);
      formData.append("googleDriveFolderId", googleDriveFolderId);

      Object.entries(platforms).forEach(([key, platform]) => {
        formData.append(`${key}Enabled`, String(platform.enabled));
        formData.append(`${key}AccessToken`, platform.accessToken);
        formData.append(`${key}Identifier`, platform.identifier);
        if (platform.extraField !== undefined) {
          formData.append(`${key}ExtraField`, platform.extraField ?? "");
        }
      });

      images.forEach((file, index) => {
        formData.append(`image_${index.toString().padStart(3, "0")}`, file, file.name);
      });

      const response = await fetch("/api/workflow", {
        method: "POST",
        body: formData,
      });

      const body = (await response.json()) as SubmissionResult;
      setLogs(body.logs ?? []);
      setResult(body);

      if (!response.ok) {
        throw new Error(body.error || "Workflow failed");
      }

      if (body.videoBase64 && body.mimeType) {
        setVideoUrl(`data:${body.mimeType};base64,${body.videoBase64}`);
      }
    } catch (submissionError) {
      const message =
        submissionError instanceof Error ? submissionError.message : "Workflow failed unexpectedly.";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={styles.pageWrapper}>
      <main className={styles.main}>
        <header className={styles.header}>
          <h1>Multichannel Video Workflow Builder</h1>
          <p>
            Craft an automation prompt, drop in reference images, and blast the rendered video to Google
            Drive, Facebook, Instagram, and TikTok with a single run.
          </p>
        </header>

        <form className={styles.form} onSubmit={handleSubmit}>
          <section className={styles.section}>
            <h2>Workflow Prompt</h2>
            <label className={styles.label}>
              Describe the workflow objective
              <textarea
                className={styles.textarea}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Example: Generate a 30s teaser from product snapshots, focus on energetic pacing."
                required
              />
            </label>
            <div className={styles.grid}>
              <label className={styles.label}>
                Video title
                <input
                  className={styles.input}
                  value={videoTitle}
                  onChange={(event) => setVideoTitle(event.target.value)}
                  placeholder="Energy Burst Teaser"
                />
              </label>
              <label className={styles.label}>
                Caption for socials
                <input
                  className={styles.input}
                  value={caption}
                  onChange={(event) => setCaption(event.target.value)}
                  placeholder="New drop is live ⚡ Tell us your favourite scene."
                />
              </label>
              <label className={styles.label}>
                Seconds per frame
                <input
                  className={styles.input}
                  type="number"
                  min={1}
                  max={12}
                  value={frameDuration}
                  onChange={(event) => setFrameDuration(Number(event.target.value))}
                  required
                />
              </label>
              <div className={styles.label}>
                Total runtime
                <span className={styles.meta}>{totalDuration || 0} seconds</span>
              </div>
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2>Reference Frames</h2>
              <button type="button" className={styles.ghostButton} onClick={clearAll}>
                Clear all
              </button>
            </div>
            <label className={styles.dropzone}>
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileSelection}
                className={styles.fileInput}
              />
              <span>Click or drag images here. They will be stitched sequentially.</span>
            </label>
            {previews.length > 0 && (
              <ul className={styles.previewGrid}>
                {previews.map((url, index) => (
                  <li key={url} className={styles.previewItem}>
                    <Image
                      src={url}
                      alt={`Frame ${index + 1}`}
                      className={styles.previewImage}
                      width={320}
                      height={180}
                      unoptimized
                    />
                    <div className={styles.previewMeta}>
                      <span>#{index + 1}</span>
                      <button type="button" onClick={() => removeImage(index)}>
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={styles.section}>
            <h2>Google Drive Delivery</h2>
            <p className={styles.helpText}>
              Provide an OAuth access token with the <code>drive.file</code> scope. The video is uploaded
              into the folder you specify and shared as public for downstream posting.
            </p>
            <div className={styles.grid}>
              <label className={styles.label}>
                Access token
                <input
                  className={styles.input}
                  value={googleDriveToken}
                  onChange={(event) => setGoogleDriveToken(event.target.value)}
                  placeholder="ya29...."
                />
              </label>
              <label className={styles.label}>
                Folder ID (optional)
                <input
                  className={styles.input}
                  value={googleDriveFolderId}
                  onChange={(event) => setGoogleDriveFolderId(event.target.value)}
                  placeholder="1AbCXYZ123"
                />
              </label>
            </div>
          </section>

          <section className={styles.section}>
            <h2>Social Distribution</h2>
            <div className={styles.platforms}>
              <div className={styles.platformCard}>
                <div className={styles.platformHeader}>
                  <label className={styles.checkboxLabel}>
                    <input
                      type="checkbox"
                      checked={platforms.facebook.enabled}
                      onChange={() => togglePlatform("facebook")}
                    />
                    <span>Facebook Page</span>
                  </label>
                </div>
                {platforms.facebook.enabled && (
                  <div className={styles.platformFields}>
                    <label className={styles.label}>
                      Page access token
                      <input
                        className={styles.input}
                        value={platforms.facebook.accessToken}
                        onChange={(event) =>
                          updatePlatformField("facebook", "accessToken", event.target.value)
                        }
                        placeholder="EAAG..."
                        required={platforms.facebook.enabled}
                      />
                    </label>
                    <label className={styles.label}>
                      Page ID
                      <input
                        className={styles.input}
                        value={platforms.facebook.identifier}
                        onChange={(event) =>
                          updatePlatformField("facebook", "identifier", event.target.value)
                        }
                        placeholder="1234567890"
                        required={platforms.facebook.enabled}
                      />
                    </label>
                    <label className={styles.label}>
                      Call-to-action link (optional)
                      <input
                        className={styles.input}
                        value={platforms.facebook.extraField ?? ""}
                        onChange={(event) =>
                          updatePlatformField("facebook", "extraField", event.target.value)
                        }
                        placeholder="https://example.com"
                      />
                    </label>
                  </div>
                )}
              </div>

              <div className={styles.platformCard}>
                <div className={styles.platformHeader}>
                  <label className={styles.checkboxLabel}>
                    <input
                      type="checkbox"
                      checked={platforms.instagram.enabled}
                      onChange={() => togglePlatform("instagram")}
                    />
                    <span>Instagram Business</span>
                  </label>
                </div>
                {platforms.instagram.enabled && (
                  <div className={styles.platformFields}>
                    <label className={styles.label}>
                      Access token
                      <input
                        className={styles.input}
                        value={platforms.instagram.accessToken}
                        onChange={(event) =>
                          updatePlatformField("instagram", "accessToken", event.target.value)
                        }
                        placeholder="EAAG..."
                        required={platforms.instagram.enabled}
                      />
                    </label>
                    <label className={styles.label}>
                      Instagram business ID
                      <input
                        className={styles.input}
                        value={platforms.instagram.identifier}
                        onChange={(event) =>
                          updatePlatformField("instagram", "identifier", event.target.value)
                        }
                        placeholder="1784..."
                        required={platforms.instagram.enabled}
                      />
                    </label>
                    <label className={styles.label}>
                      Cover image URL (optional)
                      <input
                        className={styles.input}
                        value={platforms.instagram.extraField ?? ""}
                        onChange={(event) =>
                          updatePlatformField("instagram", "extraField", event.target.value)
                        }
                        placeholder="https://..."
                      />
                    </label>
                  </div>
                )}
              </div>

              <div className={styles.platformCard}>
                <div className={styles.platformHeader}>
                  <label className={styles.checkboxLabel}>
                    <input
                      type="checkbox"
                      checked={platforms.tiktok.enabled}
                      onChange={() => togglePlatform("tiktok")}
                    />
                    <span>TikTok Upload Kit</span>
                  </label>
                </div>
                {platforms.tiktok.enabled && (
                  <div className={styles.platformFields}>
                    <label className={styles.label}>
                      Access token
                      <input
                        className={styles.input}
                        value={platforms.tiktok.accessToken}
                        onChange={(event) =>
                          updatePlatformField("tiktok", "accessToken", event.target.value)
                        }
                        placeholder="act.123..."
                        required={platforms.tiktok.enabled}
                      />
                    </label>
                    <label className={styles.label}>
                      Upload session ID (optional)
                      <input
                        className={styles.input}
                        value={platforms.tiktok.identifier}
                        onChange={(event) =>
                          updatePlatformField("tiktok", "identifier", event.target.value)
                        }
                        placeholder="Provided by TikTok Open API"
                      />
                    </label>
                  </div>
                )}
              </div>
            </div>
          </section>

          <footer className={styles.footer}>
            <button className={styles.primary} type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Running workflow…" : "Generate & publish"}
            </button>
            {error && <span className={styles.error}>{error}</span>}
          </footer>
        </form>

        <section className={styles.section}>
          <h2>Activity Log</h2>
          {logs.length === 0 ? (
            <p className={styles.helpText}>Status updates will appear here after you launch the workflow.</p>
          ) : (
            <ul className={styles.logList}>
              {logs.map((line, index) => (
                <li key={`${line}-${index}`}>{line}</li>
              ))}
            </ul>
          )}
        </section>
        {videoUrl && (
          <section className={styles.section}>
            <h2>Rendered Video Preview</h2>
            <video className={styles.video} controls src={videoUrl} />
            {result?.googleDriveWebLink && (
              <div className={styles.metaRow}>
                <span>Google Drive file:</span>
                <a href={result.googleDriveWebLink} target="_blank" rel="noreferrer">
                  {result.googleDriveWebLink}
                </a>
              </div>
            )}
          </section>
        )}

        {result && (
          <section className={styles.section}>
            <h2>Integrations</h2>
            <div className={styles.platformResponses}>
              {["facebook", "instagram", "tiktok"].map((platformKey) => {
                const payload = result[platformKey as keyof SubmissionResult] as ApiCallResult | undefined;
                return (
                  <article key={platformKey} className={styles.platformResult}>
                    <h3>{platformKey.toUpperCase()}</h3>
                    {payload ? (
                      <>
                        <span
                          className={
                            payload.success ? styles.badgeSuccess : styles.badgeFailure
                          }
                        >
                          {payload.success ? "Success" : "Failed"}
                        </span>
                        <pre className={styles.codeBlock}>
                          {JSON.stringify(payload.body ?? payload, null, 2)}
                        </pre>
                      </>
                    ) : (
                      <p className={styles.helpText}>Posting skipped.</p>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
