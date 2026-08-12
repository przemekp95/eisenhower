type AppRuntimeConfig = {
  apiUrl?: string;
  aiApiUrl?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcRedirectUri?: string;
  oidcScopes?: string;
};

declare global {
  interface Window {
    __APP_CONFIG__?: AppRuntimeConfig;
  }
}

const browserRuntimeConfig: AppRuntimeConfig =
  typeof window === 'undefined' ? {} : (window.__APP_CONFIG__ ?? {});

export const runtimeConfig = {
  apiUrl: browserRuntimeConfig.apiUrl ?? process.env.VITE_API_URL ?? 'http://localhost:3001',
  aiApiUrl: browserRuntimeConfig.aiApiUrl ?? process.env.VITE_AI_API_URL ?? 'http://localhost:8000',
  oidcIssuer: browserRuntimeConfig.oidcIssuer ?? process.env.VITE_OIDC_ISSUER,
  oidcClientId: browserRuntimeConfig.oidcClientId ?? process.env.VITE_OIDC_CLIENT_ID,
  oidcRedirectUri: browserRuntimeConfig.oidcRedirectUri ?? process.env.VITE_OIDC_REDIRECT_URI,
  oidcScopes:
    browserRuntimeConfig.oidcScopes ??
    process.env.VITE_OIDC_SCOPES ??
    'openid profile email tasks:read tasks:write calendar:read calendar:write knowledge:read ai:analyze',
};
