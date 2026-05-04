import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { serverConfig } from "./config.js";

type StorageProvider = "local" | "s3";

export interface StoredRecordingObject {
  provider: StorageProvider;
  objectKey: string;
  filePath?: string;
}

const hashSha256Hex = (value: crypto.BinaryLike) =>
  crypto.createHash("sha256").update(value).digest("hex");

const hmacSha256 = (key: crypto.BinaryLike, value: string) =>
  crypto.createHmac("sha256", key).update(value).digest();

const encodeUriSegment = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );

const encodeObjectKey = (value: string) =>
  value
    .split("/")
    .map((segment) => encodeUriSegment(segment))
    .join("/");

const ensureCloudStorageConfig = () => {
  if (serverConfig.storageProvider !== "s3") {
    return;
  }

  if (
    !serverConfig.storageBucket ||
    !serverConfig.storageEndpoint ||
    !serverConfig.storageAccessKeyId ||
    !serverConfig.storageSecretAccessKey
  ) {
    throw new Error("S3_STORAGE_CONFIG_MISSING");
  }
};

const buildObjectKey = (roomId: string, fileName: string) =>
  [serverConfig.storagePrefix, roomId, fileName].filter(Boolean).join("/");

const hashFileSha256Hex = async (filePath: string) => {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }

  return hash.digest("hex");
};

const buildSignedS3Headers = ({
  method,
  objectKey,
  payloadHash,
  contentLength,
  contentType,
}: {
  method: "GET" | "PUT";
  objectKey: string;
  payloadHash: string;
  contentLength?: number;
  contentType?: string;
}) => {
  ensureCloudStorageConfig();

  const endpoint = new URL(serverConfig.storageEndpoint);
  const now = new Date();
  const isoValue = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const amzDate = `${isoValue.slice(0, 8)}T${isoValue.slice(8, 14)}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = `/${encodeUriSegment(
    serverConfig.storageBucket
  )}/${encodeObjectKey(objectKey)}`;
  const headers = new Map<string, string>();

  headers.set("host", endpoint.host);
  headers.set("x-amz-content-sha256", payloadHash);
  headers.set("x-amz-date", amzDate);

  if (contentLength !== undefined) {
    headers.set("content-length", contentLength.toString());
  }

  if (contentType) {
    headers.set("content-type", contentType);
  }

  const sortedHeaders = [...headers.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const canonicalHeaders = sortedHeaders
    .map(([key, value]) => `${key}:${value.trim()}\n`)
    .join("");
  const signedHeaders = sortedHeaders.map(([key]) => key).join(";");
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${serverConfig.storageRegion}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashSha256Hex(canonicalRequest),
  ].join("\n");
  const secret = `AWS4${serverConfig.storageSecretAccessKey}`;
  const signingKey = hmacSha256(
    hmacSha256(hmacSha256(hmacSha256(secret, dateStamp), serverConfig.storageRegion), "s3"),
    "aws4_request"
  );
  const signature = crypto
    .createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");

  headers.set(
    "authorization",
    [
      `AWS4-HMAC-SHA256 Credential=${serverConfig.storageAccessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`,
    ].join(", ")
  );

  const requestUrl = new URL(serverConfig.storageEndpoint);
  requestUrl.pathname = canonicalUri;

  return {
    url: requestUrl,
    headers: Object.fromEntries(headers.entries()),
  };
};

const putObjectToS3 = async ({
  objectKey,
  filePath,
  mimeType,
}: {
  objectKey: string;
  filePath: string;
  mimeType: string;
}) => {
  const fileStats = await fs.promises.stat(filePath);
  const payloadHash = await hashFileSha256Hex(filePath);
  const signedRequest = buildSignedS3Headers({
    method: "PUT",
    objectKey,
    payloadHash,
    contentLength: fileStats.size,
    contentType: mimeType,
  });

  const response = await fetch(signedRequest.url, {
    method: "PUT",
    headers: signedRequest.headers,
    body: fs.createReadStream(filePath) as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`S3_PUT_FAILED:${response.status}:${errorText}`);
  }
};

export const storeRecordingFile = async ({
  roomId,
  fileName,
  filePath,
  mimeType,
}: {
  roomId: string;
  fileName: string;
  filePath: string;
  mimeType: string;
}): Promise<StoredRecordingObject> => {
  if (serverConfig.storageProvider === "s3") {
    const objectKey = buildObjectKey(roomId, fileName);
    await putObjectToS3({ objectKey, filePath, mimeType });
    await fs.promises.rm(filePath, { force: true });

    return {
      provider: "s3",
      objectKey,
    };
  }

  const roomDirectory = path.join(serverConfig.recordingsDir, roomId);
  const destinationPath = path.join(roomDirectory, fileName);

  await fs.promises.mkdir(roomDirectory, { recursive: true });
  await fs.promises.rm(destinationPath, { force: true });
  await fs.promises.rename(filePath, destinationPath);

  return {
    provider: "local",
    objectKey: buildObjectKey(roomId, fileName),
    filePath: destinationPath,
  };
};

export const openStoredRecordingStream = async (
  recording: StoredRecordingObject
) => {
  if (recording.provider === "local") {
    if (!recording.filePath) {
      throw new Error("LOCAL_RECORDING_PATH_MISSING");
    }

    return fs.createReadStream(recording.filePath);
  }

  const signedRequest = buildSignedS3Headers({
    method: "GET",
    objectKey: recording.objectKey,
    payloadHash: hashSha256Hex(""),
  });
  const response = await fetch(signedRequest.url, {
    method: "GET",
    headers: signedRequest.headers,
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text();
    throw new Error(`S3_GET_FAILED:${response.status}:${errorText}`);
  }

  return Readable.fromWeb(response.body as never);
};
