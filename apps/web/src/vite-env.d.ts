/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PLATFORM_API_URL?: string;
  readonly VITE_REALTIME_GATEWAY_URL?: string;
  readonly VITE_ASR_INFERENCE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "@fontsource-variable/inter";
declare module "@fontsource/amiri/400.css";
declare module "@fontsource/amiri/700.css";
