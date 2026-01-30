import { NextResponse } from "next/server";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import sharp from "sharp";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const runtime = "nodejs";
export const maxDuration = 60;

type ApiCallResult = {
  success: boolean;
  statusCode: number;
  body: unknown;
  message?: string;
};

type GoogleDriveUpload = {
  success: boolean;
  fileId?: string;
  webLink?: string;
  statusCode: number;
  body: unknown;
};

export async function POST(request: Request) {
  const logs: string[] = [];
  const appendLog = (message: string) => {
    logs.push(`${new Date().toISOString()} - ${message}`);
  };

  let tempRoot: string | null = null;
  try {
    const formData = await request.formData();

    const prompt = stringValue(formData.get("prompt"));
    const title = stringValue(formData.get("title")) || prompt || "Generated Video";
    const caption = stringValue(formData.get("caption"));
    const frameDurationRaw = Number(stringValue(formData.get("frameDuration")) || 2);
    const frameDuration = Number.isFinite(frameDurationRaw) && frameDurationRaw > 0 ? frameDurationRaw : 2;

    if (!prompt) {
      return NextResponse.json({ error: "Prompt is required", logs }, { status: 400 });
    }

    const imageEntries = Array.from(formData.entries())
      .filter((entry): entry is [string, File] => entry[1] instanceof File && entry[0].startsWith("image_"))
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB));

    if (imageEntries.length === 0) {
      return NextResponse.json({ error: "At least one image is required", logs }, { status: 400 });
    }

    appendLog(`Received ${imageEntries.length} image(s), preparing frame pipeline.`);

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-"));
    const frameDir = path.join(tempRoot, "frames");
    await fs.mkdir(frameDir);

    const framePaths: string[] = [];

    for (let index = 0; index < imageEntries.length; index += 1) {
      const [, file] = imageEntries[index];
      const buffer = Buffer.from(await file.arrayBuffer());
      const pngBuffer = await sharp(buffer).png().toBuffer();
      const framePath = path.join(frameDir, `frame-${index.toString().padStart(3, "0")}.png`);
      await fs.writeFile(framePath, pngBuffer);
      framePaths.push(framePath);
    }

    appendLog("Frames normalised to PNG and stored in temporary workspace.");

    const outputVideoPath = path.join(tempRoot, `video-${crypto.randomUUID()}.mp4`);
    const inputPattern = path.join(frameDir, "frame-%03d.png");
    const frameRate = Math.max(0.1, Number((1 / frameDuration).toFixed(4)));

    appendLog("Invoking FFmpeg to stitch frames into a timeline.");

    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(inputPattern)
        .inputOptions(["-start_number", "0", "-framerate", String(frameRate)])
        .outputOptions([
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-vf",
          "scale='min(1920,iw)':-2,setsar=1",
          "-r",
          "30",
          "-movflags",
          "+faststart",
        ])
        .on("error", (error: Error) => reject(error))
        .on("end", () => resolve())
        .save(outputVideoPath);
    });

    appendLog("Video render complete.");

    const videoBuffer = await fs.readFile(outputVideoPath);
    const safeTitle = normaliseFileName(title);
    const fileName = `${safeTitle}.mp4`;

    const driveToken = stringValue(formData.get("googleDriveToken"));
    const driveFolderId = stringValue(formData.get("googleDriveFolderId"));
    let driveUpload: GoogleDriveUpload | undefined;

    if (driveToken) {
      appendLog("Uploading rendered video to Google Drive.");
      driveUpload = await uploadToGoogleDrive(videoBuffer, fileName, driveToken, driveFolderId);
      appendLog(
        driveUpload.success
          ? `Google Drive upload succeeded (fileId: ${driveUpload.fileId}).`
          : "Google Drive upload failed.",
      );
    } else {
      appendLog("Google Drive step skipped (no token provided).");
    }

    const facebookResult = await maybePostToFacebook(formData, videoBuffer, fileName, title, caption, appendLog);
    const instagramResult = await maybePostToInstagram(formData, driveUpload, title, caption, appendLog);
    const tiktokResult = await maybePostToTikTok(formData, driveUpload, title, caption, appendLog);

    appendLog("Workflow completed.");

    const responsePayload = {
      logs,
      videoBase64: videoBuffer.toString("base64"),
      mimeType: "video/mp4",
      googleDriveFileId: driveUpload?.fileId,
      googleDriveWebLink: driveUpload?.webLink,
      facebook: facebookResult,
      instagram: instagramResult,
      tiktok: tiktokResult,
    };

    return NextResponse.json(responsePayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    logs.push(`${new Date().toISOString()} - Error: ${message}`);
    return NextResponse.json({ error: message, logs }, { status: 500 });
  } finally {
    if (tempRoot) {
      try {
        await fs.rm(tempRoot, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }
  }
}

function stringValue(value: FormDataEntryValue | null): string {
  return value ? value.toString().trim() : "";
}

function normaliseFileName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `workflow-video-${Date.now()}`;
}

