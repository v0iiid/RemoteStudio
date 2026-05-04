import fs from "fs";
import path from "path";

const projectRoot = process.cwd();

const parseEnvLine = (line: string) => {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const separatorIndex = trimmed.indexOf("=");

  if (separatorIndex === -1) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  let value = trimmed.slice(separatorIndex + 1).trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value };
};

const loadEnvFile = (filePath: string) => {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const fileContent = fs.readFileSync(filePath, "utf8");

  for (const line of fileContent.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);

    if (!parsed || process.env[parsed.key] !== undefined) {
      continue;
    }

    process.env[parsed.key] = parsed.value;
  }
};

loadEnvFile(path.join(projectRoot, ".env"));
loadEnvFile(path.join(projectRoot, ".env.local"));

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");
const trimSlashes = (value: string) => value.replace(/^\/+|\/+$/g, "");

const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseOrigins = (value: string | undefined, fallback: string[]) => {
  if (!value) {
    return fallback;
  }

  return value
    .split(",")
    .map((origin) => trimTrailingSlash(origin.trim()))
    .filter(Boolean);
};

const resolvePath = (value: string | undefined, fallback: string) =>
  path.resolve(projectRoot, value ?? fallback);

export const serverConfig = {
  host: process.env.HOST || "0.0.0.0",
  port: parseNumber(process.env.PORT, 8000),
  corsOrigins: parseOrigins(process.env.CORS_ORIGINS, [
    "https://localhost:3000",
  ]),
  sslKeyPath: resolvePath(process.env.SSL_KEY_PATH, "ssl/localhost+3-key.pem"),
  sslCertPath: resolvePath(process.env.SSL_CERT_PATH, "ssl/localhost+3.pem"),
  recordingsDir: resolvePath(process.env.RECORDINGS_DIR, "recordings"),
  uploadTempDir: resolvePath(
    process.env.RECORDING_UPLOAD_TEMP_DIR,
    "recordings/.tmp"
  ),
  storageProvider:
    process.env.STORAGE_PROVIDER === "s3" ? "s3" : "local",
  storageBucket: process.env.STORAGE_BUCKET || "",
  storageRegion: process.env.STORAGE_REGION || "auto",
  storageEndpoint: trimTrailingSlash(process.env.STORAGE_ENDPOINT || ""),
  storageAccessKeyId: process.env.STORAGE_ACCESS_KEY_ID || "",
  storageSecretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || "",
  storagePrefix: trimSlashes(process.env.STORAGE_PREFIX || "remotestudio"),
};
