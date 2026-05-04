const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");
const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const clientConfig = {
  apiBaseUrl: trimTrailingSlash(process.env.NEXT_PUBLIC_API_BASE_URL || ""),
  wsUrl: process.env.NEXT_PUBLIC_WS_URL || "",
  recordingChunkTimesliceMs: parseNumber(
    process.env.NEXT_PUBLIC_RECORDING_CHUNK_TIMESLICE_MS,
    1000
  ),
  recordingChunkRetryCount: parseNumber(
    process.env.NEXT_PUBLIC_RECORDING_CHUNK_RETRY_COUNT,
    5
  ),
  recordingChunkRetryBaseMs: parseNumber(
    process.env.NEXT_PUBLIC_RECORDING_CHUNK_RETRY_BASE_MS,
    1200
  ),
};

export const clientConfigReady = Boolean(
  clientConfig.apiBaseUrl && clientConfig.wsUrl
);