async function uploadToGoogleDrive(
  videoBuffer: Buffer,
  name: string,
  accessToken: string,
  folderId?: string,
): Promise<GoogleDriveUpload> {
  const metadata: Record<string, unknown> = {
    name,
    mimeType: "video/mp4",
  };

  if (folderId) {
    metadata.parents = [folderId];
  }

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", bufferToBlob(videoBuffer, "video/mp4"), name);

  const uploadResponse = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: form,
  });

  const uploadBody = await safeJson(uploadResponse);

  if (!uploadResponse.ok) {
    return {
      success: false,
      statusCode: uploadResponse.status,
      body: uploadBody,
    };
  }

  const uploadRecord = uploadBody as Record<string, unknown>;
  const fileId = uploadRecord?.id ? String(uploadRecord.id) : undefined;

  if (!fileId) {
    return {
      success: false,
      statusCode: uploadResponse.status,
      body: { upload: uploadBody, error: "Upload response missing file identifier." },
    };
  }
  const permissionResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        role: "reader",
        type: "anyone",
      }),
    },
  );

  const permissionBody = await safeJson(permissionResponse);
  const success = permissionResponse.ok;

  return {
    success,
    statusCode: uploadResponse.status,
    body: { upload: uploadBody, permission: permissionBody },
    fileId,
    webLink: `https://drive.google.com/uc?export=download&id=${fileId}`,
  };
}

async function maybePostToFacebook(
  formData: FormData,
  videoBuffer: Buffer,
  fileName: string,
  title: string,
  caption: string,
  appendLog: (message: string) => void,
): Promise<ApiCallResult | undefined> {
  const enabled = stringValue(formData.get("facebookEnabled")) === "true";
  if (!enabled) {
    appendLog("Facebook publishing skipped.");
    return undefined;
  }

  const token = stringValue(formData.get("facebookAccessToken"));
  const pageId = stringValue(formData.get("facebookIdentifier"));
  const link = stringValue(formData.get("facebookExtraField"));

  if (!token || !pageId) {
    appendLog("Facebook configuration incomplete (token and page ID required).");
    return {
      success: false,
      statusCode: 400,
      body: { error: "Missing page access token or page ID" },
    };
  }

  appendLog("Posting video to Facebook Page.");

  const form = new FormData();
  form.append("source", bufferToBlob(videoBuffer, "video/mp4"), fileName);
  form.append("title", title);
  form.append("description", caption || title);
  if (link) {
    form.append(
      "call_to_action",
      JSON.stringify({
        type: "LEARN_MORE",
        value: { link },
      }),
    );
  }

  const endpoint = new URL(`https://graph.facebook.com/v18.0/${pageId}/videos`);
  endpoint.searchParams.set("access_token", token);

  const response = await fetch(endpoint, {
    method: "POST",
    body: form,
  });

  const body = await safeJson(response);

  appendLog(response.ok ? "Facebook publishing succeeded." : "Facebook publishing failed.");

  return {
    success: response.ok,
    statusCode: response.status,
    body,
  };
}

