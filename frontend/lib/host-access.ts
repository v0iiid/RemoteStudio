const storageKey = "remotestudio-host-access";

type HostAccessMap = Record<string, string>;

const readHostAccessMap = (): HostAccessMap => {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const storedValue = window.localStorage.getItem(storageKey);
    return storedValue ? (JSON.parse(storedValue) as HostAccessMap) : {};
  } catch (error) {
    console.error("failed to read host access", error);
    return {};
  }
};

const writeHostAccessMap = (value: HostAccessMap) => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(storageKey, JSON.stringify(value));
};

export const saveHostToken = (roomId: string, hostToken: string) => {
  const currentValue = readHostAccessMap();
  currentValue[roomId] = hostToken;
  writeHostAccessMap(currentValue);
};

export const getHostToken = (roomId: string) => readHostAccessMap()[roomId] || "";
