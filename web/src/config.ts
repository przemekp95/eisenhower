type AppRuntimeConfig = {
  apiUrl?: string;
  aiApiUrl?: string;
};

declare global {
  interface Window {
    __APP_CONFIG__?: AppRuntimeConfig;
  }
}

const browserRuntimeConfig: AppRuntimeConfig =
  typeof window === 'undefined' ? {} : window.__APP_CONFIG__ ?? {};

export const runtimeConfig = {
  apiUrl: browserRuntimeConfig.apiUrl ?? process.env.VITE_API_URL ?? 'http://localhost:3001',
  aiApiUrl: browserRuntimeConfig.aiApiUrl ?? process.env.VITE_AI_API_URL ?? 'http://localhost:8000',
};