async function maybePostToInstagram(
  formData: FormData,
  driveUpload: GoogleDriveUpload | undefined,
  title: string,
  caption: string,
  appendLog: (message: string) => void,
): Promise<ApiCallResult | undefined> {
  const enabled = stringValue(formData.get("instagramEnabled")) === "true";
  if (!enabled) {
    appendLog("Instagram publishing skipped.");
    return undefined;
  }

  if (!driveUpload?.webLink) {
    appendLog("Instagram requires a public video URL. Google Drive upload must succeed first.");
    return {
      success: false,
      statusCode: 400,
      body: { error: "Missing public video URL" },
    };
  }

  const token = stringValue(formData.get("instagramAccessToken"));
  const igUserId = stringValue(formData.get("instagramIdentifier"));
  const coverUrl = stringValue(formData.get("instagramExtraField"));

  if (!token || !igUserId) {
    appendLog("Instagram configuration incomplete (access token and IG user ID required).");
    return {
      success: false,
      statusCode: 400,
      body: { error: "Missing access token or Instagram user ID" },
    };
  }

  appendLog("Creating Instagram media container.");

  const mediaEndpoint = new URL(`https://graph.facebook.com/v18.0/${igUserId}/media`);
  mediaEndpoint.searchParams.set("access_token", token);
  mediaEndpoint.searchParams.set("caption", caption || title);
  mediaEndpoint.searchParams.set("media_type", "VIDEO");
  mediaEndpoint.searchParams.set("video_url", driveUpload.webLink);
  if (coverUrl) {
    mediaEndpoint.searchParams.set("cover_url", coverUrl);
  }

  const containerResponse = await fetch(mediaEndpoint, { method: "POST" });
  const containerBody = await safeJson(containerResponse);

  if (!containerResponse.ok) {
    appendLog("Instagram container creation failed.");
    return {
      success: false,
      statusCode: containerResponse.status,
      body: containerBody,
    };
  }

  const containerRecord = containerBody as Record<string, unknown>;
  const creationIdValue = containerRecord?.id;

  if (!creationIdValue) {
    appendLog("Instagram container response missing creation ID.");
    return {
      success: false,
      statusCode: containerResponse.status,
      body: containerBody,
      message: "Missing Instagram creation ID.",
    };
  }

  const creationId = String(creationIdValue);
  appendLog("Publishing Instagram media container.");

  const publishResponse = await fetch(`https://graph.facebook.com/v18.0/${igUserId}/media_publish`, {
    method: "POST",
    body: new URLSearchParams({
      access_token: token,
      creation_id: creationId,
    }),
  });

  const publishBody = await safeJson(publishResponse);

  appendLog(publishResponse.ok ? "Instagram publishing succeeded." : "Instagram publishing failed.");

  return {
    success: publishResponse.ok,
    statusCode: publishResponse.status,
    body: {
      container: containerBody,
      publish: publishBody,
    },
  };
}

async function maybePostToTikTok(
  formData: FormData,
  driveUpload: GoogleDriveUpload | undefined,
  title: string,
  caption: string,
  appendLog: (message: string) => void,
): Promise<ApiCallResult | undefined> {
  const enabled = stringValue(formData.get("tiktokEnabled")) === "true";
  if (!enabled) {
    appendLog("TikTok publishing skipped.");
    return undefined;
  }

  if (!driveUpload?.webLink) {
    appendLog("TikTok requires a public video URL. Google Drive upload must succeed first.");
    return {
      success: false,
      statusCode: 400,
      body: { error: "Missing public video URL" },
    };
  }

  const token = stringValue(formData.get("tiktokAccessToken"));
  const uploadId = stringValue(formData.get("tiktokIdentifier"));

  if (!token) {
    appendLog("TikTok configuration incomplete (access token required).");
    return {
      success: false,
      statusCode: 400,
      body: { error: "Missing TikTok access token" },
    };
  }

  const requestBody: Record<string, unknown> = {
    video_url: driveUpload.webLink,
    text: caption || title,
  };

  if (uploadId) {
    requestBody.upload_id = uploadId;
  }

  appendLog("Calling TikTok upload API.");

  const response = await fetch("https://open.tiktokapis.com/v2/video/upload/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const body = await safeJson(response);

  appendLog(response.ok ? "TikTok upload request accepted." : "TikTok upload failed.");

  return {
    success: response.ok,
    statusCode: response.status,
    body,
  };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    return { error: "Failed to parse response body", detail: String(error) };
  }
}

function bufferToBlob(buffer: Buffer, type: string): Blob {
  const view = new Uint8Array(buffer);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return new Blob([copy.buffer], { type });
}
